import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makePluginAgentConfigurationContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { WorkspaceStore } from "../src/store";
import { DEFAULT_BASE_REF, type SessionSnapshot } from "../src/contracts";
import type { PreparedRepository } from "../src/worktrees";

const projects = [
  {
    id: "proj_auth",
    kind: "standard" as const,
    name: "identity-service",
    gitRemoteUrl: "https://example.invalid/identity.git",
    createdAt: 1,
    updatedAt: 1,
    sources: [{
      id: "src_auth",
      projectId: "proj_auth",
      type: "local_path" as const,
      hostId: "host_local",
      path: "/repos/identity",
      isDefault: true,
      createdAt: 1,
      updatedAt: 1,
    }],
  },
  {
    id: "proj_gateway",
    kind: "standard" as const,
    name: "api-gateway",
    gitRemoteUrl: "https://example.invalid/gateway.git",
    createdAt: 1,
    updatedAt: 1,
    sources: [{
      id: "src_gateway",
      projectId: "proj_gateway",
      type: "local_path" as const,
      hostId: "host_local",
      path: "/repos/gateway",
      isDefault: true,
      createdAt: 1,
      updatedAt: 1,
    }],
  },
];

async function boundaryFixture(updateThread = true) {
  const available = [...projects];
  let mode: "okay" | "failed" = "okay";
  let readFailure = false;
  const repositories: PreparedRepository[] = [];
  const operations: Array<{ key: string; projectId: string; alias: string }> = [];
  let sessionId = "";
  let firstTools: string[] = [];
  let firstSkills: string[] = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "workspaces", agentSkillIds: ["multi-repo-workspaces"], experimental_hostEntry: true,
    sdk: {
      projects: { list: async () => available, create: async ({ name, source }) => {
        const created = { ...projects[0]!, id: "proj_workspaces", name, sources: [{ ...projects[0]!.sources[0]!, projectId: "proj_workspaces", path: source.path }] };
        available.push(created); return created;
      } },
      threads: { update: async () => { if (!updateThread) throw new Error("thread no longer exists"); }, spawn: async (input) => {
        const configuration = await harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({
          thread: { id: "thr_first" }, project: { id: input.projectId }, origin: { kind: null, pluginId: "workspaces" },
          host: { id: "host_local" }, environment: { path: `/sessions/${sessionId}`, workspaceProvisionType: "unmanaged" },
        }));
        firstTools = configuration.tools.map((tool) => tool.name); firstSkills = configuration.skills;
        return makeThreadResponse({ id: "thr_first", projectId: input.projectId });
      } },
    },
    experimental_callHostRpc: async ({ method, input }) => {
      if (method === "ensure_anchor") return { path: "/plugin/anchor" };
      if (method === "prepare_session") {
        const request = input as { sessionId: string; repositories: PreparedRepository[] };
        sessionId = request.sessionId;
        repositories.push(...request.repositories.map((repo) => ({ ...repo, baseCommit: "abc123", branch: `bb-workspace/${sessionId}/${repo.alias}`, worktreePath: `/sessions/${sessionId}/repos/${repo.alias}` })));
        return { rootPath: `/sessions/${sessionId}`, repositories };
      }
      if (method === "read_session") {
        if (readFailure) throw new Error("manifest temporarily unavailable");
        return { schemaVersion: 2, owner: "bb-plugin-workspaces", sessionId, workspaceName: "Boundary", instructions: "Trusted snapshot.", revision: repositories.length, repositories, operations };
      }
      if (method === "add_repository") {
        if (mode === "failed") throw new Error("host failed " + "x".repeat(1000));
        const request = input as { operationKey: string; repository: PreparedRepository };
        const repository = { ...request.repository, baseCommit: "def456", branch: `bb-workspace/${sessionId}/${request.repository.alias}`, worktreePath: `/sessions/${sessionId}/repos/${request.repository.alias}` };
        repositories.push(repository); operations.push({ key: request.operationKey, projectId: repository.projectId, alias: repository.alias });
        return { repository, manifestRevision: repositories.length };
      }
      throw new Error(`Unexpected ${method}`);
    },
  });
  await plugin(bb);
  const workspace = await harness.behavior.callRpc("workspace_create", { name: "Boundary", description: "", instructions: "Trusted snapshot.", repositories: [{ projectId: "proj_auth", alias: "identity" }, { projectId: "proj_gateway", alias: "gateway" }] }) as { id: string; revision: number };
  const session = await harness.behavior.callRpc("session_start", { workspaceId: workspace.id, expectedRevision: workspace.revision, hostId: "host_local", projectIds: ["proj_auth"], prompt: "\n  Boundary   check  \nInspect details", requestKey: "boundary-launch" }) as SessionSnapshot;
  return { bb, harness, session, firstTools, firstSkills, setReadFailure: (value: boolean) => { readFailure = value; }, setFailure: () => { mode = "failed"; } };
}

describe("Workspaces plugin server", () => {
  it("defaults a session to each repository's default branch and honours an explicit base", async () => {
    const fixture = await boundaryFixture();
    expect(fixture.session.repositories.map((repository) => repository.baseRef)).toEqual([DEFAULT_BASE_REF]);
    const added = await fixture.harness.behavior.callRpc("session_add_repository", {
      threadId: "thr_first", projectId: "proj_gateway", requestKey: "explicit-base-add", baseRef: "release/2026-09",
    }) as { session: SessionSnapshot };
    expect(added.session.repositories.find((repository) => repository.alias === "gateway")?.baseRef).toBe("release/2026-09");
  });

  it("rejects a base ref that could act as a git flag", async () => {
    const fixture = await boundaryFixture();
    await expect(fixture.harness.behavior.callRpc("session_add_repository", {
      threadId: "thr_first", projectId: "proj_gateway", requestKey: "unsafe-base-add", baseRef: "--upload-pack=touch",
    })).rejects.toThrow();
  });

  it("derives a session name and synchronizes later renames to the BB thread", async () => {
    const fixture = await boundaryFixture();
    expect(fixture.session.name).toBe("Boundary check");

    const renamed = await fixture.harness.behavior.callRpc("session_rename", { id: fixture.session.id, name: "Verify gateway rollout" }) as { session: SessionSnapshot; threadTitleUpdated: boolean };

    expect(renamed).toMatchObject({ session: { name: "Verify gateway rollout" }, threadTitleUpdated: true });
    expect(fixture.harness.inspection.sdk.callsTo("threads.update").at(-1)?.[0]).toEqual({
      threadId: "thr_first",
      title: "Boundary · Verify gateway rollout",
    });
  });

  it("keeps a renamed session when its BB thread no longer exists", async () => {
    const fixture = await boundaryFixture(false);
    const renamed = await fixture.harness.behavior.callRpc("session_rename", { id: fixture.session.id, name: "Local history label" }) as { session: SessionSnapshot; threadTitleUpdated: boolean };

    expect(renamed).toMatchObject({ session: { name: "Local history label" }, threadTitleUpdated: false });
    expect((await fixture.harness.behavior.callRpc("dashboard", null) as { sessions: SessionSnapshot[] }).sessions[0]?.name).toBe("Local history label");
  });
  it("exposes pending recovery through RPC then settles on replay", async () => {
    const fixture = await boundaryFixture();
    fixture.setReadFailure(true);
    const append = vi.spyOn(WorkspaceStore.prototype, "appendProvisionedRepository").mockImplementation(() => { throw new Error("database unavailable"); });
    try {
      const result = await fixture.harness.behavior.callRpc("session_add_repository", { threadId: "thr_first", projectId: "proj_gateway", requestKey: "boundary-pending" }) as { outcome: string; error: string };
      expect(result.outcome).toBe("pending"); expect(result.error).toMatch(/pending database recovery/);
      fixture.setReadFailure(false);
      const replay = await fixture.harness.behavior.callRpc("session_add_repository", { threadId: "thr_first", projectId: "proj_gateway", requestKey: "boundary-pending" });
      expect(replay).toMatchObject({ outcome: "provisioned", error: null });
    } finally { append.mockRestore(); }
  });
  it("selects workspace tools on the first dispatch before spawn returns and excludes other origins and owners", async () => {
    const fixture = await boundaryFixture();
    expect(fixture.firstTools).toContain("workspace_add_repository");
    expect(fixture.firstSkills).toContain("multi-repo-workspaces");
    for (const context of [
      { project: { id: "proj_auth" }, origin: { kind: null, pluginId: "workspaces" } },
      { project: { id: "proj_workspaces" }, origin: { kind: "fork" as const, pluginId: "side-chat" } },
      { project: { id: "proj_workspaces" }, origin: { kind: null, pluginId: null } },
    ]) expect(await fixture.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ ...context, thread: { id: "thr_unrelated" } }))).toMatchObject({ tools: [], skills: [] });
    await expect(fixture.harness.behavior.callAgentTool("workspace_add_repository", { repository: "gateway", reason: "Needed" }, { threadId: "thr_unrelated" })).rejects.toThrow(/workspace session/);
  });

  it("preserves failed outcomes and bounded errors in RPC and tool output", async () => {
    const fixture = await boundaryFixture();
    fixture.setFailure();
    const result = await fixture.harness.behavior.callRpc("session_add_repository", { threadId: "thr_first", projectId: "proj_gateway", requestKey: "boundary-failed" }) as { outcome: string; error: string };
    expect(result.outcome).toBe("failed"); expect(result.error).toHaveLength(500);
    const tool = fixture.harness.behavior.callAgentTool("workspace_add_repository", { repository: "gateway", reason: "Needed" }, { threadId: "thr_first" });
    await vi.waitFor(() => expect(fixture.harness.inspection.pendingInteractions).toHaveLength(1));
    fixture.harness.behavior.submitInteraction(fixture.harness.inspection.pendingInteractions[0]!.id, { action: "add-once" });
    expect(await tool).toMatch(/failed.*host failed/i);
  });

  it.each(["cancel", "malformed", "abort"])("preserves %s approval outcome without host mutation", async (action) => {
    const fixture = await boundaryFixture();
    const controller = new AbortController();
    const tool = fixture.harness.behavior.callAgentTool("workspace_add_repository", { repository: "gateway", reason: "Needed" }, { threadId: "thr_first", signal: controller.signal });
    await vi.waitFor(() => expect(fixture.harness.inspection.pendingInteractions).toHaveLength(1));
    if (action === "abort") controller.abort();
    else fixture.harness.behavior.submitInteraction(fixture.harness.inspection.pendingInteractions[0]!.id, action === "cancel" ? { action: "cancel" } : { action: "add-once", unexpected: true });
    expect(await tool).toMatch(action === "malformed" ? /failed/i : /cancelled/i);
    expect(fixture.harness.inspection.experimental_hostRpcCalls.filter((call) => call.method === "add_repository")).toHaveLength(0);
  });

  it("recovers approved pending RPC requests and normal listing journal rows", async () => {
    const fixture = await boundaryFixture();
    const store = new WorkspaceStore(fixture.bb.storage.database());
    store.beginExpansion({ sessionId: fixture.session.id, projectId: "proj_gateway", alias: "gateway", reason: "Needed", requester: "user", approvalMode: "manual", requestKey: "boundary-recover" });
    expect(await fixture.harness.behavior.callRpc("session_add_repository", { threadId: "thr_first", projectId: "proj_gateway", requestKey: "boundary-recover" })).toMatchObject({ outcome: "provisioned", error: null, added: true });
    fixture.bb.storage.database().prepare("UPDATE session_expansions SET outcome = 'pending' WHERE request_key = ?").run("boundary-recover");
    const dashboard = await fixture.harness.behavior.callRpc("dashboard", null) as { sessions: SessionSnapshot[] };
    expect(dashboard.sessions[0]?.expansions).toMatchObject([{ outcome: "provisioned" }]);
    fixture.bb.storage.database().prepare("UPDATE session_expansions SET outcome = 'pending' WHERE request_key = ?").run("boundary-recover");
    const cli = await fixture.harness.behavior.runCli(["sessions", "--json"]);
    expect(JSON.parse(cli.stdout!).at(0).expansions).toMatchObject([{ outcome: "provisioned" }]);
  });
  it("creates groups without mutating BB projects", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "workspaces",
      sdk: { projects: { list: async () => projects } },
      experimental_hostEntry: true,
    });
    await plugin(bb);

    const created = await harness.behavior.callRpc("workspace_create", {
      name: "Authentication",
      description: "Related auth services",
      instructions: "Run contract tests.",
      repositories: [
        { projectId: "proj_auth", alias: "identity" },
        { projectId: "proj_gateway", alias: "gateway" },
      ],
    });
    const dashboard = await harness.behavior.callRpc("dashboard", null) as {
      workspaces: unknown[];
      projects: Array<{ id: string }>;
    };

    expect(created).toMatchObject({ name: "Authentication", revision: 1 });
    expect(dashboard.workspaces).toHaveLength(1);
    expect(dashboard.projects.map((project: { id: string }) => project.id)).toEqual(["proj_auth", "proj_gateway"]);
    expect(harness.inspection.sdk.callsTo("projects.delete")).toHaveLength(0);
  });

  it("keeps reconciliation failures single-line and bounded in dashboard and CLI session output", async () => {
    const availableProjects = [...projects];
    const failure = `manifest unavailable\n${"x".repeat(1_000)}`;
    const { bb, harness } = createFakePluginHost({
      pluginId: "workspaces",
      sdk: {
        projects: {
          list: async () => availableProjects,
          create: async ({ name, source }) => {
            const created = {
              ...projects[0]!, id: "proj_workspaces", name,
              sources: [{ ...projects[0]!.sources[0]!, id: "src_workspaces", projectId: "proj_workspaces", hostId: source.hostId, path: source.path }],
            };
            availableProjects.push(created);
            return created;
          },
        },
        threads: { spawn: async () => makeThreadResponse({ id: "thr_reconciliation", projectId: "proj_workspaces" }) },
      },
      experimental_hostEntry: true,
      experimental_callHostRpc: async ({ method, input }) => {
        if (method === "ensure_anchor") return { path: "/plugin/anchor" };
        if (method === "prepare_session") {
          const request = input as { sessionId: string; repositories: Array<{ projectId: string; alias: string; sourcePath: string; baseRef: string }> };
          return {
            rootPath: `/plugin-data/sessions/${request.sessionId}`,
            repositories: request.repositories.map((repository) => ({
              ...repository, baseCommit: `commit-${repository.alias}`,
              branch: `bb-workspace/${request.sessionId}/${repository.alias}`,
              worktreePath: `/plugin-data/sessions/${request.sessionId}/repos/${repository.alias}`,
            })),
          };
        }
        if (method === "read_session") throw new Error(failure);
        throw new Error(`Unexpected host method: ${method}`);
      },
    });
    await plugin(bb);
    const workspace = await harness.behavior.callRpc("workspace_create", {
      name: "Authentication", description: "", instructions: "", repositories: [{ projectId: "proj_auth", alias: "identity" }],
    }) as { id: string; revision: number };
    await harness.behavior.callRpc("session_start", {
      workspaceId: workspace.id, expectedRevision: workspace.revision, hostId: "host_local",
      projectIds: ["proj_auth"], prompt: "Inspect the identity service.", requestKey: "reconciliation-session-1",
    });

    const dashboard = await harness.behavior.callRpc("dashboard", null) as { sessions: Array<{ threadId: string | null; error: string | null }> };
    const sessionError = dashboard.sessions.find((session) => session.threadId === "thr_reconciliation")?.error;
    expect(sessionError).toHaveLength(500);
    expect(sessionError).toMatch(/^manifest unavailable x+/);
    expect(sessionError).not.toMatch(/[\r\n]/);

    const cli = await harness.behavior.runCli(["sessions"]);
    expect(cli.stdout).toContain(`ERROR: ${sessionError}`);
    expect(cli.stdout).not.toMatch(/[\r\n]/);
  });

  it("prepares selected repos and launches one thread at the common root", async () => {
    const hostCalls: Array<{ method: string; input: unknown }> = [];
    const availableProjects = [...projects];
    const { bb, harness } = createFakePluginHost({
      pluginId: "workspaces",
      sdk: {
        projects: {
          list: async () => availableProjects,
          create: async ({ name, source }) => {
            const created = {
              id: "proj_workspaces",
              kind: "standard" as const,
              name,
              gitRemoteUrl: "https://example.invalid/workspaces.git",
              createdAt: 1,
              updatedAt: 1,
              sources: [{
                id: "src_workspaces",
                projectId: "proj_workspaces",
                type: "local_path" as const,
                hostId: source.hostId,
                path: source.path,
                isDefault: true,
                createdAt: 1,
                updatedAt: 1,
              }],
            };
            availableProjects.push(created);
            return created;
          },
        },
        threads: { spawn: async () => makeThreadResponse({ id: "thr_multi", projectId: "proj_auth" }) },
      },
      experimental_hostEntry: true,
      experimental_callHostRpc: async ({ method, input }) => {
        hostCalls.push({ method, input });
        if (method === "cleanup_session") return { cleaned: true };
        if (method === "ensure_anchor") return { path: "/plugin/anchor" };
        if (method !== "prepare_session") throw new Error(`Unexpected host method: ${method}`);
        const request = input as {
          sessionId: string;
          repositories: Array<{ projectId: string; alias: string; sourcePath: string; baseRef: string }>;
        };
        return {
          rootPath: `/plugin-data/sessions/${request.sessionId}`,
          repositories: request.repositories.map((repository) => ({
            ...repository,
            baseCommit: `commit-${repository.alias}`,
            branch: `bb-workspace/${request.sessionId}/${repository.alias}`,
            worktreePath: `/plugin-data/sessions/${request.sessionId}/repos/${repository.alias}`,
          })),
        };
      },
    });
    await plugin(bb);
    const workspace = await harness.behavior.callRpc("workspace_create", {
      name: "Authentication",
      description: "",
      instructions: "Read each repo's AGENTS.md.",
      repositories: [
        { projectId: "proj_auth", alias: "identity" },
        { projectId: "proj_gateway", alias: "gateway" },
      ],
    }) as { id: string; revision: number };

    const session = await harness.behavior.callRpc("session_start", {
      workspaceId: workspace.id,
      expectedRevision: workspace.revision,
      hostId: "host_local",
      projectIds: ["proj_gateway", "proj_auth"],
      prompt: "Change the auth contract in both services.",
      name: "Auth contract rollout",
      requestKey: "request-auth-contract",
      providerId: "acp-devin",
      model: "swe-2-high",
      permissionMode: "accept-edits",
    }) as { id: string; name: string; state: string; threadId: string };
    const retried = await harness.behavior.callRpc("session_start", {
      workspaceId: workspace.id,
      expectedRevision: workspace.revision,
      hostId: "host_local",
      projectIds: ["proj_gateway", "proj_auth"],
      prompt: "Change the auth contract in both services.",
      name: "Ignored retry name",
      requestKey: "request-auth-contract",
      providerId: "acp-devin",
      model: "swe-2-high",
      permissionMode: "accept-edits",
    }) as { id: string };

    expect(session).toMatchObject({
      name: "Auth contract rollout",
      state: "active",
      threadId: "thr_multi",
      ownerProjectId: "proj_workspaces",
      rootPath: expect.stringContaining("/sessions/"),
    });
    expect(harness.inspection.sdk.callsTo("threads.spawn")[0]?.[0]).toMatchObject({
      projectId: "proj_workspaces",
      prompt: "Change the auth contract in both services.",
      title: "Authentication · Auth contract rollout",
      providerId: "acp-devin",
      model: "swe-2-high",
      permissionMode: "accept-edits",
      environment: {
        type: "host",
        hostId: "host_local",
        workspace: { type: "unmanaged", path: expect.stringContaining("/sessions/") },
      },
    });
    expect(retried.id).toBe(session.id);
    expect(hostCalls.filter((call) => call.method === "prepare_session")).toHaveLength(1);
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
    expect((await harness.behavior.callRpc("dashboard", null) as { projects: Array<{ id: string }> }).projects
      .map((project) => project.id)).toEqual(["proj_auth", "proj_gateway"]);
    await expect(harness.behavior.callRpc("workspace_update", {
      id: workspace.id,
      expectedRevision: workspace.revision,
      draft: {
        name: "Authentication",
        description: "",
        instructions: "Read each repo's AGENTS.md.",
        repositories: [
          { projectId: "proj_auth", alias: "identity" },
          { projectId: "proj_workspaces", alias: "workspaces" },
        ],
      },
    })).rejects.toThrow("cannot be added to a workspace");

    await harness.behavior.callRpc("session_archive", { id: session.id });
    const cleaned = await harness.behavior.callRpc("session_cleanup", { id: session.id });
    expect(cleaned).toMatchObject({ state: "cleaned", rootPath: null });
    expect(hostCalls.find((call) => call.method === "cleanup_session")?.input).toMatchObject({
      sessionId: session.id,
      repositories: [
        { projectId: "proj_auth", alias: "identity", baseCommit: "commit-identity" },
        { projectId: "proj_gateway", alias: "gateway", baseCommit: "commit-gateway" },
      ],
    });
  });

  it("does not prepare a session when a deleted owner recovers to a selected repository", async () => {
    const hostCalls: string[] = [];
    const recoveredProject = {
      id: "proj_recovered",
      kind: "standard" as const,
      name: "workspace-anchor",
      gitRemoteUrl: "https://example.invalid/workspace-anchor.git",
      createdAt: 1,
      updatedAt: 1,
      sources: [{
        id: "src_recovered",
        projectId: "proj_recovered",
        type: "local_path" as const,
        hostId: "host_local",
        path: "/repos/recovered",
        isDefault: true,
        createdAt: 1,
        updatedAt: 1,
      }],
    };
    const availableProjects = [...projects, recoveredProject];
    const { bb, harness } = createFakePluginHost({
      pluginId: "workspaces",
      sdk: {
        projects: {
          list: async () => availableProjects,
          create: async ({ name, source }) => {
            const created = {
              id: "proj_deleted",
              kind: "standard" as const,
              name,
              gitRemoteUrl: "https://example.invalid/workspaces.git",
              createdAt: 1,
              updatedAt: 1,
              sources: [{
                id: "src_deleted",
                projectId: "proj_deleted",
                type: "local_path" as const,
                hostId: source.hostId,
                path: source.path,
                isDefault: true,
                createdAt: 1,
                updatedAt: 1,
              }],
            };
            availableProjects.push(created);
            return created;
          },
        },
        threads: { spawn: async () => makeThreadResponse({ id: "thr_owner", projectId: "proj_deleted" }) },
      },
      experimental_hostEntry: true,
      experimental_callHostRpc: async ({ method, input }) => {
        hostCalls.push(method);
        if (method === "ensure_anchor") return { path: "/plugin/anchor" };
        if (method !== "prepare_session") throw new Error(`Unexpected host method: ${method}`);
        const request = input as { sessionId: string; repositories: Array<{ projectId: string; alias: string; sourcePath: string; baseRef: string }> };
        return {
          rootPath: `/plugin-data/sessions/${request.sessionId}`,
          repositories: request.repositories.map((repository) => ({
            ...repository,
            baseCommit: `commit-${repository.alias}`,
            branch: `bb-workspace/${request.sessionId}/${repository.alias}`,
            worktreePath: `/plugin-data/sessions/${request.sessionId}/repos/${repository.alias}`,
          })),
        };
      },
    });
    await plugin(bb);
    const workspace = await harness.behavior.callRpc("workspace_create", {
      name: "Authentication",
      description: "",
      instructions: "Read each repo's AGENTS.md.",
      repositories: [
        { projectId: "proj_auth", alias: "identity" },
        { projectId: "proj_recovered", alias: "anchor" },
      ],
    }) as { id: string; revision: number };

    await harness.behavior.callRpc("session_start", {
      workspaceId: workspace.id,
      expectedRevision: workspace.revision,
      hostId: "host_local",
      projectIds: ["proj_auth"],
      prompt: "Start with identity.",
      requestKey: "request-initial-owner",
    });
    availableProjects.splice(availableProjects.findIndex((project) => project.id === "proj_deleted"), 1);
    recoveredProject.sources[0]!.path = "/plugin/anchor";

    await expect(harness.behavior.callRpc("session_start", {
      workspaceId: workspace.id,
      expectedRevision: workspace.revision,
      hostId: "host_local",
      projectIds: ["proj_recovered"],
      prompt: "Work on the anchor.",
      requestKey: "request-recovered-owner",
    })).rejects.toThrow("cannot be selected as a repository");
    expect(hostCalls.filter((method) => method === "prepare_session")).toHaveLength(1);
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  });

  it("expands only a workspace session through approved, alias-resolved requests", async () => {
    const billing = {
      ...projects[1]!,
      id: "proj_billing",
      name: "billing-service",
      gitRemoteUrl: "https://example.invalid/billing.git",
      sources: [{
        ...projects[1]!.sources[0]!,
        id: "src_billing",
        projectId: "proj_billing",
        path: "/repos/billing",
      }],
    };
    const availableProjects = [...projects, billing];
    const hostCalls: Array<{ method: string; input: unknown }> = [];
    let sessionId = "";
    const repositories: Array<{
      projectId: string; alias: string; sourcePath: string; baseRef: string;
      baseCommit: string; branch: string; worktreePath: string;
    }> = [];
    const { bb, harness } = createFakePluginHost({
      pluginId: "workspaces",
      agentSkillIds: ["multi-repo-workspaces"],
      sdk: {
        projects: {
          list: async () => availableProjects,
          create: async ({ name, source }) => {
            const workspaceProject = {
              ...projects[0]!, id: "proj_workspaces", name,
              sources: [{ ...projects[0]!.sources[0]!, id: "src_workspaces", projectId: "proj_workspaces", hostId: source.hostId, path: source.path }],
            };
            availableProjects.push(workspaceProject);
            return workspaceProject;
          },
        },
        threads: { spawn: async () => makeThreadResponse({ id: "thr_workspace", projectId: "proj_workspaces" }) },
      },
      experimental_hostEntry: true,
      experimental_callHostRpc: async ({ method, input }) => {
        hostCalls.push({ method, input });
        if (method === "ensure_anchor") return { path: "/plugin/anchor" };
        if (method === "prepare_session") {
          const request = input as { sessionId: string; repositories: Array<{ projectId: string; alias: string; sourcePath: string; baseRef: string }> };
          sessionId = request.sessionId;
          repositories.push(...request.repositories.map((repository) => ({
            ...repository, baseCommit: `commit-${repository.alias}`,
            branch: `bb-workspace/${request.sessionId}/${repository.alias}`,
            worktreePath: `/plugin-data/sessions/${request.sessionId}/repos/${repository.alias}`,
          })));
          return { rootPath: `/plugin-data/sessions/${request.sessionId}`, repositories };
        }
        if (method === "read_session") return {
          schemaVersion: 2, owner: "bb-plugin-workspaces", sessionId,
          workspaceName: "Services", instructions: "Coordinate the services.", revision: repositories.length,
          repositories, operations: [],
        };
        if (method === "add_repository") {
          const request = input as { operationKey: string; repository: { projectId: string; alias: string; sourcePath: string; baseRef: string } };
          const repository = {
            ...request.repository, baseCommit: `commit-${request.repository.alias}`,
            branch: `bb-workspace/${sessionId}/${request.repository.alias}`,
            worktreePath: `/plugin-data/sessions/${sessionId}/repos/${request.repository.alias}`,
          };
          repositories.push(repository);
          return { repository, manifestRevision: repositories.length };
        }
        throw new Error(`Unexpected host method: ${method}`);
      },
    });
    await plugin(bb);

    expect(harness.inspection.registrations.agentTools.some((tool) => tool.name === "workspace_add_repository")).toBe(true);
    const workspace = await harness.behavior.callRpc("workspace_create", {
      name: "Services", description: "", instructions: "Coordinate the services.",
      repositories: [
        { projectId: "proj_auth", alias: "identity" },
        { projectId: "proj_gateway", alias: "gateway" },
        { projectId: "proj_billing", alias: "billing" },
      ],
    }) as { id: string; revision: number };
    await harness.behavior.callRpc("session_start", {
      workspaceId: workspace.id, expectedRevision: workspace.revision, hostId: "host_local",
      projectIds: ["proj_auth"], prompt: "Update the identity contract.", requestKey: "workspace-session-1",
    });

    const configuration = await harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({
        thread: { id: "thr_workspace" },
        project: { id: "proj_workspaces", name: "🧩 Workspaces" },
        origin: { kind: null, pluginId: "workspaces" },
      }),
    );
    expect(configuration.tools.map((tool) => tool.name)).toContain("workspace_add_repository");
    expect(configuration.skills).toEqual(["multi-repo-workspaces"]);
    await expect(harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({
        thread: { id: "thr_unrelated" },
        origin: { kind: "fork", pluginId: "side-chat" },
      }),
    )).resolves.toMatchObject({ tools: [], skills: [] });

    const options = await harness.behavior.callRpc("session_expansion_options", { threadId: "thr_workspace" }) as {
      repositories: Array<{ projectId: string; alias: string; sourcePath: string }>;
    };
    expect(options.repositories).toEqual(expect.arrayContaining([
      expect.objectContaining({ projectId: "proj_gateway", alias: "gateway", sourcePath: "/repos/gateway" }),
      expect.objectContaining({ projectId: "proj_billing", alias: "billing", sourcePath: "/repos/billing" }),
    ]));

    const toolRequest = harness.behavior.callAgentTool("workspace_add_repository", {
      repository: "gateway", reason: "The API gateway must consume the identity contract change.",
    }, { threadId: "thr_workspace" });
    await vi.waitFor(() => expect(harness.inspection.pendingInteractions).toHaveLength(1));
    const interaction = harness.inspection.pendingInteractions[0]!;
    expect(interaction).toMatchObject({
      threadId: "thr_workspace", rendererId: "workspace-add-repository",
      payload: { repositoryAlias: "gateway", reason: "The API gateway must consume the identity contract change." },
    });
    harness.behavior.submitInteraction(interaction.id, { action: "add-and-auto" });
    await expect(toolRequest).resolves.toBe(`Repository gateway is ready at /plugin-data/sessions/${sessionId}/repos/gateway. Re-read session.json and continue there.`);
    expect(hostCalls.filter((call) => call.method === "add_repository")).toContainEqual({
      method: "add_repository",
      input: {
        sessionId,
        operationKey: expect.stringMatching(/^agent-/),
        instructions: "Coordinate the services.",
        repository: { projectId: "proj_gateway", alias: "gateway", sourcePath: "/repos/gateway", baseRef: DEFAULT_BASE_REF },
      },
    });

    const manuallyAdded = await harness.behavior.callRpc("session_add_repository", {
      threadId: "thr_workspace", projectId: "proj_billing", requestKey: "manual-billing-1",
    }) as {
      added: boolean; alias: string; worktreePath: string | null; policy: string;
      session: { expansions: Array<{ reason: string }> };
    };
    expect(manuallyAdded).toMatchObject({
      added: true, alias: "billing", worktreePath: `/plugin-data/sessions/${sessionId}/repos/billing`, policy: "auto",
    });
    expect(manuallyAdded.session.expansions.at(-1)?.reason).toBe("Added from the Repositories panel");
    expect(hostCalls.filter((call) => call.method === "add_repository")).toContainEqual({
      method: "add_repository",
      input: {
        sessionId,
        operationKey: "manual-billing-1",
        instructions: "Coordinate the services.",
        repository: { projectId: "proj_billing", alias: "billing", sourcePath: "/repos/billing", baseRef: DEFAULT_BASE_REF },
      },
    });
  });
});
