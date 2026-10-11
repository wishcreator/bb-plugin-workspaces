import { z } from "zod";

export const MAX_WORKSPACE_REPOSITORIES = 100;

/** Asks the host to resolve each repository's own default branch at provisioning time. */
export const DEFAULT_BASE_REF = "@default";
export const MAX_BASE_REFS = 200;

/** Git ref names accepted from the UI. Leading dashes are refused so a ref can never act as a git flag. */
export const baseRefSchema = z.union([
  z.literal(DEFAULT_BASE_REF),
  z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/, "Invalid base ref"),
]);

export const repositoryDraftSchema = z.object({
  projectId: z.string().trim().min(1),
  alias: z.string().trim().regex(/^[a-z][a-z0-9-]{0,47}$/, "Invalid repository alias"),
  localPath: z.string().trim().min(1).max(4096).regex(/^(\/|[A-Za-z]:[\\/])/, "Use an absolute repository path").optional(),
  hostId: z.string().trim().min(1).optional(),
}).superRefine((value, context) => {
  if (Boolean(value.localPath) !== Boolean(value.hostId)) context.addIssue({ code: "custom", message: "A local repository needs both path and host" });
  if (value.localPath && value.projectId !== `local:${value.alias}`) context.addIssue({ code: "custom", message: "Invalid local repository selector" });
  if (!value.localPath && value.projectId.startsWith("local:")) context.addIssue({ code: "custom", message: "Local selectors require a path and host" });
});

export const workspaceDraftSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(2_000),
  instructions: z.string().max(16_000),
  ownerProjectId: z.string().trim().min(1).optional(),
  repositories: z.array(repositoryDraftSchema).min(1).max(MAX_WORKSPACE_REPOSITORIES),
}).superRefine((value, context) => {
  const aliases = new Set<string>();
  const projects = new Set<string>();
  const paths = new Set<string>();
  for (const repository of value.repositories) {
    if (repository.localPath) {
      const key = `${repository.hostId}:${repository.localPath.replace(/[\\/]+$/, "")}`;
      if (paths.has(key)) context.addIssue({ code: "custom", message: "Duplicate local repository path" });
      paths.add(key);
      if (!value.ownerProjectId) context.addIssue({ code: "custom", message: "Choose an existing project for local repository threads" });
    }
    if (aliases.has(repository.alias)) {
      context.addIssue({ code: "custom", path: ["repositories"], message: `Duplicate repository alias: ${repository.alias}` });
    }
    if (projects.has(repository.projectId)) {
      context.addIssue({ code: "custom", path: ["repositories"], message: `Duplicate project: ${repository.projectId}` });
    }
    aliases.add(repository.alias);
    projects.add(repository.projectId);
  }
});

const MAX_ALIAS_LENGTH = 48;

function deriveAlias(projectName: string): string {
  const normalized = projectName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, MAX_ALIAS_LENGTH);
  return /^[a-z]/.test(normalized) ? normalized : `repo-${normalized || "project"}`.slice(0, MAX_ALIAS_LENGTH);
}

/** Derives the alias BB shows for a project, suffixed until it is free and still valid for repositoryDraftSchema. */
export function uniqueAlias(projectName: string, taken: ReadonlySet<string>): string {
  const base = deriveAlias(projectName);
  let alias = base;
  let suffix = 2;
  while (taken.has(alias)) {
    const tail = `-${suffix++}`;
    alias = `${base.slice(0, MAX_ALIAS_LENGTH - tail.length)}${tail}`;
  }
  return alias;
}

export type RepositoryDraft = z.infer<typeof repositoryDraftSchema>;
export type WorkspaceDraft = z.infer<typeof workspaceDraftSchema>;

export const expansionApprovalPayloadSchema = z.object({
  sessionId: z.string(),
  workspaceName: z.string(),
  repositoryAlias: z.string(),
  repositoryName: z.string(),
  reason: z.string().min(1).max(2_000),
}).strict();

export const expansionApprovalResponseSchema = z.object({
  action: z.enum(["add-once", "add-and-auto", "cancel"]),
}).strict();

export type ExpansionApprovalPayload = z.infer<typeof expansionApprovalPayloadSchema>;
export type ExpansionApprovalResponse = z.infer<typeof expansionApprovalResponseSchema>;

export type WorkspaceRepository = RepositoryDraft & { ordinal: number };

export type Workspace = WorkspaceDraft & {
  id: string;
  revision: number;
  pinned: boolean;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
  repositories: WorkspaceRepository[];
};

export type SessionRepository = RepositoryDraft & {
  sourceId?: string;
  sourcePath?: string;
  baseRef?: string;
  baseCommit?: string;
  branch?: string;
  worktreePath?: string;
};

export type ExpansionPolicy = "ask" | "auto";
export type ExpansionRequester = "agent" | "user" | "reconcile";
export type ExpansionApprovalMode = "once" | "auto" | "manual" | "reconciled";
export type ExpansionOutcome = "pending" | "cancelled" | "failed" | "provisioned" | "superseded";
export type ExpansionPhase = "awaiting-approval" | "approved" | "provisioning" | "uncertain";
export const EXPANSION_ERROR_MAX_CHARS = 500;
/** Total append-only membership, including the initial selection. */
export const MAX_SESSION_REPOSITORIES = 1024;

export type SessionExpansion = {
  id: string;
  sessionId: string;
  projectId: string;
  alias: string;
  reason: string;
  requester: ExpansionRequester;
  approvalMode: ExpansionApprovalMode;
  baseRef: string | null;
  outcome: ExpansionOutcome;
  phase: ExpansionPhase | null;
  requestKey: string;
  error: string | null;
  createdAt: number;
  updatedAt: number;
};

export type SessionSnapshot = {
  id: string;
  name: string | null;
  workspaceId: string | null;
  workspaceName: string;
  workspaceRevision: number;
  instructions: string;
  repositories: SessionRepository[];
  initialRepositories: SessionRepository[];
  expansionPolicy: ExpansionPolicy;
  expansions: SessionExpansion[];
  manifestRevision: number;
  state: "draft" | "preparing" | "active" | "failed" | "archived" | "cleaned";
  hostId: string | null;
  rootPath: string | null;
  ownerProjectId: string | null;
  threadId: string | null;
  writerThreadIds?: string[];
  error: string | null;
  createdAt: number;
  updatedAt: number;
};
