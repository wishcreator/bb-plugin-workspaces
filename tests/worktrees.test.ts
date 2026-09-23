import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hostContract } from "../src/host-contract";
import {
  addRepository,
  cleanupSession,
  ensureAnchor,
  prepareSession,
  readRepositoryBases,
  readRepositoryStatus,
  readSessionManifest,
  writeGhAccountMarker,
} from "../src/worktrees";
import { DEFAULT_BASE_REF } from "../src/contracts";

const roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function repository(name: string): { path: string; commit: string } {
  const root = mkdtempSync(join(tmpdir(), `bb-workspaces-${name}-`));
  roots.push(root);
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "workspaces@example.invalid");
  git(root, "config", "user.name", "Workspaces test");
  writeFileSync(join(root, "README.md"), `${name}\n`);
  git(root, "add", "README.md");
  git(root, "commit", "-m", "base");
  return { path: root, commit: git(root, "rev-parse", "HEAD") };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});


/** A clone whose origin has advanced past what the working copy has checked out. */
function clonedRepository(name: string): { path: string; originPath: string; defaultCommit: string; featureCommit: string } {
  const origin = repository(name);
  git(origin.path, "branch", "-M", "master");
  const clonePath = mkdtempSync(join(tmpdir(), `bb-workspaces-${name}-clone-`));
  roots.push(clonePath);
  execFileSync("git", ["clone", "--quiet", origin.path, clonePath], { encoding: "utf8" });
  git(clonePath, "config", "user.email", "workspaces@example.invalid");
  git(clonePath, "config", "user.name", "Workspaces test");
  git(clonePath, "checkout", "--quiet", "-b", "feature/work");
  writeFileSync(join(clonePath, "feature.md"), "feature\n");
  git(clonePath, "add", "feature.md");
  git(clonePath, "commit", "-m", "feature work");
  const featureCommit = git(clonePath, "rev-parse", "HEAD");
  writeFileSync(join(origin.path, "AFTER.md"), "later master work\n");
  git(origin.path, "add", "AFTER.md");
  git(origin.path, "commit", "-m", "master moved on");
  return { path: clonePath, originPath: origin.path, defaultCommit: git(origin.path, "rev-parse", "HEAD"), featureCommit };
}

describe("multi-repository session worktrees", () => {
  it("branches from the freshly fetched default branch and leaves the checkout alone", async () => {
    const clone = clonedRepository("default-base");
    const dataRoot = mkdtempSync(join(tmpdir(), "bb-workspaces-data-"));
    roots.push(dataRoot);
    const prepared = await prepareSession({
      dataRoot, sessionId: "session_default", workspaceName: "Platform", instructions: "",
      repositories: [{ projectId: "svc", alias: "svc", sourcePath: clone.path, baseRef: DEFAULT_BASE_REF }],
    });
    expect(prepared.repositories[0]).toMatchObject({ baseRef: "origin/master", baseCommit: clone.defaultCommit });
    expect(git(prepared.repositories[0]!.worktreePath, "rev-parse", "HEAD")).toBe(clone.defaultCommit);
    expect(git(clone.path, "symbolic-ref", "--short", "HEAD")).toBe("feature/work");
    expect(git(clone.path, "rev-parse", "HEAD")).toBe(clone.featureCommit);
  });

  it("branches from the current checkout when that base is chosen", async () => {
    const clone = clonedRepository("current-base");
    const dataRoot = mkdtempSync(join(tmpdir(), "bb-workspaces-data-"));
    roots.push(dataRoot);
    const prepared = await prepareSession({
      dataRoot, sessionId: "session_current", workspaceName: "Platform", instructions: "",
      repositories: [{ projectId: "svc", alias: "svc", sourcePath: clone.path, baseRef: "feature/work" }],
    });
    expect(prepared.repositories[0]).toMatchObject({ baseRef: "feature/work", baseCommit: clone.featureCommit });
  });

  it("reports the default branch, the current checkout, and candidate refs", async () => {
    const clone = clonedRepository("bases");
    const [bases] = await readRepositoryBases({ repositories: [{ projectId: "svc", sourcePath: clone.path }], fetch: true });
    expect(bases).toMatchObject({ projectId: "svc", defaultBase: "origin/master", currentBranch: "feature/work", fetchError: null });
    expect(bases!.refs).toContain("origin/master");
    expect(bases!.refs).toContain("feature/work");
    expect(bases!.refs.every((ref) => !ref.endsWith("/HEAD"))).toBe(true);
  });

  it("refuses a base ref that could act as a git flag", async () => {
    const clone = clonedRepository("unsafe-base");
    const dataRoot = mkdtempSync(join(tmpdir(), "bb-workspaces-data-"));
    roots.push(dataRoot);
    await expect(prepareSession({
      dataRoot, sessionId: "session_unsafe", workspaceName: "Platform", instructions: "",
      repositories: [{ projectId: "svc", alias: "svc", sourcePath: clone.path, baseRef: "--upload-pack=touch" }],
    })).rejects.toThrow();
  });


  it("preserves trusted initial instructions when expanding a v1 manifest", async () => {
    const auth = repository("legacy-auth");
    const audits = repository("legacy-audits");
    const dataRoot = mkdtempSync(join(tmpdir(), "bb-workspaces-data-"));
    roots.push(dataRoot);
    const prepared = await prepareSession({ dataRoot, sessionId: "session_v1", workspaceName: "Legacy", instructions: "Trusted original instructions.", repositories: [{ projectId: "auth", alias: "auth", sourcePath: auth.path, baseRef: "HEAD" }] });
    writeFileSync(join(prepared.rootPath, "session.json"), JSON.stringify({ schemaVersion: 1, sessionId: "session_v1", workspaceName: "Legacy", repositories: prepared.repositories }));
    await addRepository({ dataRoot, sessionId: "session_v1", operationKey: "legacy-expansion", instructions: "Trusted original instructions.", repository: { projectId: "audits", alias: "audits", sourcePath: audits.path, baseRef: "HEAD" } });
    expect(readFileSync(join(prepared.rootPath, "AGENTS.md"), "utf8")).toContain("Trusted original instructions.");
    expect(readSessionManifest(dataRoot, "session_v1").instructions).toBe("Trusted original instructions.");
  });

  it("accepts cleanup through the accumulated repository limit and refuses excess expansion before Git", async () => {
    const auth = repository("bounded-auth");
    const dataRoot = mkdtempSync(join(tmpdir(), "bb-workspaces-data-"));
    roots.push(dataRoot);
    const prepared = await prepareSession({ dataRoot, sessionId: "session_bound", workspaceName: "Bounded", instructions: "", repositories: [{ projectId: "auth", alias: "auth", sourcePath: auth.path, baseRef: "HEAD" }] });
    const repositories = Array.from({ length: 1024 }, (_, index) => ({ ...prepared.repositories[0]!, projectId: `project-${index}`, alias: `repo-${index}`, branch: `bb-workspace/session-bound/repo-${index}`, worktreePath: join(prepared.rootPath, `repos/repo-${index}`) }));
    expect(hostContract.cleanup_session.input.safeParse({ sessionId: "session_bound", repositories }).success).toBe(true);
    expect(hostContract.cleanup_session.input.safeParse({ sessionId: "session_bound", repositories: [...repositories, repositories[0]] }).success).toBe(false);
    writeFileSync(join(prepared.rootPath, "session.json"), JSON.stringify({ ...readSessionManifest(dataRoot, "session_bound"), repositories }));
    await expect(addRepository({ dataRoot, sessionId: "session_bound", operationKey: "too-many-repos", repository: { projectId: "extra", alias: "extra", sourcePath: "/missing/source", baseRef: "HEAD" } })).rejects.toThrow(/1024|limit/i);
  });
  it("creates and validates a stable non-Git workspace anchor", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "bb-workspaces-data-"));
    roots.push(dataRoot);

    const anchor = await ensureAnchor(dataRoot);

    expect(anchor.path).toBe(join(dataRoot, "workspace-anchor"));
    expect(JSON.parse(readFileSync(join(anchor.path, ".bb-workspaces-anchor.json"), "utf8"))).toEqual({
      schemaVersion: 1,
      owner: "bb-plugin-workspaces",
    });
    expect(existsSync(join(anchor.path, ".git"))).toBe(false);
    expect(await ensureAnchor(dataRoot)).toEqual(anchor);

    writeFileSync(join(anchor.path, ".bb-workspaces-anchor.json"), JSON.stringify({ schemaVersion: 1, owner: "other" }));
    await expect(ensureAnchor(dataRoot)).rejects.toThrow(/anchor/i);
    expect(existsSync(anchor.path)).toBe(true);
  });

  it("rejects symlinked owned-path components before reading or creating outside dataRoot", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "bb-workspaces-data-"));
    const outside = mkdtempSync(join(tmpdir(), "bb-workspaces-outside-"));
    roots.push(dataRoot, outside);
    symlinkSync(outside, join(dataRoot, "workspace-anchor"));

    await expect(ensureAnchor(dataRoot)).rejects.toThrow(/symlink/i);
    expect(existsSync(join(outside, ".bb-workspaces-anchor.json"))).toBe(false);

    mkdirSync(join(dataRoot, "sessions"));
    symlinkSync(outside, join(dataRoot, "sessions", "session_escape"));
    expect(() => readSessionManifest(dataRoot, "session_escape")).toThrow(/symlink/i);

    const guardedRoot = mkdtempSync(join(tmpdir(), "bb-workspaces-data-"));
    roots.push(guardedRoot);
    symlinkSync(outside, join(guardedRoot, "sessions"));
    const auth = repository("symlink-ancestor");
    await expect(prepareSession({
      dataRoot: guardedRoot, sessionId: "session_new", workspaceName: "Guarded", instructions: "",
      repositories: [{ projectId: "proj_auth", alias: "auth", sourcePath: auth.path, baseRef: auth.commit }],
    })).rejects.toThrow(/symlink/i);
    expect(existsSync(join(outside, "session_new"))).toBe(false);
  });

  it("creates isolated worktrees and a compact repository map", async () => {
    const auth = repository("auth");
    const gateway = repository("gateway");
    const dataRoot = mkdtempSync(join(tmpdir(), "bb-workspaces-data-"));
    roots.push(dataRoot);

    const result = await prepareSession({
      dataRoot,
      sessionId: "session_abc",
      workspaceName: "Authentication",
      instructions: "Run contract tests before finishing.",
      repositories: [
        { projectId: "proj_auth", alias: "auth", sourcePath: auth.path, baseRef: auth.commit },
        { projectId: "proj_gateway", alias: "gateway", sourcePath: gateway.path, baseRef: gateway.commit },
      ],
    });

    expect(readFileSync(join(result.rootPath, "repos/auth/README.md"), "utf8")).toBe("auth\n");
    expect(readFileSync(join(result.rootPath, "repos/gateway/README.md"), "utf8")).toBe("gateway\n");
    expect(readFileSync(join(result.rootPath, "AGENTS.md"), "utf8")).toContain("Run contract tests before finishing.");
    expect(readFileSync(join(result.rootPath, "AGENTS.md"), "utf8")).toContain("`repos/auth` → BB project `proj_auth`");
    expect(git(join(result.rootPath, "repos/auth"), "rev-parse", "HEAD")).toBe(auth.commit);
    expect(git(join(result.rootPath, "repos/gateway"), "rev-parse", "HEAD")).toBe(gateway.commit);
    expect(result.repositories.map((repo) => repo.branch)).toEqual([
      "bb-workspace/session-abc/auth",
      "bb-workspace/session-abc/gateway",
    ]);
    expect(readSessionManifest(dataRoot, "session_abc")).toMatchObject({
      schemaVersion: 2,
      owner: "bb-plugin-workspaces",
      revision: 1,
      operations: [],
      instructions: "Run contract tests before finishing.",
    });
  });

  it("upgrades a valid schema-v1 manifest in memory", async () => {
    const auth = repository("auth");
    const dataRoot = mkdtempSync(join(tmpdir(), "bb-workspaces-data-"));
    roots.push(dataRoot);
    const prepared = await prepareSession({
      dataRoot, sessionId: "session_legacy", workspaceName: "Legacy", instructions: "Keep focused.",
      repositories: [{ projectId: "proj_auth", alias: "auth", sourcePath: auth.path, baseRef: auth.commit }],
    });
    writeFileSync(join(prepared.rootPath, "session.json"), `${JSON.stringify({
      schemaVersion: 1,
      sessionId: "session_legacy",
      workspaceName: "Legacy",
      repositories: prepared.repositories,
    })}\n`);

    expect(readSessionManifest(dataRoot, "session_legacy")).toMatchObject({
      schemaVersion: 2,
      owner: "bb-plugin-workspaces",
      revision: 1,
      operations: [],
      instructions: "",
      repositories: [{ alias: "auth", worktreePath: join(prepared.rootPath, "repos/auth") }],
    });
  });

  it("adds a repository once and replays duplicate operations without another worktree", async () => {
    const auth = repository("auth");
    const audits = repository("audits");
    const dataRoot = mkdtempSync(join(tmpdir(), "bb-workspaces-data-"));
    roots.push(dataRoot);
    await prepareSession({
      dataRoot, sessionId: "session_expand", workspaceName: "Expand", instructions: "Keep focused.",
      repositories: [{ projectId: "proj_auth", alias: "auth", sourcePath: auth.path, baseRef: auth.commit }],
    });
    const request = {
      dataRoot, sessionId: "session_expand", operationKey: "expand-audits-1",
      repository: { projectId: "proj_audits", alias: "audits", sourcePath: audits.path, baseRef: "HEAD" },
    };

    const added = await addRepository(request);
    const replayed = await addRepository(request);
    const duplicateProject = await addRepository({
      ...request,
      operationKey: "expand-audits-2",
      repository: { ...request.repository, alias: "different-alias" },
    });
    const manifest = readSessionManifest(dataRoot, "session_expand");

    expect(manifest.repositories.at(-1)).toMatchObject({ alias: "audits", worktreePath: added.repository.worktreePath });
    expect(replayed).toEqual(added);
    expect(duplicateProject).toEqual(added);
    expect(manifest).toMatchObject({ revision: 2, operations: [{ key: "expand-audits-1", projectId: "proj_audits", alias: "audits" }] });
    expect(git(audits.path, "branch", "--list", "bb-workspace/session-expand/*").split("\n").filter(Boolean)).toHaveLength(1);
    expect(readFileSync(join(added.repository.worktreePath, "README.md"), "utf8")).toBe("audits\n");
  });

  it("rejects unsafe additions and manifests that do not prove session ownership", async () => {
    const auth = repository("auth");
    const audits = repository("audits");
    const dataRoot = mkdtempSync(join(tmpdir(), "bb-workspaces-data-"));
    roots.push(dataRoot);
    const prepared = await prepareSession({
      dataRoot, sessionId: "session_validation", workspaceName: "Validation", instructions: "",
      repositories: [{ projectId: "proj_auth", alias: "auth", sourcePath: auth.path, baseRef: auth.commit }],
    });

    await expect(addRepository({
      dataRoot, sessionId: "session_validation", operationKey: "expand-invalid-1",
      repository: { projectId: "proj_audits", alias: "../audits", sourcePath: audits.path, baseRef: "HEAD" },
    })).rejects.toThrow(/alias/i);
    expect(git(audits.path, "branch", "--list", "bb-workspace/session-validation/*")).toBe("");

    const manifestPath = join(prepared.rootPath, "session.json");
    const valid = JSON.parse(readFileSync(manifestPath, "utf8"));
    writeFileSync(manifestPath, JSON.stringify({ ...valid, owner: "someone-else" }));
    await expect(addRepository({
      dataRoot, sessionId: "session_validation", operationKey: "expand-audits-1",
      repository: { projectId: "proj_audits", alias: "audits", sourcePath: audits.path, baseRef: "HEAD" },
    })).rejects.toThrow(/owner/i);
    expect(git(audits.path, "branch", "--list", "bb-workspace/session-validation/*")).toBe("");

    writeFileSync(manifestPath, JSON.stringify({ ...valid, owner: undefined }));
    expect(() => readSessionManifest(dataRoot, "session_validation")).toThrow(/owner/i);
  });

  it("atomically replaces the manifest without leaving readable temporary metadata", async () => {
    const auth = repository("auth");
    const audits = repository("audits");
    const dataRoot = mkdtempSync(join(tmpdir(), "bb-workspaces-data-"));
    roots.push(dataRoot);
    const prepared = await prepareSession({
      dataRoot, sessionId: "session_atomic", workspaceName: "Atomic", instructions: "",
      repositories: [{ projectId: "proj_auth", alias: "auth", sourcePath: auth.path, baseRef: auth.commit }],
    });

    await addRepository({
      dataRoot, sessionId: "session_atomic", operationKey: "expand-audits-1",
      repository: { projectId: "proj_audits", alias: "audits", sourcePath: audits.path, baseRef: "HEAD" },
    });

    const manifestPath = join(prepared.rootPath, "session.json");
    expect(readSessionManifest(dataRoot, "session_atomic").revision).toBe(2);
    expect(statSync(manifestPath).mode & 0o777).toBe(0o600);
    expect(readdirSync(prepared.rootPath).filter((name) => name.startsWith(".session.json."))).toEqual([]);
  });

  it("rolls back only a new worktree and branch when manifest publishing fails", async () => {
    const auth = repository("auth");
    const audits = repository("audits");
    const dataRoot = mkdtempSync(join(tmpdir(), "bb-workspaces-data-"));
    roots.push(dataRoot);
    const prepared = await prepareSession({
      dataRoot, sessionId: "session_rollback", workspaceName: "Rollback", instructions: "Keep prior instructions.",
      repositories: [{ projectId: "proj_auth", alias: "auth", sourcePath: auth.path, baseRef: auth.commit }],
    });
    const priorAgents = readFileSync(join(prepared.rootPath, "AGENTS.md"), "utf8");

    await expect(addRepository({
      dataRoot, sessionId: "session_rollback", operationKey: "expand-audits-1",
      repository: { projectId: "proj_audits", alias: "audits", sourcePath: audits.path, baseRef: "HEAD" },
      fileOperations: { writeAtomic: async () => { throw new Error("metadata unavailable"); } },
    })).rejects.toThrow(/metadata unavailable/);

    expect(readFileSync(join(prepared.rootPath, "AGENTS.md"), "utf8")).toBe(priorAgents);
    expect(existsSync(join(prepared.rootPath, "repos/audits"))).toBe(false);
    expect(git(audits.path, "branch", "--list", "bb-workspace/session-rollback/audits")).toBe("");
    expect(readSessionManifest(dataRoot, "session_rollback").revision).toBe(1);
  });

  it("removes artifacts created before a worktree command reports failure", async () => {
    const auth = repository("auth");
    const audits = repository("audits");
    const dataRoot = mkdtempSync(join(tmpdir(), "bb-workspaces-data-"));
    roots.push(dataRoot);
    await prepareSession({
      dataRoot, sessionId: "session_partial", workspaceName: "Partial", instructions: "",
      repositories: [{ projectId: "proj_auth", alias: "auth", sourcePath: auth.path, baseRef: auth.commit }],
    });
    const worktreePath = join(dataRoot, "sessions/session_partial/repos/audits");
    const branch = "bb-workspace/session-partial/audits";
    const outcome = await addRepository({
      dataRoot, sessionId: "session_partial", operationKey: "expand-audits-1",
      repository: { projectId: "proj_audits", alias: "audits", sourcePath: audits.path, baseRef: "HEAD" },
      fileOperations: {
        addWorktree: async () => {
          git(audits.path, "worktree", "add", worktreePath, branch);
          throw new Error("worktree command reported failure");
        },
      },
    }).then(() => null, (error: unknown) => error);

    if (outcome === null) {
      git(audits.path, "worktree", "remove", worktreePath);
      git(audits.path, "branch", "-D", branch);
    }
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/worktree command reported failure/);
    expect(existsSync(worktreePath)).toBe(false);
    expect(git(audits.path, "branch", "--list", branch)).toBe("");
  });

  it("keeps the new repository recoverable when restoring AGENTS.md fails", async () => {
    const auth = repository("auth");
    const audits = repository("audits");
    const dataRoot = mkdtempSync(join(tmpdir(), "bb-workspaces-data-"));
    roots.push(dataRoot);
    await prepareSession({
      dataRoot, sessionId: "session_restore", workspaceName: "Restore", instructions: "",
      repositories: [{ projectId: "proj_auth", alias: "auth", sourcePath: auth.path, baseRef: auth.commit }],
    });
    const worktreePath = join(dataRoot, "sessions/session_restore/repos/audits");
    const branch = "bb-workspace/session-restore/audits";
    const outcome = await addRepository({
      dataRoot, sessionId: "session_restore", operationKey: "expand-audits-1",
      repository: { projectId: "proj_audits", alias: "audits", sourcePath: audits.path, baseRef: "HEAD" },
      fileOperations: {
        writeAtomic: async () => { throw new Error("manifest unavailable"); },
        restoreInstructions: async () => { throw new Error("instructions restore unavailable"); },
      },
    }).then(() => null, (error: unknown) => error);

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/manifest unavailable/);
    expect((outcome as Error).message).toMatch(/instructions restore unavailable/);
    expect(readFileSync(join(dataRoot, "sessions/session_restore/AGENTS.md"), "utf8")).toContain("`repos/audits`");
    expect(existsSync(worktreePath)).toBe(true);
    expect(git(audits.path, "branch", "--list", branch)).not.toBe("");

    git(audits.path, "worktree", "remove", worktreePath);
    git(audits.path, "branch", "-D", branch);
  });

  it("serializes concurrent additions for one session into one repository", async () => {
    const auth = repository("auth");
    const audits = repository("audits");
    const dataRoot = mkdtempSync(join(tmpdir(), "bb-workspaces-data-"));
    roots.push(dataRoot);
    await prepareSession({
      dataRoot, sessionId: "session_concurrent", workspaceName: "Concurrent", instructions: "",
      repositories: [{ projectId: "proj_auth", alias: "auth", sourcePath: auth.path, baseRef: auth.commit }],
    });

    const results = await Promise.all([
      addRepository({ dataRoot, sessionId: "session_concurrent", operationKey: "expand-audits-1", repository: { projectId: "proj_audits", alias: "audits", sourcePath: audits.path, baseRef: "HEAD" } }),
      addRepository({ dataRoot, sessionId: "session_concurrent", operationKey: "expand-audits-2", repository: { projectId: "proj_audits", alias: "audits", sourcePath: audits.path, baseRef: "HEAD" } }),
    ]);
    const manifest = readSessionManifest(dataRoot, "session_concurrent");

    expect(results[0]).toEqual(results[1]);
    expect(manifest.repositories.filter((entry) => entry.projectId === "proj_audits")).toHaveLength(1);
    expect(git(audits.path, "branch", "--list", "bb-workspace/session-concurrent/audits").split("\n").filter(Boolean)).toHaveLength(1);
    expect(existsSync(join(dataRoot, "sessions/session_concurrent/repos/audits"))).toBe(true);
  });

  it("reports repository changes independently", async () => {
    const auth = repository("auth");
    const dataRoot = mkdtempSync(join(tmpdir(), "bb-workspaces-data-"));
    roots.push(dataRoot);
    const result = await prepareSession({
      dataRoot,
      sessionId: "session_status",
      workspaceName: "Authentication",
      instructions: "",
      repositories: [
        { projectId: "proj_auth", alias: "auth", sourcePath: auth.path, baseRef: auth.commit },
      ],
    });
    const checkout = result.repositories[0]!.worktreePath;
    writeFileSync(join(checkout, "README.md"), "changed\n");
    mkdirSync(join(checkout, "new folder"));
    writeFileSync(join(checkout, "new folder/file name.txt"), "new\n");

    const status = await readRepositoryStatus(checkout, auth.commit);

    expect(status.changedFiles).toEqual([
      { path: "README.md", status: "modified" },
      { path: "new folder/file name.txt", status: "untracked" },
    ]);
    expect(status.clean).toBe(false);
  });

  it("does not overwrite an unknown session directory", async () => {
    const auth = repository("auth");
    const dataRoot = mkdtempSync(join(tmpdir(), "bb-workspaces-data-"));
    roots.push(dataRoot);
    const target = join(dataRoot, "sessions", "session_collision");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "someone-elses-file"), "keep");

    await expect(prepareSession({
      dataRoot,
      sessionId: "session_collision",
      workspaceName: "Collision",
      instructions: "",
      repositories: [
        { projectId: "proj_auth", alias: "auth", sourcePath: auth.path, baseRef: auth.commit },
      ],
    })).rejects.toThrow(/already exists/i);
    expect(readFileSync(join(target, "someone-elses-file"), "utf8")).toBe("keep");
  });

  it("cleans only unchanged owned worktrees and preserves their branches", async () => {
    const auth = repository("auth");
    const dataRoot = mkdtempSync(join(tmpdir(), "bb-workspaces-data-"));
    roots.push(dataRoot);
    const prepared = await prepareSession({
      dataRoot, sessionId: "session_clean", workspaceName: "Clean", instructions: "",
      repositories: [{ projectId: "proj_auth", alias: "auth", sourcePath: auth.path, baseRef: auth.commit }],
    });

    await cleanupSession({ dataRoot, sessionId: "session_clean", repositories: prepared.repositories });

    expect(() => readFileSync(prepared.rootPath, "utf8")).toThrow();
    expect(git(auth.path, "show-ref", "--verify", "refs/heads/bb-workspace/session-clean/auth")).toContain(auth.commit);
  });

  it("removes a clean worktree with commits and preserves the committed branch tip", async () => {
    const auth = repository("auth");
    const dataRoot = mkdtempSync(join(tmpdir(), "bb-workspaces-data-"));
    roots.push(dataRoot);
    const prepared = await prepareSession({
      dataRoot, sessionId: "session_committed", workspaceName: "Committed", instructions: "",
      repositories: [{ projectId: "proj_auth", alias: "auth", sourcePath: auth.path, baseRef: auth.commit }],
    });
    const checkout = prepared.repositories[0]!.worktreePath;
    writeFileSync(join(checkout, "README.md"), "committed change\n");
    git(checkout, "add", "README.md");
    git(checkout, "commit", "-m", "change auth");
    const branchTip = git(checkout, "rev-parse", "HEAD");

    const status = await readRepositoryStatus(checkout, auth.commit);
    expect(status).toMatchObject({ clean: true, aheadOfBase: true, changedFiles: [] });
    await cleanupSession({ dataRoot, sessionId: "session_committed", repositories: prepared.repositories });

    expect(git(auth.path, "rev-parse", "refs/heads/bb-workspace/session-committed/auth")).toBe(branchTip);
  });

  it("refuses cleanup when a repository has uncommitted work", async () => {
    const auth = repository("auth");
    const dataRoot = mkdtempSync(join(tmpdir(), "bb-workspaces-data-"));
    roots.push(dataRoot);
    const prepared = await prepareSession({
      dataRoot, sessionId: "session_dirty", workspaceName: "Dirty", instructions: "",
      repositories: [{ projectId: "proj_auth", alias: "auth", sourcePath: auth.path, baseRef: auth.commit }],
    });
    writeFileSync(join(prepared.repositories[0]!.worktreePath, "README.md"), "unsaved\n");

    await expect(cleanupSession({ dataRoot, sessionId: "session_dirty", repositories: prepared.repositories })).rejects.toThrow(/not clean/i);
    expect(readFileSync(join(prepared.repositories[0]!.worktreePath, "README.md"), "utf8")).toBe("unsaved\n");
  });

  it("refuses cleanup when a worktree was switched to another branch", async () => {
    const auth = repository("auth");
    const dataRoot = mkdtempSync(join(tmpdir(), "bb-workspaces-data-"));
    roots.push(dataRoot);
    const prepared = await prepareSession({
      dataRoot, sessionId: "session_switched", workspaceName: "Switched", instructions: "",
      repositories: [{ projectId: "proj_auth", alias: "auth", sourcePath: auth.path, baseRef: auth.commit }],
    });
    git(prepared.repositories[0]!.worktreePath, "switch", "-c", "unexpected-branch");

    await expect(cleanupSession({ dataRoot, sessionId: "session_switched", repositories: prepared.repositories })).rejects.toThrow(/recorded session branch/i);
  });
});

describe("per-repository fetch credentials", () => {
  const AMBIENT_TOKEN = "ambient-bm-sentinel";
  const AMBIENT_HELPER =
    '!f() { test "$1" = get || exit 0; protocol=; host=; ' +
    'while IFS= read -r line && test -n "$line"; do ' +
    'case "$line" in protocol=*) protocol=${line#protocol=} ;; host=*) host=${line#host=} ;; esac; done; ' +
    'if test "$protocol" = https && test "$host" = github.com && test -n "$GH_TOKEN"; then ' +
    'printf "username=x-access-token\\npassword=%s\\n" "$GH_TOKEN"; fi; }; f';

  let ghLog = "";
  let envCapture = "";
  let savedEnv: NodeJS.ProcessEnv = {};

  beforeEach(() => {
    savedEnv = { ...process.env };
    const root = mkdtempSync(join(tmpdir(), "bb-workspaces-auth-"));
    roots.push(root);
    const binDir = join(root, "bin");
    mkdirSync(binDir);
    ghLog = join(root, "gh.log");
    envCapture = join(root, "captured.env");
    writeFileSync(ghLog, "");
    writeFileSync(join(binDir, "gh"), [
      "#!/bin/sh",
      'printf "%s\\n" "$*" >> "$BB_WS_FAKE_GH_LOG"',
      'if [ -n "${GH_TOKEN:-}" ] || [ -n "${GITHUB_TOKEN:-}" ] || [ -n "${GH_ENTERPRISE_TOKEN:-}" ] || [ -n "${GITHUB_ENTERPRISE_TOKEN:-}" ]; then',
      '  echo "ambient token visible to gh" >&2',
      "  exit 9",
      "fi",
      'user=""; host=""',
      'while [ "$#" -gt 0 ]; do',
      '  case "$1" in',
      '    --user) user="$2"; shift 2 ;;',
      '    --hostname) host="$2"; shift 2 ;;',
      "    *) shift ;;",
      "  esac",
      "done",
      'case "$user:$host" in',
      '  repo-account:github.com) printf "%s\\n" "test-token-repo-account" ;;',
      '  other-account:github.com) printf "%s\\n" "test-token-other-account" ;;',
      "  *) exit 7 ;;",
      "esac",
      "",
    ].join("\n"));
    writeFileSync(join(binDir, "bb-capture-env"), [
      "#!/bin/sh",
      'env | sort > "$BB_WS_ENV_CAPTURE"',
      "exit 1",
      "",
    ].join("\n"));
    chmodSync(join(binDir, "gh"), 0o755);
    chmodSync(join(binDir, "bb-capture-env"), 0o755);
    process.env.PATH = `${binDir}:${process.env.PATH}`;
    process.env.GH_TOKEN = AMBIENT_TOKEN;
    process.env.GITHUB_TOKEN = AMBIENT_TOKEN;
    process.env.BB_WS_FAKE_GH_LOG = ghLog;
    process.env.BB_WS_ENV_CAPTURE = envCapture;
    process.env.GIT_CONFIG_COUNT = "4";
    process.env.GIT_CONFIG_KEY_0 = "credential.helper";
    process.env.GIT_CONFIG_VALUE_0 = "";
    process.env.GIT_CONFIG_KEY_1 = "credential.helper";
    process.env.GIT_CONFIG_VALUE_1 = AMBIENT_HELPER;
    process.env.GIT_CONFIG_KEY_2 = "url.https://github.com/.insteadOf";
    process.env.GIT_CONFIG_VALUE_2 = "git@github.com:";
    process.env.GIT_CONFIG_KEY_3 = "url.https://github.com/.insteadOf";
    process.env.GIT_CONFIG_VALUE_3 = "ssh://git@github.com/";
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  });

  function markedRepository(name: string, account: string, remote = "ext::bb-capture-env"): { path: string; commit: string } {
    const repo = repository(name);
    writeFileSync(join(repo.path, ".gh-account"), `${account}\n`);
    git(repo.path, "config", "protocol.ext.allow", "always");
    git(repo.path, "remote", "add", "origin", remote);
    return repo;
  }

  function capturedEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const line of readFileSync(envCapture, "utf8").split("\n")) {
      const separator = line.indexOf("=");
      if (separator > 0) env[line.slice(0, separator)] = line.slice(separator + 1);
    }
    return env;
  }

  function credentialFill(repoPath: string, env: Record<string, string>, query: string): string {
    try {
      return execFileSync("git", ["-C", repoPath, "credential", "fill"], {
        encoding: "utf8",
        env: { ...env, GIT_TERMINAL_PROMPT: "0" },
        input: query,
      });
    } catch (error) {
      const stderr = typeof error === "object" && error !== null && "stderr" in error ? String(error.stderr) : "";
      return stderr;
    }
  }

  it("resolves the marker account through gh and overrides the ambient credential helper", async () => {
    const repo = markedRepository("marker-fetch", "repo-account");

    const [bases] = await readRepositoryBases({ repositories: [{ projectId: "svc", sourcePath: repo.path }], fetch: true });

    expect(bases!.fetchError).toBeTruthy();
    expect(bases!.fetchError).not.toContain("test-token");
    expect(bases!.fetchError).not.toContain(AMBIENT_TOKEN);
    const env = capturedEnv();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.GH_ENTERPRISE_TOKEN).toBeUndefined();
    expect(env.GITHUB_ENTERPRISE_TOKEN).toBeUndefined();
    expect(env.BB_WS_GH_ACCOUNT).toBe("repo-account");
    expect(env.BB_WS_GH_HOST).toBe("github.com");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GIT_CONFIG_COUNT).toBe("6");
    expect(env.GIT_CONFIG_KEY_4).toBe("credential.helper");
    expect(env.GIT_CONFIG_VALUE_4).toBe("");
    expect(env.GIT_CONFIG_KEY_5).toBe("credential.helper");
    expect(env.GIT_CONFIG_VALUE_5).not.toContain("test-token");
    expect(env.GIT_CONFIG_KEY_2).toBe("url.https://github.com/.insteadOf");

    const fill = credentialFill(repo.path, env, "protocol=https\nhost=github.com\n\n");
    expect(fill).toContain("username=x-access-token");
    expect(fill).toContain("password=test-token-repo-account");

    const log = readFileSync(ghLog, "utf8");
    expect(log).toContain("auth token --user repo-account --hostname github.com");
    expect(log).not.toContain("test-token");
    expect(log).not.toContain(AMBIENT_TOKEN);
  });

  it("selects a different account for each repository marker", async () => {
    const first = markedRepository("acct-first", "repo-account");
    const second = markedRepository("acct-second", "other-account");

    await readRepositoryBases({ repositories: [{ projectId: "a", sourcePath: first.path }], fetch: true });
    const firstEnv = capturedEnv();
    unlinkSync(envCapture);
    await readRepositoryBases({ repositories: [{ projectId: "b", sourcePath: second.path }], fetch: true });
    const secondEnv = capturedEnv();

    expect(firstEnv.BB_WS_GH_ACCOUNT).toBe("repo-account");
    expect(secondEnv.BB_WS_GH_ACCOUNT).toBe("other-account");
    expect(credentialFill(first.path, firstEnv, "protocol=https\nhost=github.com\n\n")).toContain("password=test-token-repo-account");
    expect(credentialFill(second.path, secondEnv, "protocol=https\nhost=github.com\n\n")).toContain("password=test-token-other-account");
  });

  it("scopes the marker helper to HTTPS on the declared host", async () => {
    const repo = markedRepository("scoped", "repo-account");

    await readRepositoryBases({ repositories: [{ projectId: "svc", sourcePath: repo.path }], fetch: true });
    const env = capturedEnv();

    const otherHost = credentialFill(repo.path, env, "protocol=https\nhost=example.org\n\n");
    expect(otherHost).not.toContain("password=");
    expect(otherHost).toContain("terminal prompts disabled");
    expect(credentialFill(repo.path, env, "protocol=ssh\nhost=github.com\n\n")).not.toContain("password=");
  });

  it("fails closed when the marker account is not in the gh auth store", async () => {
    const repo = markedRepository("ghost", "ghost-account");
    const dataRoot = mkdtempSync(join(tmpdir(), "bb-workspaces-data-"));
    roots.push(dataRoot);

    const [bases] = await readRepositoryBases({ repositories: [{ projectId: "svc", sourcePath: repo.path }], fetch: true });

    expect(bases!.fetchError).toContain('Cannot resolve GitHub account "ghost-account"');
    expect(bases!.fetchError).not.toContain("test-token");
    expect(bases!.fetchError).not.toContain(AMBIENT_TOKEN);
    expect(existsSync(envCapture)).toBe(false);
    await expect(prepareSession({
      dataRoot, sessionId: "session_ghost", workspaceName: "Ghost", instructions: "",
      repositories: [{ projectId: "svc", alias: "svc", sourcePath: repo.path, baseRef: "origin/main" }],
    })).rejects.toThrow(/Cannot resolve GitHub account "ghost-account"/);
    expect(existsSync(join(dataRoot, "sessions", "session_ghost"))).toBe(false);
  });

  it("fails closed on an invalid marker instead of falling back to ambient auth", async () => {
    const repo = markedRepository("bad-marker", "not an account!!");

    const [bases] = await readRepositoryBases({ repositories: [{ projectId: "svc", sourcePath: repo.path }], fetch: true });

    expect(bases!.fetchError).toContain("Invalid .gh-account marker");
    expect(existsSync(envCapture)).toBe(false);
  });

  it("refuses to base a session on a stale ref when a marker repository cannot fetch", async () => {
    const repo = markedRepository("stale-base", "repo-account");
    git(repo.path, "update-ref", "refs/remotes/origin/main", "HEAD");
    const dataRoot = mkdtempSync(join(tmpdir(), "bb-workspaces-data-"));
    roots.push(dataRoot);

    await expect(prepareSession({
      dataRoot, sessionId: "session_stale", workspaceName: "Stale", instructions: "",
      repositories: [{ projectId: "svc", alias: "svc", sourcePath: repo.path, baseRef: "origin/main" }],
    })).rejects.toThrow();
    expect(existsSync(join(dataRoot, "sessions", "session_stale"))).toBe(false);
    expect(git(repo.path, "branch", "--list", "bb-workspace/session-stale/*")).toBe("");
  });

  it("keeps the ambient environment for repositories without a marker", async () => {
    const repo = repository("plain-fetch");
    git(repo.path, "config", "protocol.ext.allow", "always");
    git(repo.path, "remote", "add", "origin", "ext::bb-capture-env");

    const [bases] = await readRepositoryBases({ repositories: [{ projectId: "svc", sourcePath: repo.path }], fetch: true });

    expect(bases!.fetchError).toBeTruthy();
    const env = capturedEnv();
    expect(env.GH_TOKEN).toBe(AMBIENT_TOKEN);
    expect(env.GIT_CONFIG_COUNT).toBe("4");
    expect(env.BB_WS_GH_ACCOUNT).toBeUndefined();
    expect(credentialFill(repo.path, env, "protocol=https\nhost=github.com\n\n")).toContain(`password=${AMBIENT_TOKEN}`);
    expect(readFileSync(ghLog, "utf8")).toBe("");
  });

  it("still tolerates fetch failures for repositories without a marker", async () => {
    const repo = repository("plain-stale");
    git(repo.path, "config", "protocol.ext.allow", "always");
    git(repo.path, "remote", "add", "origin", "ext::bb-capture-env");
    git(repo.path, "update-ref", "refs/remotes/origin/main", "HEAD");
    const dataRoot = mkdtempSync(join(tmpdir(), "bb-workspaces-data-"));
    roots.push(dataRoot);

    const prepared = await prepareSession({
      dataRoot, sessionId: "session_plain", workspaceName: "Plain", instructions: "",
      repositories: [{ projectId: "svc", alias: "svc", sourcePath: repo.path, baseRef: "origin/main" }],
    });

    expect(prepared.repositories[0]).toMatchObject({ baseRef: "origin/main", baseCommit: repo.commit });
  });

  it("leaves SSH remotes on their native transport", async () => {
    const repo = markedRepository("ssh-remote", "repo-account", "ssh://localhost:1/repo.git");

    const [bases] = await readRepositoryBases({ repositories: [{ projectId: "svc", sourcePath: repo.path }], fetch: true });

    expect(bases!.fetchError).toBeTruthy();
    expect(bases!.fetchError).not.toContain("Cannot resolve");
    expect(bases!.fetchError).not.toContain("test-token");
    expect(existsSync(envCapture)).toBe(false);
    expect(readFileSync(ghLog, "utf8").trim().split("\n")).toEqual([
      "auth token --user repo-account --hostname github.com",
    ]);
  });
});

describe("worktree gh account marker", () => {
  /** A checkout whose gitignored `.gh-account` marker `git worktree add` cannot carry over. */
  function markedSource(name: string, account: string): { path: string; commit: string } {
    const repo = repository(name);
    writeFileSync(join(repo.path, ".gitignore"), ".gh-account\n");
    git(repo.path, "add", ".gitignore");
    git(repo.path, "commit", "-m", "ignore account marker");
    writeFileSync(join(repo.path, ".gh-account"), `${account}\n`);
    return { path: repo.path, commit: git(repo.path, "rev-parse", "HEAD") };
  }

  it("carries the marker into a new session worktree as a non-secret ignored file", async () => {
    const repo = markedSource("marked-prepare", "repo-account");
    const dataRoot = mkdtempSync(join(tmpdir(), "bb-workspaces-data-"));
    roots.push(dataRoot);

    const prepared = await prepareSession({
      dataRoot, sessionId: "session_marked", workspaceName: "Marked", instructions: "",
      repositories: [{ projectId: "svc", alias: "svc", sourcePath: repo.path, baseRef: repo.commit }],
    });

    const worktreePath = prepared.repositories[0]!.worktreePath;
    const markerPath = join(worktreePath, ".gh-account");
    const marker = readFileSync(markerPath, "utf8");
    expect(marker).toBe("repo-account\n");
    expect(marker).not.toMatch(/token|gh[opsur]_|password/i);
    expect(statSync(markerPath).mode & 0o777).toBe(0o600);
    expect(await readRepositoryStatus(worktreePath, repo.commit)).toMatchObject({ clean: true, changedFiles: [] });

    await cleanupSession({ dataRoot, sessionId: "session_marked", repositories: prepared.repositories });
    expect(existsSync(prepared.rootPath)).toBe(false);
  });

  it("carries the marker when a repository is added to a live session", async () => {
    const seed = repository("marked-seed");
    const marked = markedSource("marked-add", "repo-account");
    const dataRoot = mkdtempSync(join(tmpdir(), "bb-workspaces-data-"));
    roots.push(dataRoot);
    await prepareSession({
      dataRoot, sessionId: "session_live", workspaceName: "Live", instructions: "",
      repositories: [{ projectId: "proj_seed", alias: "seed", sourcePath: seed.path, baseRef: seed.commit }],
    });

    const added = await addRepository({
      dataRoot, sessionId: "session_live", operationKey: "add-marked-1",
      repository: { projectId: "proj_marked", alias: "marked", sourcePath: marked.path, baseRef: marked.commit },
    });

    expect(readFileSync(join(added.repository.worktreePath, ".gh-account"), "utf8")).toBe("repo-account\n");
    expect(existsSync(join(dataRoot, "sessions/session_live/repos/seed/.gh-account"))).toBe(false);
  });

  it("leaves the worktree unmarked when the source has no marker", async () => {
    const repo = repository("unmarked");
    const dataRoot = mkdtempSync(join(tmpdir(), "bb-workspaces-data-"));
    roots.push(dataRoot);

    const prepared = await prepareSession({
      dataRoot, sessionId: "session_unmarked", workspaceName: "Unmarked", instructions: "",
      repositories: [{ projectId: "svc", alias: "svc", sourcePath: repo.path, baseRef: repo.commit }],
    });

    expect(existsSync(join(prepared.repositories[0]!.worktreePath, ".gh-account"))).toBe(false);
  });

  it("fails before a usable session when the source marker is invalid", async () => {
    const repo = repository("bad-marker");
    writeFileSync(join(repo.path, ".gh-account"), "not an account!!\n");
    const dataRoot = mkdtempSync(join(tmpdir(), "bb-workspaces-data-"));
    roots.push(dataRoot);

    await expect(prepareSession({
      dataRoot, sessionId: "session_badmark", workspaceName: "Bad", instructions: "",
      repositories: [{ projectId: "svc", alias: "svc", sourcePath: repo.path, baseRef: repo.commit }],
    })).rejects.toThrow(/Invalid \.gh-account marker/);

    expect(existsSync(join(dataRoot, "sessions", "session_badmark"))).toBe(false);
    expect(git(repo.path, "branch", "--list", "bb-workspace/session-badmark/*")).toBe("");
    expect(git(repo.path, "worktree", "list")).not.toContain("session_badmark");
  });

  it("fails closed when the worktree already has a conflicting marker", async () => {
    const repo = repository("conflict-marker");
    writeFileSync(join(repo.path, ".gh-account"), "committed-account\n");
    git(repo.path, "add", "-f", ".gh-account");
    git(repo.path, "commit", "-m", "track marker");
    const commit = git(repo.path, "rev-parse", "HEAD");
    writeFileSync(join(repo.path, ".gh-account"), "local-account\n");
    const dataRoot = mkdtempSync(join(tmpdir(), "bb-workspaces-data-"));
    roots.push(dataRoot);

    await expect(prepareSession({
      dataRoot, sessionId: "session_conflict", workspaceName: "Conflict", instructions: "",
      repositories: [{ projectId: "svc", alias: "svc", sourcePath: repo.path, baseRef: commit }],
    })).rejects.toThrow(/Conflicting \.gh-account marker/);

    expect(existsSync(join(dataRoot, "sessions", "session_conflict"))).toBe(false);
    expect(git(repo.path, "branch", "--list", "bb-workspace/session-conflict/*")).toBe("");
    expect(git(repo.path, "worktree", "list")).not.toContain("session_conflict");
  });

  it("rolls back a live addition when the marker cannot be written", async () => {
    const seed = repository("writefail-seed");
    const marked = markedSource("marked-writefail", "repo-account");
    const dataRoot = mkdtempSync(join(tmpdir(), "bb-workspaces-data-"));
    roots.push(dataRoot);
    const prepared = await prepareSession({
      dataRoot, sessionId: "session_writefail", workspaceName: "Writefail", instructions: "",
      repositories: [{ projectId: "proj_seed", alias: "seed", sourcePath: seed.path, baseRef: seed.commit }],
    });
    const priorAgents = readFileSync(join(prepared.rootPath, "AGENTS.md"), "utf8");
    const worktreePath = join(prepared.rootPath, "repos", "marked");
    const branch = "bb-workspace/session-writefail/marked";

    await expect(addRepository({
      dataRoot, sessionId: "session_writefail", operationKey: "add-marked-1",
      repository: { projectId: "proj_marked", alias: "marked", sourcePath: marked.path, baseRef: marked.commit },
      fileOperations: {
        addWorktree: async () => {
          git(marked.path, "worktree", "add", worktreePath, branch);
          symlinkSync(join(marked.path, ".gh-account-dangling-target"), join(worktreePath, ".gh-account"));
        },
      },
    })).rejects.toThrow(/Invalid \.gh-account marker/);

    expect(existsSync(worktreePath)).toBe(false);
    expect(git(marked.path, "branch", "--list", branch)).toBe("");
    expect(readSessionManifest(dataRoot, "session_writefail").revision).toBe(1);
    expect(readFileSync(join(prepared.rootPath, "AGENTS.md"), "utf8")).toBe(priorAgents);
  });

  it("never removes a marker it did not create", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bb-workspaces-wt-"));
    roots.push(dir);
    const markerPath = join(dir, ".gh-account");
    writeFileSync(markerPath, "other-account\n");

    await expect(writeGhAccountMarker(markerPath, "repo-account\n")).rejects.toThrow(/Conflicting \.gh-account marker/);

    expect(readFileSync(markerPath, "utf8")).toBe("other-account\n");
    expect(statSync(markerPath).isFile()).toBe(true);
  });

  it("rejects a symlinked marker instead of following it", async () => {
    const repo = repository("symlink-marker");
    writeFileSync(join(repo.path, "marker-target"), "repo-account\n");
    symlinkSync("marker-target", join(repo.path, ".gh-account"));
    const dataRoot = mkdtempSync(join(tmpdir(), "bb-workspaces-data-"));
    roots.push(dataRoot);

    await expect(prepareSession({
      dataRoot, sessionId: "session_symlink", workspaceName: "Symlink", instructions: "",
      repositories: [{ projectId: "svc", alias: "svc", sourcePath: repo.path, baseRef: repo.commit }],
    })).rejects.toThrow(/Invalid \.gh-account marker/);

    expect(existsSync(join(dataRoot, "sessions", "session_symlink"))).toBe(false);
    expect(git(repo.path, "worktree", "list")).not.toContain("session_symlink");
  });

  it("copies only the validated login, never extra source marker lines", async () => {
    const repo = repository("extra-lines");
    writeFileSync(join(repo.path, ".gh-account"), "  repo-account  \n\nghp_decoysentinel\n");
    const dataRoot = mkdtempSync(join(tmpdir(), "bb-workspaces-data-"));
    roots.push(dataRoot);

    const prepared = await prepareSession({
      dataRoot, sessionId: "session_lines", workspaceName: "Lines", instructions: "",
      repositories: [{ projectId: "svc", alias: "svc", sourcePath: repo.path, baseRef: repo.commit }],
    });

    const marker = readFileSync(join(prepared.repositories[0]!.worktreePath, ".gh-account"), "utf8");
    expect(marker).toBe("repo-account\n");
    expect(marker).not.toContain("ghp_decoysentinel");
  });
});
