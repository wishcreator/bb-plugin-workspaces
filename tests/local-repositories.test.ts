import { describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { workspaceDraftSchema, type SessionSnapshot, type Workspace } from "../src/contracts";
import { WORKSPACE_MIGRATIONS, WorkspaceStore } from "../src/store";

const repository = { projectId: "local:infra", alias: "infra", hostId: "host_ws", localPath: "/repos/infra" };
const draft = { name: "Development", description: "", instructions: "Shared context", ownerProjectId: "proj_aim", repositories: [repository, { ...repository, projectId: "local:plugin", alias: "plugin", localPath: "/repos/plugin" }] };

async function fixture() {
  const spawn = vi.fn(async (input) => makeThreadResponse({ id: `thr_${spawn.mock.calls.length}`, projectId: input.projectId }));
  const create = vi.fn();
  let prepared: unknown;
  const { bb, harness } = createFakePluginHost({
    pluginId: "workspaces", experimental_hostEntry: true,
    sdk: { projects: { list: async () => [{ id: "proj_aim", kind: "standard", name: "AI Mindset", gitRemoteUrl: null, sources: [], createdAt: 1, updatedAt: 1 }], create }, threads: { spawn } },
    experimental_callHostRpc: async ({ method, input }) => {
      if (method === "repository_bases") return { repositories: (input as { repositories: { projectId: string }[] }).repositories.map((repo) => ({ projectId: repo.projectId, defaultBase: "origin/main", currentBranch: "main", currentCommit: "abc123", refs: ["origin/main"], fetchError: null })) };
      if (method === "prepare_session") {
        const request = input as { sessionId: string; repositories: { projectId: string; alias: string; sourcePath: string; baseRef: string }[] };
        prepared = { schemaVersion: 2, owner: "bb-plugin-workspaces", sessionId: request.sessionId, workspaceName: draft.name, instructions: draft.instructions, revision: 1, operations: [], repositories: request.repositories.map((repo) => ({ ...repo, baseCommit: "abc123", branch: `workspace/${repo.alias}`, worktreePath: `/sessions/${request.sessionId}/repos/${repo.alias}` })) };
        return { rootPath: `/sessions/${request.sessionId}`, repositories: (prepared as { repositories: unknown[] }).repositories };
      }
      if (method === "read_session") return prepared;
      throw new Error(`Unexpected host mutation ${method}`);
    },
  });
  await plugin(bb);
  const workspace = await harness.behavior.callRpc("workspace_create", draft) as Workspace;
  return { harness, workspace, spawn, create };
}

describe("repositories connected by path", () => {
  it("persists owner and paths through edits and upgrades legacy rows", () => {
    const db = new Database(":memory:");
    WORKSPACE_MIGRATIONS.slice(0, -1).forEach((migration) => db.exec(migration));
    db.prepare("INSERT INTO workspaces VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("legacy", "Legacy", "", "", 1, 0, null, 1, 1);
    db.prepare("INSERT INTO workspace_repositories VALUES (?, ?, ?, ?)").run("legacy", "proj_old", "old", 0);
    db.exec(WORKSPACE_MIGRATIONS.at(-1)!);
    const store = new WorkspaceStore(db);
    expect(store.get("legacy").repositories).toEqual([{ projectId: "proj_old", alias: "old", ordinal: 0 }]);
    const workspace = store.create(draft);
    expect(store.get(workspace.id)).toMatchObject(draft);
    expect(store.update(workspace.id, 1, { ...draft, name: "Edited" })).toMatchObject({ ...draft, name: "Edited" });
    db.close();
  });

  it.each([
    { ...draft, ownerProjectId: undefined },
    { ...draft, repositories: [{ ...repository, localPath: "relative/path" }] },
    { ...draft, repositories: [{ ...repository, hostId: undefined }] },
    { ...draft, repositories: [{ ...repository, projectId: "proj_fake" }] },
    { ...draft, repositories: [repository, { ...repository, projectId: "local:duplicate", alias: "duplicate", localPath: "/repos/infra/" }] },
  ])("rejects incomplete or ambiguous path configuration", (value) => {
    expect(workspaceDraftSchema.safeParse(value).success).toBe(false);
  });

  it("starts in an actual worktree on the bound host and never creates a BB project", async () => {
    const { harness, workspace, spawn, create } = await fixture();
    const session = await harness.behavior.callRpc("session_start", { workspaceId: workspace.id, expectedRevision: 1, hostId: "host_ws", projectIds: [repository.projectId], prompt: "Implement task", parentThreadId: "thr_owner", requestKey: "local-launch" }) as SessionSnapshot;
    expect(spawn.mock.calls[0]![0]).toMatchObject({ projectId: "proj_aim", parentThreadId: "thr_owner", environment: { type: "host", hostId: "host_ws", workspace: { type: "unmanaged", path: session.repositories[0]!.worktreePath } } });
    expect(create).not.toHaveBeenCalled();
    expect(harness.inspection.experimental_hostRpcCalls.filter((call) => call.method === "ensure_anchor")).toHaveLength(0);
    await expect(harness.behavior.callRpc("session_start", { workspaceId: workspace.id, expectedRevision: 1, hostId: "host_mac", projectIds: [repository.projectId], prompt: "Implement task", requestKey: "wrong-host" })).rejects.toThrow(/another host/);
    expect(spawn).toHaveBeenCalledTimes(1);
    const bases = await harness.behavior.callRpc("repository_bases", { workspaceId: workspace.id, hostId: "host_ws", projectIds: [repository.projectId], fetch: true });
    expect(bases).toMatchObject({ repositories: [{ projectId: repository.projectId }] });
  });

  it("spawns an idempotent child writer with the same owner, host and repository cwd", async () => {
    const { harness, workspace, spawn, create } = await fixture();
    const session = await harness.behavior.callRpc("session_start", { workspaceId: workspace.id, expectedRevision: 1, hostId: "host_ws", projectIds: draft.repositories.map((repo) => repo.projectId), prompt: "Implement task", requestKey: "writer-parent" }) as SessionSnapshot;
    const request = { sessionId: session.id, projectId: "local:plugin", prompt: "Implement UI", requestKey: "writer-plugin" };
    const result = await harness.behavior.callRpc("session_writer_start", request);
    expect(await harness.behavior.callRpc("session_writer_start", request)).toEqual(result);
    expect(spawn.mock.calls[1]![0]).toMatchObject({ projectId: "proj_aim", parentThreadId: session.threadId, environment: { type: "host", hostId: "host_ws", workspace: { type: "unmanaged", path: session.repositories[1]!.worktreePath } } });
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(create).not.toHaveBeenCalled();
    await expect(harness.behavior.callRpc("session_writer_start", { ...request, projectId: "local:infra" })).rejects.toThrow(/another repository/);
    const dashboard = await harness.behavior.callRpc("dashboard", null) as { sessions: SessionSnapshot[] };
    expect(dashboard.sessions[0]?.writerThreadIds).toEqual(["thr_2"]);
  });

  it("does not duplicate a writer after an uncertain spawn failure", async () => {
    const { harness, workspace, spawn } = await fixture();
    const session = await harness.behavior.callRpc("session_start", { workspaceId: workspace.id, expectedRevision: 1, hostId: "host_ws", projectIds: [repository.projectId], prompt: "Task", requestKey: "uncertain-parent" }) as SessionSnapshot;
    spawn.mockRejectedValueOnce(new Error("Transport interrupted"));
    const request = { sessionId: session.id, projectId: repository.projectId, prompt: "Task", requestKey: "uncertain-writer" };
    await expect(harness.behavior.callRpc("session_writer_start", request)).rejects.toThrow(/Transport/);
    await expect(harness.behavior.callRpc("session_writer_start", request)).rejects.toThrow(/uncertain/);
    expect(spawn).toHaveBeenCalledTimes(2);
  });
});
