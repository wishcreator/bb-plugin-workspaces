import { z } from "zod";
import { uniqueAlias, DEFAULT_BASE_REF, MAX_SESSION_REPOSITORIES, MAX_WORKSPACE_REPOSITORIES, EXPANSION_ERROR_MAX_CHARS, expansionApprovalPayloadSchema, expansionApprovalResponseSchema, type ExpansionOutcome, type SessionExpansion, type SessionRepository, type SessionSnapshot } from "./contracts";
import type { WorkspaceStore } from "./store";

export type ExpansionProject = { id: string; name: string; sources: Array<{ id: string; hostId: string; path: string; isDefault: boolean }> };
export type ExpansionOption = { projectId: string; alias: string; projectName: string; sourcePath: string };
/** A member candidate is already in the saved workspace; a non-member is enrolled when the user picks it. */
export type ExpansionCandidate = ExpansionOption & { member: boolean };
export type ExpansionHostRepository = SessionRepository & { sourcePath: string; baseRef: string; baseCommit: string; branch: string; worktreePath: string };
export type SessionManifest = { revision: number; repositories: ExpansionHostRepository[]; operations: Array<{ key: string; projectId: string; alias: string }> };
export type SessionExpansionDeps = {
  store: WorkspaceStore;
  listProjects(): Promise<ExpansionProject[]>;
  requestApproval(payload: z.infer<typeof expansionApprovalPayloadSchema>, signal?: AbortSignal): Promise<unknown>;
  addRepository(input: { sessionId: string; operationKey: string; instructions: string; repository: { projectId: string; alias: string; sourcePath: string; baseRef: string } }, hostId: string): Promise<{ repository: ExpansionHostRepository; manifestRevision: number }>;
  readSession(sessionId: string, hostId: string): Promise<SessionManifest>;
  publishChanged(): Promise<void>;
  reportError?(input: { operation: "workspaces-changed"; sessionId: string; error: string }): void;
};
export type AgentExpansionRequest = { threadId: string; alias: string; reason: string; requestKey: string; signal?: AbortSignal };
export type ManualExpansionRequest = { threadId: string; projectId: string; requestKey: string; reason?: string; baseRef?: string };
export type ExpansionResult = { added: boolean; outcome: ExpansionOutcome; error: string | null; alias: string; policy: "ask" | "auto"; session: SessionSnapshot; cancelled?: boolean; pending?: boolean; recovered?: boolean };
export type ActiveReconciliationResult = { sessionId: string; session?: SessionSnapshot; error?: string };
type ExpansionIdentity = { projectId?: string; alias?: string };
type SessionEligibility = {
  workspace: ReturnType<WorkspaceStore["get"]>;
  hostId: string;
  projects: Map<string, ExpansionProject>;
  presentProjects: Set<string>;
  presentAliases: Set<string>;
};

const requestKeySchema = z.string().min(8).max(200);
const reasonSchema = z.string().min(1).max(2_000);

/** Resolves untrusted requests and owns the complete expansion state machine. */
export class SessionExpansionService {
  private readonly inFlight = new Map<string, { identity: ExpansionIdentity; promise: Promise<ExpansionResult> }>();

  constructor(private readonly deps: SessionExpansionDeps) {}

  async optionsForThread(threadId: string): Promise<ExpansionOption[]> {
    return this.optionsForSession(this.sessionForOptions(threadId));
  }

  async candidatesForThread(threadId: string): Promise<ExpansionCandidate[]> {
    return this.candidatesForSession(this.sessionForOptions(threadId));
  }

  requestFromAgent(input: AgentExpansionRequest): Promise<ExpansionResult> {
    requestKeySchema.parse(input.requestKey);
    reasonSchema.parse(input.reason);
    try {
      const session = this.sessionForThread(input.threadId);
      return this.runOnce(session.id, input.requestKey, { alias: input.alias }, () => this.requestFromAgentOnce(session, input));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  addManually(input: ManualExpansionRequest): Promise<ExpansionResult> {
    requestKeySchema.parse(input.requestKey);
    if (input.reason !== undefined) reasonSchema.parse(input.reason);
    try {
      const session = this.sessionForThread(input.threadId);
      return this.runOnce(session.id, input.requestKey, { projectId: input.projectId }, () => this.addManuallyOnce(session, input));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async reconcileSession(sessionId: string): Promise<SessionSnapshot> {
    const { snapshot } = await this.readAndReconcile(this.deps.store.getSession(sessionId));
    if (snapshot.state !== "active") return snapshot;
    for (const expansion of snapshot.expansions) {
      if (expansion.outcome !== "pending" || this.inFlight.has(`${sessionId}\u0000${expansion.requestKey}`)) continue;
      if (expansion.phase === "awaiting-approval" || (expansion.phase === null && expansion.requester !== "user")) {
        this.deps.store.finishExpansion(expansion.requestKey, "cancelled", "Approval was interrupted. Submit a new repository request.");
      } else {
        await this.runOnce(sessionId, expansion.requestKey, { projectId: expansion.projectId, alias: expansion.alias }, () => this.recoverPending(expansion));
      }
    }
    return this.deps.store.getSession(sessionId);
  }

  async reconcileActiveSessions(): Promise<ActiveReconciliationResult[]> {
    const results: ActiveReconciliationResult[] = [];
    for (const session of this.deps.store.listSessions()) {
      if (session.state !== "active" || !session.hostId) continue;
      try {
        results.push({ sessionId: session.id, session: await this.reconcileSession(session.id) });
      } catch (error) {
        results.push({ sessionId: session.id, error: this.message(error) });
      }
    }
    return results;
  }

  private async requestFromAgentOnce(session: SessionSnapshot, input: AgentExpansionRequest): Promise<ExpansionResult> {
    const replay = this.deps.store.getExpansionByRequestKey(input.requestKey);
    if (replay) return this.replayForRequest(replay, session, { alias: input.alias }, input.signal);
    const option = (await this.optionsForSession(session)).find((candidate) => candidate.alias === input.alias);
    if (!option) throw new Error(`Repository alias ${input.alias} is not eligible for this session`);
    const claim = this.deps.store.claimExpansion({ sessionId: session.id, projectId: option.projectId, alias: option.alias, reason: input.reason, requester: "agent", approvalMode: "once", requestKey: input.requestKey });
    if (!claim.claimed) return this.replayForRequest(claim.expansion, session, option, input.signal);
    try {
      if (this.deps.store.getSession(session.id).expansionPolicy === "ask") {
        if (!await this.approve(claim.expansion, option, input.signal)) return this.terminal(this.cancel(input.requestKey, option.alias), session.id);
      } else {
        this.deps.store.approveExpansion(input.requestKey, "auto");
      }
      const result = await this.provision(session.id, option, input.requestKey);
      return result.pending ? result : this.terminal(result, session.id);
    } catch (error) {
      return this.terminal(this.fail(input.requestKey, option.alias, error), session.id);
    }
  }

  private async addManuallyOnce(session: SessionSnapshot, input: ManualExpansionRequest): Promise<ExpansionResult> {
    const replay = this.deps.store.getExpansionByRequestKey(input.requestKey);
    if (replay) return this.replayForRequest(replay, session, { projectId: input.projectId });
    const option = (await this.candidatesForSession(session)).find((candidate) => candidate.projectId === input.projectId);
    if (!option) throw new Error(`Project ${input.projectId} is not eligible for this session`);
    if (!option.member) this.deps.store.enrollRepository(session.workspaceId!, { projectId: option.projectId, alias: option.alias });
    const claim = this.deps.store.claimExpansion({ sessionId: session.id, projectId: option.projectId, alias: option.alias, reason: input.reason ?? "Added manually by a workspace member.", requester: "user", approvalMode: "manual", requestKey: input.requestKey, baseRef: input.baseRef });
    if (!claim.claimed) return this.replayForRequest(claim.expansion, session, option);
    try {
      const result = await this.provision(session.id, option, input.requestKey);
      return result.pending ? result : this.terminal(result, session.id);
    } catch (error) {
      return this.terminal(this.fail(input.requestKey, option.alias, error), session.id);
    }
  }

  private async provision(sessionId: string, expected: ExpansionOption, requestKey: string): Promise<ExpansionResult> {
    const { session, option } = await this.finalOption(sessionId, expected);
    if (session.repositories.some((repository) => repository.projectId === option.projectId && repository.alias === option.alias)) {
      this.deps.store.finishProvisionedExpansion(requestKey);
      return this.success(session.id, option.alias, requestKey);
    }
    const requestedBase = this.deps.store.getExpansionByRequestKey(requestKey)?.baseRef ?? DEFAULT_BASE_REF;
    this.deps.store.setExpansionPhase(requestKey, "provisioning");
    if (session.repositories.length >= MAX_SESSION_REPOSITORIES) throw new Error(`Session repository limit is ${MAX_SESSION_REPOSITORIES}`);
    let added;
    try {
      added = await this.deps.addRepository({ sessionId: session.id, operationKey: requestKey, instructions: session.instructions, repository: { projectId: option.projectId, alias: option.alias, sourcePath: option.sourcePath, baseRef: requestedBase } }, session.hostId!);
    } catch (error) {
      if (this.isAbort(error)) {
        this.deps.store.setExpansionPhase(requestKey, "uncertain");
        return this.pending(session.id, option.alias, this.message(error));
      }
      throw error;
    }
    try {
      this.deps.store.appendProvisionedRepository({ sessionId: session.id, requestKey, repository: added.repository, manifestRevision: added.manifestRevision });
      return this.success(session.id, option.alias, requestKey);
    } catch (recordingError) {
      return this.recoverDiskPresent(session, option, requestKey, recordingError);
    }
  }

  private async replay(expansion: SessionExpansion, signal?: AbortSignal): Promise<ExpansionResult> {
    if (expansion.outcome !== "pending") return this.resultForReplay(expansion);
    return this.recoverPending(expansion, signal);
  }

  private replayForRequest(
    expansion: SessionExpansion,
    session: SessionSnapshot,
    requested: ExpansionIdentity,
    signal?: AbortSignal,
  ): Promise<ExpansionResult> {
    if (expansion.sessionId !== session.id) throw new Error(`Request key ${expansion.requestKey} belongs to a different session`);
    this.assertSameIdentity(expansion.requestKey, expansion, requested);
    return this.replay(expansion, signal);
  }

  private async recoverDiskPresent(session: SessionSnapshot, option: ExpansionOption, requestKey: string, recordingError: unknown): Promise<ExpansionResult> {
    try {
      const { snapshot, manifest } = await this.readAndReconcile(session);
      if (!manifest.repositories.some((repository) => repository.projectId === option.projectId && repository.alias === option.alias)) throw new Error("The host manifest did not contain the matching repository");
      this.deps.store.finishProvisionedExpansion(requestKey);
      return { ...this.success(snapshot.id, option.alias, requestKey), recovered: true };
    } catch (recoveryError) {
      return this.pending(session.id, option.alias, `Repository ${option.alias} exists on disk pending database recovery: ${this.message(recordingError)}; ${this.message(recoveryError)}`);
    }
  }

  private async recoverPending(expansion: SessionExpansion, signal?: AbortSignal): Promise<ExpansionResult> {
    const session = this.deps.store.getSession(expansion.sessionId);
    const option = { projectId: expansion.projectId, alias: expansion.alias };
    let manifest: SessionManifest;
    try { ({ manifest } = await this.readAndReconcile(session)); }
    catch (error) { return this.pending(session.id, expansion.alias, this.message(error)); }
    const recorded = this.deps.store.getExpansionByRequestKey(expansion.requestKey)!;
    if (recorded.outcome !== "pending") return this.terminal({ ...this.resultForReplay(recorded), recovered: true }, session.id);
    try {
      const trusted = await this.finalOption(session.id, option);
      if (expansion.phase === "awaiting-approval" || (expansion.phase === null && expansion.requester !== "user")) {
        if (!await this.approve(expansion, trusted.option, signal)) return this.terminal(this.cancel(expansion.requestKey, expansion.alias), session.id);
      }
      if (manifest.repositories.some((repository) => repository.projectId === option.projectId && repository.alias === option.alias)) {
        this.deps.store.finishProvisionedExpansion(expansion.requestKey);
        return this.terminal({ ...this.success(session.id, expansion.alias, expansion.requestKey), recovered: true }, session.id);
      }
      const result = await this.provision(session.id, trusted.option, expansion.requestKey);
      return result.pending ? result : this.terminal(result, session.id);
    } catch (error) { return this.terminal(this.fail(expansion.requestKey, expansion.alias, error), session.id); }
  }

  private async approve(expansion: SessionExpansion, option: ExpansionOption, signal?: AbortSignal): Promise<boolean> {
    this.deps.store.setExpansionPhase(expansion.requestKey, "awaiting-approval");
    let response;
    try {
      response = expansionApprovalResponseSchema.parse(await this.deps.requestApproval({
        sessionId: expansion.sessionId, workspaceName: this.deps.store.getSession(expansion.sessionId).workspaceName,
        repositoryAlias: option.alias, repositoryName: option.projectName, reason: expansion.reason,
      }, signal));
    } catch (error) { if (this.isAbort(error)) return false; throw error; }
    if (response.action === "cancel") return false;
    this.deps.store.approveExpansion(expansion.requestKey, response.action === "add-and-auto" ? "auto" : "once", response.action === "add-and-auto");
    return true;
  }

  private async readAndReconcile(session: SessionSnapshot): Promise<{ snapshot: SessionSnapshot; manifest: SessionManifest }> {
    if (!session.hostId) throw new Error("Session host is unavailable");
    const manifest = await this.deps.readSession(session.id, session.hostId);
    return { manifest, snapshot: this.deps.store.reconcileRepositories(session.id, manifest.repositories, manifest.revision, manifest.operations) };
  }

  private sessionForThread(threadId: string): SessionSnapshot {
    const session = this.deps.store.getSessionByThreadId(threadId);
    if (!session) throw new Error("This thread is not a workspace session");
    if (session.state !== "active") throw new Error("Only active workspace sessions can add repositories");
    if (!session.hostId) throw new Error("Session host is unavailable");
    return session;
  }

  private async finalOption(sessionId: string, expected: Pick<ExpansionOption, "projectId" | "alias">): Promise<{ session: SessionSnapshot; option: ExpansionOption }> {
    const projects = new Map((await this.deps.listProjects()).map((project) => [project.id, project]));
    const session = this.deps.store.getSession(sessionId);
    if (session.state !== "active") throw new Error("Only active workspace sessions can add repositories");
    if (!session.workspaceId) throw new Error("The saved workspace is unavailable");
    if (!session.hostId) throw new Error("Session host is unavailable");
    let workspace;
    try { workspace = this.deps.store.get(session.workspaceId); } catch { throw new Error("The saved workspace no longer exists"); }
    const member = workspace.repositories.find((repository) => repository.projectId === expected.projectId && repository.alias === expected.alias);
    if (!member) throw new Error(`Repository ${expected.alias} is no longer eligible for this session`);
    if (session.repositories.some((repository) => (repository.projectId === expected.projectId || repository.alias === expected.alias) && !(repository.projectId === expected.projectId && repository.alias === expected.alias))) {
      throw new Error(`Repository ${expected.alias} is no longer eligible for this session`);
    }
    if (member.localPath) {
      if (member.hostId !== session.hostId) throw new Error(`Repository ${expected.alias} belongs to another host`);
      return { session, option: { projectId: member.projectId, alias: member.alias, projectName: member.alias, sourcePath: member.localPath } };
    }
    const project = projects.get(expected.projectId);
    if (!project) throw new Error(`Repository ${expected.alias} is no longer eligible for this session`);
    const source = project.sources.find((candidate) => candidate.hostId === session.hostId && candidate.isDefault)
      ?? project.sources.find((candidate) => candidate.hostId === session.hostId);
    if (!source) throw new Error(`Repository ${expected.alias} is no longer eligible for this session`);
    return { session, option: { projectId: project.id, alias: member.alias, projectName: project.name, sourcePath: source.path } };
  }

  private sessionForOptions(threadId: string): SessionSnapshot {
    const session = this.deps.store.getSessionByThreadId(threadId);
    if (!session) throw new Error("This thread is not a workspace session");
    return session;
  }

  private async eligibility(session: SessionSnapshot): Promise<SessionEligibility> {
    if (session.repositories.length >= MAX_SESSION_REPOSITORIES) throw new Error(`Session repository limit is ${MAX_SESSION_REPOSITORIES}`);
    if (session.state !== "active") throw new Error("Only active workspace sessions can add repositories");
    if (!session.workspaceId) throw new Error("The saved workspace is unavailable");
    if (!session.hostId) throw new Error("Session host is unavailable");
    let workspace;
    try { workspace = this.deps.store.get(session.workspaceId); } catch { throw new Error("The saved workspace no longer exists"); }
    return {
      workspace,
      hostId: session.hostId,
      projects: new Map((await this.deps.listProjects()).map((project) => [project.id, project])),
      presentProjects: new Set(session.repositories.map((repository) => repository.projectId)),
      presentAliases: new Set(session.repositories.map((repository) => repository.alias)),
    };
  }

  private hostSource(project: ExpansionProject, hostId: string) {
    return project.sources.find((candidate) => candidate.hostId === hostId && candidate.isDefault)
      ?? project.sources.find((candidate) => candidate.hostId === hostId);
  }

  private memberOptions(eligibility: SessionEligibility): ExpansionOption[] {
    return eligibility.workspace.repositories.flatMap((repository) => {
      if (eligibility.presentProjects.has(repository.projectId) || eligibility.presentAliases.has(repository.alias)) return [];
      if (repository.localPath) return repository.hostId === eligibility.hostId
        ? [{ projectId: repository.projectId, alias: repository.alias, projectName: repository.alias, sourcePath: repository.localPath }] : [];
      const project = eligibility.projects.get(repository.projectId);
      if (!project) return [];
      const source = this.hostSource(project, eligibility.hostId);
      return source ? [{ projectId: project.id, alias: repository.alias, projectName: project.name, sourcePath: source.path }] : [];
    });
  }

  private async optionsForSession(session: SessionSnapshot): Promise<ExpansionOption[]> {
    return this.memberOptions(await this.eligibility(session));
  }

  /** Members plus every other project checked out on this host, each with the alias enrollment would use. */
  private async candidatesForSession(session: SessionSnapshot): Promise<ExpansionCandidate[]> {
    const eligibility = await this.eligibility(session);
    const members = this.memberOptions(eligibility).map((option) => ({ ...option, member: true }));
    if (eligibility.workspace.repositories.length >= MAX_WORKSPACE_REPOSITORIES) return members;
    const enrolled = new Set([...eligibility.presentProjects, ...eligibility.workspace.repositories.map((repository) => repository.projectId)]);
    const taken = new Set([...eligibility.presentAliases, ...eligibility.workspace.repositories.map((repository) => repository.alias)]);
    const newcomers: ExpansionCandidate[] = [];
    for (const project of eligibility.projects.values()) {
      if (enrolled.has(project.id)) continue;
      const source = this.hostSource(project, eligibility.hostId);
      if (!source) continue;
      const alias = uniqueAlias(project.name, taken);
      taken.add(alias);
      newcomers.push({ projectId: project.id, alias, projectName: project.name, sourcePath: source.path, member: false });
    }
    newcomers.sort((left, right) => left.projectName.localeCompare(right.projectName));
    return [...members, ...newcomers];
  }

  private success(sessionId: string, alias: string, requestKey: string): ExpansionResult {
    const session = this.deps.store.getSession(sessionId);
    return { added: true, outcome: this.deps.store.getExpansionByRequestKey(requestKey)!.outcome, error: null, alias, policy: session.expansionPolicy, session };
  }
  private pending(sessionId: string, alias: string, error?: string): ExpansionResult {
    const session = this.deps.store.getSession(sessionId);
    return { added: false, outcome: "pending", error: error?.slice(0, EXPANSION_ERROR_MAX_CHARS) ?? null, alias, policy: session.expansionPolicy, session, pending: true };
  }
  private cancel(requestKey: string, alias: string): ExpansionResult {
    const expansion = this.deps.store.finishExpansion(requestKey, "cancelled");
    return this.resultForReplay(expansion);
  }
  private fail(requestKey: string, alias: string, error: unknown): ExpansionResult {
    const expansion = this.deps.store.finishExpansion(requestKey, "failed", this.message(error));
    return this.resultForReplay(expansion);
  }
  private async terminal(result: ExpansionResult, sessionId: string): Promise<ExpansionResult> {
    try {
      await this.deps.publishChanged();
    } catch (error) {
      try { this.deps.reportError?.({ operation: "workspaces-changed", sessionId, error: this.message(error) }); } catch {}
    }
    return result;
  }
  private resultForReplay(expansion: SessionExpansion): ExpansionResult {
    const session = this.deps.store.getSession(expansion.sessionId);
    return {
      added: expansion.outcome === "provisioned" || expansion.outcome === "superseded", outcome: expansion.outcome,
      alias: expansion.alias, policy: session.expansionPolicy, session, error: expansion.error?.slice(0, EXPANSION_ERROR_MAX_CHARS) ?? null,
      ...(expansion.outcome === "cancelled" ? { cancelled: true } : {}),
    };
  }
  private runOnce(sessionId: string, requestKey: string, identity: ExpansionIdentity, operation: () => Promise<ExpansionResult>): Promise<ExpansionResult> {
    const inFlightKey = `${sessionId}\u0000${requestKey}`;
    const existing = this.inFlight.get(inFlightKey);
    if (existing) {
      this.assertSameIdentity(requestKey, existing.identity, identity);
      return existing.promise;
    }
    const promise = operation();
    this.inFlight.set(inFlightKey, { identity, promise });
    void promise.then(
      () => { if (this.inFlight.get(inFlightKey)?.promise === promise) this.inFlight.delete(inFlightKey); },
      () => { if (this.inFlight.get(inFlightKey)?.promise === promise) this.inFlight.delete(inFlightKey); },
    );
    return promise;
  }
  private assertSameIdentity(requestKey: string, actual: ExpansionIdentity, requested: ExpansionIdentity): void {
    if (requested.projectId && actual.projectId !== requested.projectId) {
      throw new Error(`Request key ${requestKey} belongs to a different project`);
    }
    if (requested.alias && actual.alias !== requested.alias) {
      throw new Error(`Request key ${requestKey} belongs to a different alias`);
    }
  }
  private isAbort(error: unknown): boolean { return error instanceof Error && error.name === "AbortError"; }
  private message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
}
