import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  repositoryDraftSchema,
  workspaceDraftSchema,
  EXPANSION_ERROR_MAX_CHARS,
  MAX_WORKSPACE_REPOSITORIES,
  type ExpansionPhase,
  type ExpansionApprovalMode,
  type ExpansionOutcome,
  type ExpansionPolicy,
  type ExpansionRequester,
  type RepositoryDraft,
  type SessionExpansion,
  type SessionRepository,
  type SessionSnapshot,
  type Workspace,
  type WorkspaceDraft,
} from "./contracts";

type WorkspaceRow = {
  owner_project_id: string | null;
  id: string;
  name: string;
  description: string;
  instructions: string;
  revision: number;
  pinned: number;
  archived_at: number | null;
  created_at: number;
  updated_at: number;
};

type RepoRow = { project_id: string; alias: string; ordinal: number; repository_json: string | null };

type SessionRow = {
  id: string;
  name: string | null;
  workspace_id: string | null;
  workspace_name: string;
  workspace_revision: number;
  instructions: string;
  repositories_json: string;
  state: SessionSnapshot["state"];
  host_id: string | null;
  root_path: string | null;
  primary_project_id: string | null;
  initial_repositories_json: string | null;
  expansion_policy: ExpansionPolicy | null;
  manifest_revision: number | null;
  thread_id: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  request_key: string;
};

type ExpansionRow = {
  id: string;
  session_id: string;
  project_id: string;
  alias: string;
  reason: string;
  requester: ExpansionRequester;
  approval_mode: ExpansionApprovalMode;
  base_ref: string | null;
  outcome: ExpansionOutcome;
  phase: ExpansionPhase | null;
  request_key: string;
  error: string | null;
  created_at: number;
  updated_at: number;
};

export type BeginExpansionInput = {
  sessionId: string;
  projectId: string;
  alias: string;
  reason: string;
  requester: ExpansionRequester;
  approvalMode: ExpansionApprovalMode;
  requestKey: string;
  baseRef?: string;
};

export type ExpansionClaim = {
  expansion: SessionExpansion;
  claimed: boolean;
};

export type AppendProvisionedRepositoryInput = {
  sessionId: string;
  requestKey: string;
  repository: SessionRepository;
  manifestRevision: number;
};

export const WORKSPACE_MIGRATIONS = [`
  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    instructions TEXT NOT NULL,
    revision INTEGER NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0,
    archived_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS workspace_repositories (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL,
    alias TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, project_id),
    UNIQUE (workspace_id, alias)
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    workspace_id TEXT,
    workspace_name TEXT NOT NULL,
    workspace_revision INTEGER NOT NULL,
    instructions TEXT NOT NULL,
    repositories_json TEXT NOT NULL,
    state TEXT NOT NULL,
    host_id TEXT,
    root_path TEXT,
    primary_project_id TEXT,
    thread_id TEXT,
    error TEXT,
    request_key TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`, `
  ALTER TABLE sessions ADD COLUMN initial_repositories_json TEXT;
  ALTER TABLE sessions ADD COLUMN expansion_policy TEXT NOT NULL DEFAULT 'ask';
  ALTER TABLE sessions ADD COLUMN manifest_revision INTEGER NOT NULL DEFAULT 1;
  CREATE TABLE IF NOT EXISTS plugin_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS session_expansions (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL,
    alias TEXT NOT NULL,
    reason TEXT NOT NULL,
    requester TEXT NOT NULL,
    approval_mode TEXT NOT NULL,
    outcome TEXT NOT NULL,
    request_key TEXT NOT NULL UNIQUE,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS session_expansions_provisioned_repo
  ON session_expansions(session_id, project_id)
  WHERE outcome = 'provisioned';
`, `
  ALTER TABLE session_expansions ADD COLUMN phase TEXT;
`, `
  ALTER TABLE sessions ADD COLUMN name TEXT;
`, `
  ALTER TABLE session_expansions ADD COLUMN base_ref TEXT;
`, `
  ALTER TABLE workspaces ADD COLUMN owner_project_id TEXT;
  ALTER TABLE workspace_repositories ADD COLUMN repository_json TEXT;
  CREATE TABLE session_writers (
    request_key TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL,
    thread_id TEXT UNIQUE
  );
`];

const WORKSPACE_PROJECT_ID_METADATA_KEY = "workspace-project-id";

export class WorkspaceStore {
  constructor(private readonly db: Database.Database) {
    this.db.pragma("foreign_keys = ON");
  }

  list(includeArchived = false): Workspace[] {
    const rows = this.db.prepare(
      `SELECT * FROM workspaces ${includeArchived ? "" : "WHERE archived_at IS NULL"} ORDER BY pinned DESC, updated_at DESC, name ASC`,
    ).all() as WorkspaceRow[];
    return rows.map((row) => this.hydrate(row));
  }

  get(id: string): Workspace {
    const row = this.db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as WorkspaceRow | undefined;
    if (!row) throw new Error(`Workspace ${id} was not found`);
    return this.hydrate(row);
  }

  create(input: WorkspaceDraft): Workspace {
    const draft = workspaceDraftSchema.parse(input);
    const now = Date.now();
    const id = `ws_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO workspaces
        (id, name, description, instructions, revision, pinned, archived_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, 0, NULL, ?, ?)`)
        .run(id, draft.name, draft.description, draft.instructions, now, now);
      this.db.prepare("UPDATE workspaces SET owner_project_id = ? WHERE id = ?").run(draft.ownerProjectId ?? null, id);
      this.replaceRepositories(id, draft.repositories);
    })();
    return this.get(id);
  }

  update(id: string, expectedRevision: number, input: WorkspaceDraft): Workspace {
    const draft = workspaceDraftSchema.parse(input);
    const now = Date.now();
    this.db.transaction(() => {
      const result = this.db.prepare(`UPDATE workspaces
        SET name = ?, description = ?, instructions = ?, revision = revision + 1, updated_at = ?
        WHERE id = ? AND revision = ?`)
        .run(draft.name, draft.description, draft.instructions, now, id, expectedRevision);
      if (result.changes !== 1) throw new Error("Workspace revision is stale or the workspace no longer exists");
      this.db.prepare("UPDATE workspaces SET owner_project_id = ? WHERE id = ?").run(draft.ownerProjectId ?? null, id);
      this.replaceRepositories(id, draft.repositories);
    })();
    return this.get(id);
  }

  /** Appends one repository to a saved workspace. Append-only, so it needs no revision guard. */
  enrollRepository(workspaceId: string, repository: RepositoryDraft): Workspace {
    const draft = repositoryDraftSchema.parse(repository);
    this.db.transaction(() => {
      const workspace = this.get(workspaceId);
      const enrolled = workspace.repositories.find((candidate) => candidate.projectId === draft.projectId);
      if (enrolled) {
        if (enrolled.alias !== draft.alias) throw new Error(`Project ${draft.projectId} is already in this workspace as ${enrolled.alias}`);
        return;
      }
      if (workspace.repositories.some((candidate) => candidate.alias === draft.alias)) throw new Error(`Duplicate repository alias: ${draft.alias}`);
      if (workspace.repositories.length >= MAX_WORKSPACE_REPOSITORIES) throw new Error(`Workspace repository limit is ${MAX_WORKSPACE_REPOSITORIES}`);
      this.db.prepare("INSERT INTO workspace_repositories (workspace_id, project_id, alias, ordinal, repository_json) VALUES (?, ?, ?, ?, ?)")
        .run(workspaceId, draft.projectId, draft.alias, workspace.repositories.length, JSON.stringify(draft));
      this.db.prepare("UPDATE workspaces SET revision = revision + 1, updated_at = ? WHERE id = ?").run(Date.now(), workspaceId);
    })();
    return this.get(workspaceId);
  }

  setPinned(id: string, expectedRevision: number, pinned: boolean): Workspace {
    return this.patchFlag(id, expectedRevision, "pinned", pinned ? 1 : 0);
  }

  setArchived(id: string, expectedRevision: number, archived: boolean): Workspace {
    return this.patchFlag(id, expectedRevision, "archived_at", archived ? Date.now() : null);
  }

  remove(id: string, expectedRevision: number): void {
    const result = this.db.prepare("DELETE FROM workspaces WHERE id = ? AND revision = ?").run(id, expectedRevision);
    if (result.changes !== 1) throw new Error("Workspace revision is stale or the workspace no longer exists");
  }

  createSessionSnapshot(workspaceId: string, expectedRevision: number, repositories: RepositoryDraft[], requestKey: string = randomUUID(), name: string | null = null): SessionSnapshot {
    const existing = this.getSessionByRequestKey(requestKey);
    if (existing) return existing;
    const workspace = this.get(workspaceId);
    if (workspace.revision !== expectedRevision) throw new Error("Workspace revision is stale");
    const allowed = new Map(workspace.repositories.map((repository) => [repository.projectId, repository.alias]));
    if (repositories.length < 1 || repositories.length > 20) throw new Error("Select between 1 and 20 repositories");
    const selected = repositories.map((repository) => {
      if (allowed.get(repository.projectId) !== repository.alias) {
        throw new Error(`Repository ${repository.projectId} is not in this workspace with alias ${repository.alias}`);
      }
      return repository;
    });
    const id = this.db.transaction(() => {
      const existing = this.db.prepare("SELECT id FROM sessions WHERE request_key = ?").get(requestKey) as Pick<SessionRow, "id"> | undefined;
      if (existing) return existing.id;
      const now = Date.now();
      const id = `session_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
      const repositoriesJson = JSON.stringify(selected);
      this.db.prepare(`INSERT INTO sessions
        (id, name, workspace_id, workspace_name, workspace_revision, instructions, repositories_json, initial_repositories_json,
         state, request_key, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`)
        .run(id, name, workspace.id, workspace.name, workspace.revision, workspace.instructions, repositoriesJson, repositoriesJson, requestKey, now, now);
      return id;
    })();
    return this.getSession(id);
  }

  getSessionByRequestKey(requestKey: string): SessionSnapshot | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE request_key = ?").get(requestKey) as SessionRow | undefined;
    return row ? this.hydrateSession(row) : null;
  }

  getSessionByThreadId(threadId: string): SessionSnapshot | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE thread_id = ? OR id IN (SELECT session_id FROM session_writers WHERE thread_id = ?) LIMIT 1").get(threadId, threadId) as SessionRow | undefined;
    return row ? this.hydrateSession(row) : null;
  }

  hasSessionForThread(threadId: string): boolean {
    return this.getSessionByThreadId(threadId) !== null;
  }

  claimWriter(requestKey: string, sessionId: string, projectId: string): { claimed: boolean; threadId: string | null } {
    return this.db.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM session_writers WHERE request_key = ?").get(requestKey) as { session_id: string; project_id: string; thread_id: string | null } | undefined;
      if (existing) {
        if (existing.session_id !== sessionId || existing.project_id !== projectId) throw new Error("Writer request key belongs to another repository");
        return { claimed: false, threadId: existing.thread_id };
      }
      this.db.prepare("INSERT INTO session_writers (request_key, session_id, project_id) VALUES (?, ?, ?)").run(requestKey, sessionId, projectId);
      return { claimed: true, threadId: null };
    })();
  }

  completeWriter(requestKey: string, threadId: string): void {
    this.db.prepare("UPDATE session_writers SET thread_id = ? WHERE request_key = ?").run(threadId, requestKey);
  }

  hasPendingWriter(sessionId: string, projectId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM session_writers WHERE session_id = ? AND project_id = ? AND thread_id IS NULL").get(sessionId, projectId));
  }

  getMetadata(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM plugin_metadata WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMetadata(key: string, value: string): void {
    this.db.prepare(`INSERT INTO plugin_metadata (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
  }

  getWorkspaceProjectId(): string | null {
    return this.getMetadata(WORKSPACE_PROJECT_ID_METADATA_KEY);
  }

  setWorkspaceProjectId(id: string): void {
    this.setMetadata(WORKSPACE_PROJECT_ID_METADATA_KEY, id);
  }

  getSession(id: string): SessionSnapshot {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
    if (!row) throw new Error(`Session ${id} was not found`);
    return this.hydrateSession(row);
  }

  listSessions(workspaceId?: string): SessionSnapshot[] {
    const rows = (workspaceId
      ? this.db.prepare("SELECT * FROM sessions WHERE workspace_id = ? ORDER BY created_at DESC").all(workspaceId)
      : this.db.prepare("SELECT * FROM sessions ORDER BY created_at DESC").all()) as SessionRow[];
    return rows.map((row) => this.hydrateSession(row));
  }

  renameSession(id: string, name: string): SessionSnapshot {
    const normalized = name.trim().replace(/\s+/g, " ");
    if (!normalized || normalized.length > 80) throw new Error("Session name must be between 1 and 80 characters");
    const result = this.db.prepare("UPDATE sessions SET name = ?, updated_at = ? WHERE id = ?")
      .run(normalized, Date.now(), id);
    if (result.changes !== 1) throw new Error(`Session ${id} was not found`);
    return this.getSession(id);
  }

  updateSession(
    id: string,
    patch: Partial<Pick<SessionSnapshot, "state" | "hostId" | "rootPath" | "ownerProjectId" | "threadId" | "error">> & { primaryProjectId?: string | null },
  ): SessionSnapshot {
    const current = this.getSession(id);
    const ownerProjectId = patch.ownerProjectId !== undefined
      ? patch.ownerProjectId
      : patch.primaryProjectId !== undefined
        ? patch.primaryProjectId
        : current.ownerProjectId;
    const next = { ...current, ...patch, ownerProjectId, updatedAt: Date.now() };
    this.db.prepare(`UPDATE sessions SET state = ?, host_id = ?, root_path = ?, primary_project_id = ?,
      thread_id = ?, error = ?, updated_at = ? WHERE id = ?`)
      .run(next.state, next.hostId, next.rootPath, next.ownerProjectId, next.threadId, next.error, next.updatedAt, id);
    return this.getSession(id);
  }

  /** @deprecated Retained for launch compatibility; it cannot remove or rename existing members. */
  setSessionRepositories(id: string, repositories: SessionRepository[]): SessionSnapshot {
    return this.db.transaction(() => {
      const current = this.getSession(id);
      this.reconcileRepositories(id, repositories, current.manifestRevision);
      if (current.state === "preparing" && current.initialRepositories.every((repository) => !repository.baseCommit)) {
        if (repositories.length !== current.initialRepositories.length) throw new Error("Initial preparation cannot expand membership");
        this.db.prepare("UPDATE sessions SET initial_repositories_json = ? WHERE id = ?").run(JSON.stringify(repositories), id);
      }
      return this.getSession(id);
    })();
  }

  setExpansionPolicy(id: string, policy: ExpansionPolicy): SessionSnapshot {
    const result = this.db.prepare("UPDATE sessions SET expansion_policy = ?, updated_at = ? WHERE id = ?")
      .run(policy, Date.now(), id);
    if (result.changes !== 1) throw new Error(`Session ${id} was not found`);
    return this.getSession(id);
  }

  beginExpansion(input: BeginExpansionInput): SessionExpansion {
    return this.claimExpansion(input).expansion;
  }

  claimExpansion(input: BeginExpansionInput): ExpansionClaim {
    return this.db.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM session_expansions WHERE request_key = ?").get(input.requestKey) as ExpansionRow | undefined;
      if (existing) return { expansion: this.hydrateExpansion(existing), claimed: false };
      this.getSession(input.sessionId);
      const now = Date.now();
      const id = `expansion_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
      this.db.prepare(`INSERT INTO session_expansions
        (id, session_id, project_id, alias, reason, requester, approval_mode, outcome, request_key, error, created_at, updated_at, phase, base_ref)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, ?, ?, ?, ?)`)
        .run(id, input.sessionId, input.projectId, input.alias, input.reason, input.requester, input.approvalMode, input.requestKey, now, now, input.requester === "user" ? "approved" : "awaiting-approval", input.baseRef ?? null);
      return { expansion: this.hydrateExpansion(this.db.prepare("SELECT * FROM session_expansions WHERE id = ?").get(id) as ExpansionRow), claimed: true };
    })();
  }

  getExpansionByRequestKey(requestKey: string): SessionExpansion | null {
    const row = this.db.prepare("SELECT * FROM session_expansions WHERE request_key = ?").get(requestKey) as ExpansionRow | undefined;
    return row ? this.hydrateExpansion(row) : null;
  }

  finishExpansion(requestKey: string, outcome: "cancelled" | "failed", error?: string): SessionExpansion {
    return this.db.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM session_expansions WHERE request_key = ?").get(requestKey) as ExpansionRow | undefined;
      if (!existing) throw new Error(`Expansion ${requestKey} was not found`);
      if (existing.outcome !== "pending") return this.hydrateExpansion(existing);
      const now = Date.now();
      this.db.prepare("UPDATE session_expansions SET outcome = ?, error = ?, updated_at = ? WHERE request_key = ?")
        .run(outcome, error?.slice(0, EXPANSION_ERROR_MAX_CHARS) ?? null, now, requestKey);
      return this.hydrateExpansion(this.db.prepare("SELECT * FROM session_expansions WHERE request_key = ?").get(requestKey) as ExpansionRow);
    })();
  }

  finishProvisionedExpansion(requestKey: string): SessionExpansion {
    return this.db.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM session_expansions WHERE request_key = ?").get(requestKey) as ExpansionRow | undefined;
      if (!existing) throw new Error(`Expansion ${requestKey} was not found`);
      if (existing.outcome !== "pending") return this.hydrateExpansion(existing);
      const session = this.getSession(existing.session_id);
      if (!session.repositories.some((repository) => repository.projectId === existing.project_id && repository.alias === existing.alias)) throw new Error("Provisioned repository is not recorded");
      const prior = this.db.prepare("SELECT 1 FROM session_expansions WHERE session_id = ? AND project_id = ? AND outcome = 'provisioned'").get(existing.session_id, existing.project_id);
      const now = Date.now();
      this.db.prepare("UPDATE session_expansions SET outcome = ?, error = NULL, updated_at = ? WHERE request_key = ?")
        .run(prior ? "superseded" : "provisioned", now, requestKey);
      return this.hydrateExpansion(this.db.prepare("SELECT * FROM session_expansions WHERE request_key = ?").get(requestKey) as ExpansionRow);
    })();
  }

  setExpansionApprovalMode(requestKey: string, approvalMode: ExpansionApprovalMode): SessionExpansion {
    const result = this.db.prepare("UPDATE session_expansions SET approval_mode = ?, updated_at = ? WHERE request_key = ? AND outcome = 'pending'")
      .run(approvalMode, Date.now(), requestKey);
    if (result.changes !== 1) {
      const existing = this.getExpansionByRequestKey(requestKey);
      if (!existing) throw new Error(`Expansion ${requestKey} was not found`);
      return existing;
    }
    return this.getExpansionByRequestKey(requestKey)!;
  }

  approveExpansion(requestKey: string, approvalMode: ExpansionApprovalMode, auto = false): void {
    this.db.transaction(() => {
      const expansion = this.getExpansionByRequestKey(requestKey);
      if (!expansion || expansion.outcome !== "pending") throw new Error("Expansion is no longer pending");
      this.setExpansionApprovalMode(requestKey, approvalMode);
      this.setExpansionPhase(requestKey, "approved");
      if (auto) this.setExpansionPolicy(expansion.sessionId, "auto");
    })();
  }

  setExpansionPhase(requestKey: string, phase: ExpansionPhase): void {
    this.db.prepare("UPDATE session_expansions SET phase = ?, updated_at = ? WHERE request_key = ? AND outcome = 'pending'").run(phase, Date.now(), requestKey);
  }

  appendProvisionedRepository(input: AppendProvisionedRepositoryInput): SessionSnapshot {
    this.db.transaction(() => {
      const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(input.sessionId) as SessionRow | undefined;
      if (!row) throw new Error(`Session ${input.sessionId} was not found`);
      const expansion = this.db.prepare("SELECT * FROM session_expansions WHERE request_key = ?").get(input.requestKey) as ExpansionRow | undefined;
      if (!expansion || expansion.session_id !== input.sessionId) throw new Error(`Expansion ${input.requestKey} was not found for session ${input.sessionId}`);
      if (expansion.project_id !== input.repository.projectId || expansion.alias !== input.repository.alias) {
        throw new Error("Provisioned repository does not match its expansion request");
      }
      if (expansion.outcome === "provisioned" || expansion.outcome === "superseded") return;
      if (expansion.outcome !== "pending") throw new Error("Expansion is no longer pending");
      if (input.manifestRevision < (row.manifest_revision ?? 1)) throw new Error("Manifest revision cannot go backward");
      const repositories = JSON.parse(row.repositories_json) as SessionRepository[];
      const existing = repositories.find((repository) => repository.projectId === input.repository.projectId);
      if (existing && existing.alias !== input.repository.alias) throw new Error("Cannot replace an existing session repository");
      const nextRepositories = existing ? repositories : [...repositories, input.repository];
      const now = Date.now();
      this.db.prepare(`UPDATE sessions SET initial_repositories_json = COALESCE(initial_repositories_json, repositories_json), repositories_json = ?, manifest_revision = ?, updated_at = ? WHERE id = ?`)
        .run(JSON.stringify(nextRepositories), input.manifestRevision, now, input.sessionId);
      this.finishProvisionedExpansion(input.requestKey);
    })();
    return this.getSession(input.sessionId);
  }

  reconcileRepositories(sessionId: string, repositories: SessionRepository[], manifestRevision: number, operations: Array<{ key: string; projectId: string; alias: string }> = []): SessionSnapshot {
    this.db.transaction(() => {
      const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as SessionRow | undefined;
      if (!row) throw new Error(`Session ${sessionId} was not found`);
      if (manifestRevision < (row.manifest_revision ?? 1)) throw new Error("Manifest revision cannot go backward");
      const current = JSON.parse(row.repositories_json) as SessionRepository[];
      this.assertAppendOnlyMembership(current, repositories);
      this.db.prepare("UPDATE sessions SET initial_repositories_json = COALESCE(initial_repositories_json, repositories_json), repositories_json = ?, manifest_revision = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(repositories), manifestRevision, Date.now(), sessionId);
      for (const operation of operations) {
        const expansion = this.getExpansionByRequestKey(operation.key);
        if (expansion?.sessionId === sessionId && expansion.projectId === operation.projectId && expansion.alias === operation.alias && repositories.some((repository) => repository.projectId === operation.projectId && repository.alias === operation.alias)) this.finishProvisionedExpansion(operation.key);
      }
    })();
    return this.getSession(sessionId);
  }

  private replaceRepositories(workspaceId: string, repositories: RepositoryDraft[]): void {
    this.db.prepare("DELETE FROM workspace_repositories WHERE workspace_id = ?").run(workspaceId);
    const insert = this.db.prepare("INSERT INTO workspace_repositories (workspace_id, project_id, alias, ordinal, repository_json) VALUES (?, ?, ?, ?, ?)");
    repositories.forEach((repository, ordinal) => insert.run(workspaceId, repository.projectId, repository.alias, ordinal, JSON.stringify(repository)));
  }

  private patchFlag(id: string, expectedRevision: number, column: "pinned" | "archived_at", value: number | null): Workspace {
    const result = this.db.prepare(`UPDATE workspaces SET ${column} = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?`)
      .run(value, Date.now(), id, expectedRevision);
    if (result.changes !== 1) throw new Error("Workspace revision is stale or the workspace no longer exists");
    return this.get(id);
  }

  private hydrate(row: WorkspaceRow): Workspace {
    const repositories = this.db.prepare(`SELECT project_id, alias, ordinal, repository_json FROM workspace_repositories
      WHERE workspace_id = ? ORDER BY ordinal`).all(row.id) as RepoRow[];
    return {
      id: row.id,
      name: row.name,
      ...(row.owner_project_id ? { ownerProjectId: row.owner_project_id } : {}),
      description: row.description,
      instructions: row.instructions,
      revision: row.revision,
      pinned: row.pinned === 1,
      archivedAt: row.archived_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      repositories: repositories.map((repository) => ({
        ...(repository.repository_json ? repositoryDraftSchema.parse(JSON.parse(repository.repository_json)) : { projectId: repository.project_id, alias: repository.alias }),
        ordinal: repository.ordinal,
      })),
    };
  }

  private hydrateSession(row: SessionRow): SessionSnapshot {
    const repositories = JSON.parse(row.repositories_json) as SessionRepository[];
    const writers = this.db.prepare("SELECT thread_id FROM session_writers WHERE session_id = ? AND thread_id IS NOT NULL").all(row.id) as { thread_id: string }[];
    return {
      id: row.id,
      name: row.name ?? null,
      workspaceId: row.workspace_id,
      workspaceName: row.workspace_name,
      workspaceRevision: row.workspace_revision,
      instructions: row.instructions,
      repositories,
      initialRepositories: row.initial_repositories_json
        ? JSON.parse(row.initial_repositories_json) as SessionRepository[]
        : repositories,
      expansionPolicy: row.expansion_policy ?? "ask",
      expansions: (this.db.prepare("SELECT * FROM session_expansions WHERE session_id = ? ORDER BY created_at, id").all(row.id) as ExpansionRow[])
        .map((expansion) => this.hydrateExpansion(expansion)),
      manifestRevision: row.manifest_revision ?? 1,
      state: row.state,
      hostId: row.host_id,
      rootPath: row.root_path,
      ownerProjectId: row.primary_project_id,
      threadId: row.thread_id,
      ...(writers.length ? { writerThreadIds: writers.map((writer) => writer.thread_id) } : {}),
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private hydrateExpansion(row: ExpansionRow): SessionExpansion {
    return {
      id: row.id,
      sessionId: row.session_id,
      projectId: row.project_id,
      alias: row.alias,
      reason: row.reason,
      requester: row.requester,
      approvalMode: row.approval_mode,
      baseRef: row.base_ref ?? null,
      outcome: row.outcome,
      phase: row.phase ?? null,
      requestKey: row.request_key,
      error: row.error?.slice(0, EXPANSION_ERROR_MAX_CHARS) ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private assertAppendOnlyMembership(current: SessionRepository[], proposed: SessionRepository[]): void {
    const proposedByProject = new Map<string, SessionRepository>();
    const aliases = new Set<string>();
    for (const repository of proposed) {
      if (proposedByProject.has(repository.projectId) || aliases.has(repository.alias)) {
        throw new Error("Session repository manifest contains duplicate members");
      }
      proposedByProject.set(repository.projectId, repository);
      aliases.add(repository.alias);
    }
    for (const repository of current) {
      const replacement = proposedByProject.get(repository.projectId);
      if (!replacement) throw new Error("Cannot remove an existing session repository");
      if (replacement.alias !== repository.alias) throw new Error("Cannot replace an existing session repository");
    }
  }
}
