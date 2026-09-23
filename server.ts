import { randomUUID } from "node:crypto";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { baseRefSchema, DEFAULT_BASE_REF, EXPANSION_ERROR_MAX_CHARS, MAX_BASE_REFS, expansionApprovalResponseSchema, workspaceDraftSchema } from "./src/contracts";
import { hostContract } from "./src/host-contract";
import { SessionExpansionService, type ExpansionResult } from "./src/session-expansion";
import { WORKSPACE_MIGRATIONS, WorkspaceStore } from "./src/store";
import { ensureWorkspaceProject, renameStoredWorkspaceProject, type ProjectRecord } from "./src/workspace-project";

const repositorySchema = z.object({ projectId: z.string(), alias: z.string(), ordinal: z.number().int() });
const workspaceSchema = z.object({
  id: z.string(), name: z.string(), description: z.string(), instructions: z.string(),
  revision: z.number().int(), pinned: z.boolean(), archivedAt: z.number().nullable(),
  createdAt: z.number(), updatedAt: z.number(), repositories: z.array(repositorySchema),
});
const sessionRepositorySchema = z.object({
  projectId: z.string(), alias: z.string(), sourceId: z.string().optional(), sourcePath: z.string().optional(),
  baseRef: z.string().optional(), baseCommit: z.string().optional(), branch: z.string().optional(), worktreePath: z.string().optional(),
});
const sessionExpansionSchema = z.object({
  id: z.string(), sessionId: z.string(), projectId: z.string(), alias: z.string(), reason: z.string(),
  requester: z.enum(["agent", "user", "reconcile"]), approvalMode: z.enum(["once", "auto", "manual", "reconciled"]), baseRef: z.string().nullable(),
  outcome: z.enum(["pending", "cancelled", "failed", "provisioned", "superseded"]), requestKey: z.string(), error: z.string().max(EXPANSION_ERROR_MAX_CHARS).nullable(),
  phase: z.enum(["awaiting-approval", "approved", "provisioning", "uncertain"]).nullable(),
  createdAt: z.number().int(), updatedAt: z.number().int(),
});
const sessionSchema = z.object({
  id: z.string(), name: z.string().nullable(), workspaceId: z.string().nullable(), workspaceName: z.string(), workspaceRevision: z.number().int(),
  instructions: z.string(), repositories: z.array(sessionRepositorySchema), initialRepositories: z.array(sessionRepositorySchema),
  expansionPolicy: z.enum(["ask", "auto"]), expansions: z.array(sessionExpansionSchema), manifestRevision: z.number().int(),
  state: z.enum(["draft", "preparing", "active", "failed", "archived", "cleaned"]),
  hostId: z.string().nullable(), rootPath: z.string().nullable(), ownerProjectId: z.string().nullable(),
  threadId: z.string().nullable(), error: z.string().nullable(), createdAt: z.number(), updatedAt: z.number(),
});
const projectSchema = z.object({
  id: z.string(), name: z.string(), gitRemoteUrl: z.string().nullable(),
  sources: z.array(z.object({ id: z.string(), hostId: z.string(), path: z.string(), isDefault: z.boolean() })),
});
const expansionOptionSchema = z.object({
  projectId: z.string(), alias: z.string(), projectName: z.string(), sourcePath: z.string(), member: z.boolean(),
}).strict();
const expansionResultSchema = z.object({
  outcome: z.enum(["pending", "cancelled", "failed", "provisioned", "superseded"]),
  error: z.string().max(EXPANSION_ERROR_MAX_CHARS).nullable(),
  added: z.boolean(), alias: z.string(), worktreePath: z.string().nullable(),
  policy: z.enum(["ask", "auto"]), session: sessionSchema,
}).strict();

export const rpcContract = defineRpcContract({
  dashboard: { input: z.null(), output: z.object({ workspaces: z.array(workspaceSchema), sessions: z.array(sessionSchema), projects: z.array(projectSchema) }) },
  workspace_create: { input: workspaceDraftSchema, output: workspaceSchema },
  workspace_update: { input: z.object({ id: z.string(), expectedRevision: z.number().int(), draft: workspaceDraftSchema }), output: workspaceSchema },
  workspace_set_pinned: { input: z.object({ id: z.string(), expectedRevision: z.number().int(), pinned: z.boolean() }), output: workspaceSchema },
  workspace_set_archived: { input: z.object({ id: z.string(), expectedRevision: z.number().int(), archived: z.boolean() }), output: workspaceSchema },
  workspace_remove: { input: z.object({ id: z.string(), expectedRevision: z.number().int() }), output: z.object({ removed: z.literal(true) }) },
  session_start: {
    input: z.object({
      workspaceId: z.string(), expectedRevision: z.number().int(), hostId: z.string(),
      projectIds: z.array(z.string()).min(1).max(20), prompt: z.string().trim().min(1).max(100_000),
      name: z.string().trim().min(1).max(80).optional(),
      requestKey: z.string().min(8).max(200),
      bases: z.record(z.string(), baseRefSchema).optional(),
      providerId: z.string().trim().min(1).optional(),
      model: z.string().trim().min(1).optional(),
      permissionMode: z.enum(["accept-edits", "auto", "full"]).optional(),
    }),
    output: sessionSchema,
  },
  repository_bases: {
    input: z.object({ hostId: z.string(), projectIds: z.array(z.string()).min(1).max(20), fetch: z.boolean() }).strict(),
    output: z.object({
      repositories: z.array(z.object({
        projectId: z.string(), defaultBase: z.string(), currentBranch: z.string().nullable(),
        currentCommit: z.string(), refs: z.array(z.string()).max(MAX_BASE_REFS), fetchError: z.string().nullable(),
      }).strict()),
    }).strict(),
  },
  session_archive: { input: z.object({ id: z.string() }), output: sessionSchema },
  session_rename: {
    input: z.object({ id: z.string(), name: z.string().trim().min(1).max(80) }).strict(),
    output: z.object({ session: sessionSchema, threadTitleUpdated: z.boolean() }).strict(),
  },
  session_cleanup: { input: z.object({ id: z.string() }), output: sessionSchema },
  session_repository_status: {
    input: z.object({ sessionId: z.string(), projectId: z.string() }),
    output: z.object({
      clean: z.boolean(), head: z.string(), aheadOfBase: z.boolean(),
      changedFiles: z.array(z.object({ path: z.string(), status: z.enum(["added", "modified", "deleted", "renamed", "untracked", "conflicted"]) })),
    }),
  },
  session_expansion_options: {
    input: z.object({ threadId: z.string() }).strict(),
    output: z.object({ session: sessionSchema, repositories: z.array(expansionOptionSchema) }).strict(),
  },
  session_add_repository: {
    input: z.object({
      threadId: z.string(), projectId: z.string(), requestKey: z.string().min(8).max(200), baseRef: baseRefSchema.optional(),
    }).strict(),
    output: expansionResultSchema,
  },
});

const WORKSPACES_CHANGED = "workspaces-changed";
const SESSION_RECONCILIATION_ERROR_MAX_CHARS = 500;

function deriveSessionName(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/).find((line) => line.trim()) ?? prompt;
  return firstLine.trim().replace(/\s+/g, " ").slice(0, 80);
}

export default async function plugin(bb: BbPluginApi) {
  const database = bb.storage.database();
  bb.storage.migrate(database, WORKSPACE_MIGRATIONS);
  const store = new WorkspaceStore(database);
  const host = bb.hosts.experimental_client({ contract: hostContract });
  const changed = () => bb.realtime.publish(WORKSPACES_CHANGED, { at: Date.now() });

  function toProjectRecord(project: Awaited<ReturnType<typeof bb.sdk.projects.create>>): ProjectRecord {
    return {
      id: project.id,
      name: project.name,
      sources: project.sources.map((source) => ({ id: source.id, hostId: source.hostId, path: source.path, isDefault: source.isDefault })),
    };
  }

  async function allProjects() {
    const rows = await bb.sdk.projects.list();
    return rows.map((project) => ({
      id: project.id, name: project.name, gitRemoteUrl: project.gitRemoteUrl,
      sources: project.sources.map((source) => ({ id: source.id, hostId: source.hostId, path: source.path, isDefault: source.isDefault })),
    }));
  }

  async function projects() {
    const workspaceProjectId = store.getWorkspaceProjectId();
    return (await allProjects()).filter((project) => project.id !== workspaceProjectId);
  }

  async function assertWorkspaceMembership(draft: { repositories: Array<{ projectId: string }> }) {
    const workspaceProjectId = store.getWorkspaceProjectId();
    if (workspaceProjectId && draft.repositories.some((repository) => repository.projectId === workspaceProjectId)) {
      throw new Error("The synthetic Workspaces project cannot be added to a workspace");
    }
    const projectIds = new Set((await projects()).map((project) => project.id));
    for (const repository of draft.repositories) {
      if (!projectIds.has(repository.projectId)) throw new Error(`BB project ${repository.projectId} was not found`);
    }
  }

  const workspaceProjectDeps = {
    getStoredProjectId: () => store.getWorkspaceProjectId(),
    setStoredProjectId: (id: string) => store.setWorkspaceProjectId(id),
    ensureAnchor: (hostId: string) => host.call("ensure_anchor", {}, { hostId }),
    getProject: async (id: string) => {
      try {
        return toProjectRecord(await bb.sdk.projects.get({ projectId: id }));
      } catch {
        return null;
      }
    },
    listProjects: async () => (await allProjects()).map((project) => ({ id: project.id, name: project.name, sources: project.sources })),
    createProject: async (input: { name: string; source: { type: "local_path"; hostId: string; path: string } }) => toProjectRecord(await bb.sdk.projects.create(input)),
    addSource: async (projectId: string, input: { type: "local_path"; hostId: string; path: string }) => { await bb.sdk.projects.sources.add({ projectId, ...input }); },
    updateProjectName: async (projectId: string, name: string) => { await bb.sdk.projects.update({ projectId, name }); },
  };

  try {
    await renameStoredWorkspaceProject(workspaceProjectDeps);
  } catch (cause) {
    bb.log.warn(`Workspaces could not rename its legacy synthetic project: ${cause instanceof Error ? cause.message : String(cause)}`);
  }

  async function workspaceProject(hostId: string): Promise<string> {
    return ensureWorkspaceProject(workspaceProjectDeps, hostId);
  }

  const expansion = new SessionExpansionService({
    store,
    listProjects: projects,
    requestApproval: async (payload, signal) => {
      const session = store.getSession(payload.sessionId);
      if (!session.threadId) throw new Error("Session thread is unavailable");
      const response = await bb.ui.requestInput({
        threadId: session.threadId,
        rendererId: "workspace-add-repository",
        title: `Add ${payload.repositoryAlias} to ${payload.workspaceName}?`,
        payload,
      }, { signal });
      if (response.outcome === "cancelled") return { action: "cancel" };
      return expansionApprovalResponseSchema.parse(response.value);
    },
    addRepository: (input, hostId) => host.call("add_repository", input, { hostId }),
    readSession: (sessionId, hostId) => host.call("read_session", { sessionId }, { hostId }),
    publishChanged: async () => { changed(); },
    reportError: ({ operation, sessionId, error }) => {
      const context = JSON.stringify({ operation, sessionId: sessionId.slice(0, 200), error: error.slice(0, 1_000) });
      bb.log.error(`Workspaces notification failed: ${context}`);
    },
  });

  function resultWithSession(result: ExpansionResult) {
    const { session } = result;
    return {
      added: result.added,
      outcome: result.outcome,
      error: result.error,
      alias: result.alias,
      worktreePath: result.added ? session.repositories.find((repository) => repository.alias === result.alias)?.worktreePath ?? null : null,
      policy: result.policy,
      session,
    };
  }

  async function reconcileActiveSessionsForListing() {
    const results = await expansion.reconcileActiveSessions();
    const errors = new Map<string, string>();
    for (const result of results) {
      if (!result.error) continue;
      errors.set(result.sessionId, sanitizeReconciliationError(result.error));
      bb.log.warn(`Workspaces session reconciliation failed: ${JSON.stringify({ sessionId: result.sessionId.slice(0, 200), error: result.error.slice(0, 1_000) })}`);
    }
    return errors;
  }

  function sanitizeReconciliationError(error: string): string {
    const normalized = error.replace(/\s+/g, " ").trim();
    return (normalized || "Unknown reconciliation error").slice(0, SESSION_RECONCILIATION_ERROR_MAX_CHARS);
  }

  function sessionsWithReconciliationErrors(errors: ReadonlyMap<string, string>) {
    return store.listSessions().map((session) => ({ ...session, error: errors.get(session.id) ?? session.error }));
  }

  bb.agents.registerTool({
    name: "workspace_add_repository",
    description: "Request another repository from this thread's saved multi-repository workspace.",
    instructions: "Use only when the task requires a workspace repository that is not already in session.json. Explain the concrete dependency in reason.",
    presentation: {
      label: { pending: "Requesting workspace repository", completed: "Requested workspace repository" },
      suppress: true,
    },
    parameters: z.object({
      repository: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/),
      reason: z.string().trim().min(1).max(2_000),
    }).strict(),
    async execute({ repository, reason }, { threadId, signal }) {
      const result = resultWithSession(await expansion.requestFromAgent({
        threadId, alias: repository, reason, requestKey: `agent-${randomUUID()}`, signal,
      }));
      if (result.outcome === "provisioned") return `Repository ${result.alias} is ready at ${result.worktreePath}. Re-read session.json and continue there.`;
      if (result.outcome === "superseded") return `Repository ${result.alias} is already ready at ${result.worktreePath}; another request completed the addition. Re-read session.json and continue there.`;
      if (result.outcome === "cancelled") return "Repository request was cancelled; the session was not changed.";
      if (result.outcome === "pending") return `Repository ${result.alias} is pending recovery. Refresh the Repositories panel before proceeding.${result.error ? ` ${result.error}` : ""}`;
      return `Repository ${result.alias} request failed: ${result.error ?? "Unknown error"}`;
    },
  });

  bb.agents.configure((context) => {
    const storedSession = store.getSessionByThreadId(context.thread.id);
    // spawn can resolve first-dispatch configuration before returning the thread ID.
    const bootstrap = context.project.id === store.getWorkspaceProjectId()
      && context.environment.workspaceProvisionType === "unmanaged"
      && store.listSessions().some((session) => session.state === "preparing" && session.threadId === null
        && session.ownerProjectId === context.project.id && session.hostId === context.host.id
        && session.rootPath !== null && session.rootPath === context.environment.path);
    if (context.origin.pluginId !== "workspaces" || context.origin.kind !== null || (!storedSession && !bootstrap)) {
      return { tools: [], skills: [] };
    }
    return {
      tools: ["workspace_add_repository"],
      skills: ["multi-repo-workspaces"],
      instructions: "This is an append-only Workspaces session. If a current workspace member is required but absent from session.json, request it with workspace_add_repository.",
    };
  });

  bb.rpc.register(rpcContract, {
    dashboard: async () => {
      const errors = await reconcileActiveSessionsForListing();
      return { workspaces: store.list(true), sessions: sessionsWithReconciliationErrors(errors), projects: await projects() };
    },
    workspace_create: async (draft) => {
      await assertWorkspaceMembership(draft);
      const workspace = store.create(draft); changed(); return workspace;
    },
    workspace_update: async ({ id, expectedRevision, draft }) => { await assertWorkspaceMembership(draft); const workspace = store.update(id, expectedRevision, draft); changed(); return workspace; },
    workspace_set_pinned: async ({ id, expectedRevision, pinned }) => { const workspace = store.setPinned(id, expectedRevision, pinned); changed(); return workspace; },
    workspace_set_archived: async ({ id, expectedRevision, archived }) => { const workspace = store.setArchived(id, expectedRevision, archived); changed(); return workspace; },
    workspace_remove: async ({ id, expectedRevision }) => { store.remove(id, expectedRevision); changed(); return { removed: true as const }; },
    session_start: async ({ workspaceId, expectedRevision, hostId, projectIds, prompt, name, requestKey, bases, providerId, model, permissionMode }) => {
      if ((providerId === undefined) !== (model === undefined)) {
        throw new Error("Explicit session routing requires both providerId and model");
      }
      const existing = store.getSessionByRequestKey(requestKey);
      if (existing) return existing;
      const workspace = store.get(workspaceId);
      if (workspace.revision !== expectedRevision) throw new Error("Workspace revision is stale");
      const selectedSet = new Set(projectIds);
      if (selectedSet.size !== projectIds.length) throw new Error("Select each repository only once");
      const selected = workspace.repositories.filter((repository) => selectedSet.has(repository.projectId));
      if (selected.length !== selectedSet.size) throw new Error("One or more selected projects are not in this workspace");
      const ownerProjectId = store.getWorkspaceProjectId();
      if (ownerProjectId && selected.some((repository) => repository.projectId === ownerProjectId)) {
        throw new Error("The synthetic Workspaces project cannot be selected as a repository");
      }
      const available = new Map((await allProjects()).map((project) => [project.id, project]));
      const resolved = selected.map((repository) => {
        const project = available.get(repository.projectId);
        if (!project) throw new Error(`BB project ${repository.projectId} was not found`);
        const source = project.sources.find((candidate) => candidate.hostId === hostId && candidate.isDefault)
          ?? project.sources.find((candidate) => candidate.hostId === hostId);
        if (!source) throw new Error(`${project.name} has no source on the selected host`);
        return { ...repository, sourceId: source.id, sourcePath: source.path, baseRef: bases?.[repository.projectId] ?? DEFAULT_BASE_REF };
      });
      const workspaceOwnerProjectId = await workspaceProject(hostId);
      if (selected.some((repository) => repository.projectId === workspaceOwnerProjectId)) {
        throw new Error("The synthetic Workspaces project cannot be selected as a repository");
      }
      const sessionName = name ?? deriveSessionName(prompt);
      let session = store.createSessionSnapshot(workspaceId, expectedRevision, selected, requestKey, sessionName);
      session = store.updateSession(session.id, { state: "preparing", hostId, ownerProjectId: workspaceOwnerProjectId, error: null });
      changed();
      try {
        const prepared = await host.call("prepare_session", {
          sessionId: session.id, workspaceName: workspace.name, instructions: workspace.instructions,
          repositories: resolved.map(({ projectId, alias, sourcePath, baseRef }) => ({ projectId, alias, sourcePath, baseRef })),
        }, { hostId });
        session = store.setSessionRepositories(session.id, prepared.repositories.map((repository) => ({
          projectId: repository.projectId, alias: repository.alias,
          sourceId: resolved.find((candidate) => candidate.projectId === repository.projectId)?.sourceId,
          sourcePath: repository.sourcePath, baseRef: repository.baseRef, baseCommit: repository.baseCommit,
          branch: repository.branch, worktreePath: repository.worktreePath,
        })));
        session = store.updateSession(session.id, { rootPath: prepared.rootPath });
        const thread = await bb.sdk.threads.spawn({
          projectId: workspaceOwnerProjectId,
          environment: { type: "host", hostId, workspace: { type: "unmanaged", path: prepared.rootPath } },
          prompt, title: `${workspace.name} · ${sessionName}`, visibility: "visible",
          providerId, model, permissionMode,
        });
        session = store.updateSession(session.id, { state: "active", threadId: thread.id }); changed(); return session;
      } catch (error) {
        store.updateSession(session.id, { state: "failed", error: error instanceof Error ? error.message : String(error) });
        changed(); throw error;
      }
    },
    session_rename: async ({ id, name }) => {
      const session = store.renameSession(id, name);
      let threadTitleUpdated = false;
      if (session.threadId) {
        try {
          await bb.sdk.threads.update({ threadId: session.threadId, title: `${session.workspaceName} · ${session.name}` });
          threadTitleUpdated = true;
        } catch (cause) {
          bb.log.warn(`Workspaces renamed a session locally but could not update its thread title: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
      }
      changed();
      return { session, threadTitleUpdated };
    },
    session_archive: async ({ id }) => {
      const current = store.getSession(id);
      if (current.state === "cleaned") throw new Error("A cleaned session cannot be archived again");
      const session = store.updateSession(id, { state: "archived" }); changed(); return session;
    },
    session_cleanup: async ({ id }) => {
      const session = store.getSession(id);
      if (session.state !== "archived") throw new Error("Archive the session before cleaning up its worktrees");
      if (!session.hostId) throw new Error("Session host is unavailable");
      const repositories = session.repositories.map((repository) => {
        if (!repository.sourcePath || !repository.baseRef || !repository.baseCommit || !repository.branch || !repository.worktreePath) {
          throw new Error(`Repository ${repository.alias} was not fully prepared`);
        }
        return {
          projectId: repository.projectId, alias: repository.alias, sourcePath: repository.sourcePath,
          baseRef: repository.baseRef, baseCommit: repository.baseCommit, branch: repository.branch,
          worktreePath: repository.worktreePath,
        };
      });
      await host.call("cleanup_session", { sessionId: session.id, repositories }, { hostId: session.hostId });
      const cleaned = store.updateSession(id, { state: "cleaned", rootPath: null, error: null });
      changed(); return cleaned;
    },
    session_repository_status: async ({ sessionId, projectId }) => {
      const session = store.getSession(sessionId);
      const repository = session.repositories.find((candidate) => candidate.projectId === projectId);
      if (!repository?.worktreePath || !repository.baseCommit || !session.hostId) throw new Error("Repository checkout is not ready");
      return host.call("repository_status", { worktreePath: repository.worktreePath, baseCommit: repository.baseCommit }, { hostId: session.hostId });
    },
    session_expansion_options: async ({ threadId }) => {
      const session = store.getSessionByThreadId(threadId);
      if (!session) throw new Error("This thread is not a workspace session");
      const reconciled = await expansion.reconcileSession(session.id);
      return { session: reconciled, repositories: await expansion.candidatesForThread(threadId) };
    },
    session_add_repository: async ({ threadId, projectId, requestKey, baseRef }) => {
      return resultWithSession(await expansion.addManually({
        threadId, projectId, requestKey, baseRef, reason: "Added from the Repositories panel",
      }));
    },
    repository_bases: async ({ hostId, projectIds, fetch }) => {
      const available = new Map((await projects()).map((project) => [project.id, project]));
      const repositories = projectIds.map((projectId) => {
        const project = available.get(projectId);
        if (!project) throw new Error(`BB project ${projectId} was not found`);
        const source = project.sources.find((candidate) => candidate.hostId === hostId && candidate.isDefault)
          ?? project.sources.find((candidate) => candidate.hostId === hostId);
        if (!source) throw new Error(`${project.name} has no source on the selected host`);
        return { projectId, sourcePath: source.path };
      });
      return host.call("repository_bases", { repositories, fetch }, { hostId });
    },
  });

  const usage = ["Usage:", "  bb workspaces list [--json]", "  bb workspaces show <workspace-id> [--json]", "  bb workspaces sessions [--json]"].join("\n");
  bb.cli.register({
    name: "workspaces", summary: "List multi-repository workspaces and sessions",
    commands: [
      { name: "list", summary: "List workspaces", usage: "bb workspaces list [--json]" },
      { name: "show", summary: "Show one workspace", usage: "bb workspaces show <workspace-id> [--json]" },
      { name: "sessions", summary: "List workspace sessions", usage: "bb workspaces sessions [--json]" },
    ],
    async run(argv) {
      const json = argv.includes("--json"); const args = argv.filter((arg) => arg !== "--json");
      const output = (value: unknown, human: string) => ({ exitCode: 0, stdout: json ? JSON.stringify(value, null, 2) : human });
      if (args[0] === "list") { const rows = store.list(true); return output(rows, rows.length ? rows.map((workspace) => `${workspace.id}  ${workspace.name}  (${workspace.repositories.length} repos)`).join("\n") : "No workspaces."); }
      if (args[0] === "show" && args.length === 2) { const workspace = store.get(args[1]!); return output(workspace, `${workspace.name}\n${workspace.repositories.map((repository) => `  ${repository.alias}: ${repository.projectId}`).join("\n")}`); }
      if (args[0] === "sessions") {
        const rows = sessionsWithReconciliationErrors(await reconcileActiveSessionsForListing());
        return output(rows, rows.length ? rows.map((session) => `${session.id}  ${session.state}  ${session.workspaceName} · ${session.name ?? "Unnamed session"}${session.error ? `  ERROR: ${session.error}` : ""}`).join("\n") : "No sessions.");
      }
      return { exitCode: args[0] === undefined || args[0] === "help" || args[0] === "--help" ? 0 : 1, stdout: usage };
    },
  });
  bb.log.info("loaded");
}
