import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { definePluginApp, useBbNavigate, useRealtime, useRpc, type PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { expansionApprovalPayloadSchema, expansionApprovalResponseSchema, uniqueAlias, DEFAULT_BASE_REF, MAX_WORKSPACE_REPOSITORIES, type SessionSnapshot, type Workspace, type WorkspaceDraft } from "./src/contracts";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";

type Project = {
  id: string;
  name: string;
  gitRemoteUrl: string | null;
  sources: Array<{ id: string; hostId: string; path: string; isDefault: boolean }>;
};
type Dashboard = { workspaces: Workspace[]; sessions: SessionSnapshot[]; projects: Project[] };
type ExpansionOption = { projectId: string; alias: string; projectName: string; sourcePath: string; member: boolean };
type RepositoryBases = { projectId: string; defaultBase: string; currentBranch: string | null; currentCommit: string; refs: string[]; fetchError: string | null };

function baseOptions(bases: RepositoryBases): Array<{ value: string; label: string }> {
  const current = bases.currentBranch ?? bases.currentCommit.slice(0, 12);
  const listed = [
    { value: DEFAULT_BASE_REF, label: `Default branch — ${bases.defaultBase}` },
    { value: bases.currentBranch ?? bases.currentCommit, label: `Current checkout — ${current}` },
  ];
  const claimed = new Set([bases.defaultBase, listed[1]!.value]);
  return [...listed, ...bases.refs.filter((ref) => !claimed.has(ref)).map((ref) => ({ value: ref, label: ref }))];
}

/** Loads each repository's candidate bases, fetching remotes so the default branch is current. */
function useRepositoryBases(rpc: ReturnType<typeof useRpc<typeof rpcContract>>, hostId: string, projectIds: string[]) {
  const [bases, setBases] = useState<Record<string, RepositoryBases> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = `${hostId}:${[...projectIds].sort().join(",")}`;
  const latest = useRef("");
  useEffect(() => {
    if (!hostId || projectIds.length === 0) { setBases(null); return; }
    latest.current = key; setBases(null); setError(null);
    rpc.call("repository_bases", { hostId, projectIds, fetch: true }).then(
      (result) => { if (latest.current !== key) return; setBases(Object.fromEntries(result.repositories.map((row) => [row.projectId, row]))); },
      (cause) => { if (latest.current !== key) return; setError(cause instanceof Error ? cause.message : String(cause)); },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, rpc]);
  return { bases, error };
}

const fieldClass = "w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring";

function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">{children}</div>;
}

function useDashboard() {
  const rpc = useRpc<typeof rpcContract>();
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    rpc.call("dashboard").then((result) => { setDashboard(result); setError(null); }, (cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [rpc]);
  useEffect(load, [load]);
  useRealtime("workspaces-changed", load);
  return { rpc, dashboard, error, setError, load };
}

function WorkspaceForm({ projects, initial, onCancel, onSave }: {
  projects: Project[];
  initial?: Workspace;
  onCancel: () => void;
  onSave: (draft: WorkspaceDraft) => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [instructions, setInstructions] = useState(initial?.instructions ?? "");
  const [selected, setSelected] = useState(() => new Set(initial?.repositories.map((repo) => repo.projectId) ?? []));
  const [repositoryQuery, setRepositoryQuery] = useState("");
  const [repositoryFilter, setRepositoryFilter] = useState<"all" | "selected">("all");
  const [selectionMessage, setSelectionMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const visibleProjects = useMemo(() => {
    const query = repositoryQuery.trim().toLocaleLowerCase();
    return projects
      .filter((project) => repositoryFilter === "all" || selected.has(project.id))
      .filter((project) => !query || project.name.toLocaleLowerCase().includes(query)
        || project.sources.some((source) => source.path.toLocaleLowerCase().includes(query)))
      .sort((left, right) => Number(selected.has(right.id)) - Number(selected.has(left.id))
        || left.name.localeCompare(right.name));
  }, [projects, repositoryFilter, repositoryQuery, selected]);
  const toggleRepository = (projectId: string, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (!checked) next.delete(projectId);
      else if (next.size < MAX_WORKSPACE_REPOSITORIES) next.add(projectId);
      else setSelectionMessage(`A workspace can contain at most ${MAX_WORKSPACE_REPOSITORIES} repositories.`);
      return next;
    });
  };
  const selectVisible = () => {
    setSelected((current) => {
      const next = new Set(current);
      let skipped = 0;
      for (const project of visibleProjects) {
        if (next.has(project.id)) continue;
        if (next.size >= MAX_WORKSPACE_REPOSITORIES) skipped += 1;
        else next.add(project.id);
      }
      setSelectionMessage(skipped > 0
        ? `${skipped} visible repositories were not selected because a workspace can contain at most ${MAX_WORKSPACE_REPOSITORIES}.`
        : null);
      return next;
    });
  };
  const clearVisible = () => {
    setSelected((current) => {
      const next = new Set(current);
      visibleProjects.forEach((project) => next.delete(project.id));
      return next;
    });
    setSelectionMessage(null);
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || selected.size === 0 || pending) return;
    setPending(true);
    try {
      const used = new Set<string>();
      const repositories = projects.filter((project) => selected.has(project.id)).map((project) => {
        const existing = initial?.repositories.find((repo) => repo.projectId === project.id)?.alias;
        const alias = existing && !used.has(existing) ? existing : uniqueAlias(project.name, used);
        used.add(alias);
        return { projectId: project.id, alias };
      });
      await onSave({ name: name.trim(), description: description.trim(), instructions, repositories });
    } finally { setPending(false); }
  };
  return (
    <form onSubmit={submit} className="space-y-4 sm:overflow-y-auto sm:pr-1">
      <div><label className="mb-1 block text-sm font-medium" htmlFor="workspace-name">Workspace name</label><Input id="workspace-name" aria-label="Workspace name" value={name} onChange={(event) => setName(event.target.value)} autoFocus /></div>
      <div><label className="mb-1 block text-sm font-medium" htmlFor="workspace-description">Description</label><Input id="workspace-description" value={description} onChange={(event) => setDescription(event.target.value)} /></div>
      <div><label className="mb-1 block text-sm font-medium" htmlFor="workspace-instructions">Shared instructions</label><textarea id="workspace-instructions" className={`${fieldClass} min-h-24 resize-y`} value={instructions} onChange={(event) => setInstructions(event.target.value)} placeholder="Context that applies whenever these repositories are used together" /></div>
      <fieldset className="space-y-2"><legend className="sr-only">Repositories</legend><div className="flex items-center justify-between gap-3"><span className="text-sm font-medium">Repositories</span><span className="text-xs tabular-nums text-muted-foreground">{selected.size} / {MAX_WORKSPACE_REPOSITORIES} selected</span></div>
        <Input type="search" aria-label="Search repositories" placeholder="Search by repository name or path…" value={repositoryQuery} onChange={(event) => setRepositoryQuery(event.target.value)} />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex gap-1" aria-label="Repository filters"><Button type="button" size="sm" variant={repositoryFilter === "all" ? "secondary" : "ghost"} onClick={() => setRepositoryFilter("all")}>All repositories</Button><Button type="button" size="sm" variant={repositoryFilter === "selected" ? "secondary" : "ghost"} onClick={() => setRepositoryFilter("selected")}>Selected repositories</Button></div>
          <div className="flex gap-1"><Button type="button" size="sm" variant="ghost" onClick={selectVisible} disabled={visibleProjects.length === 0}>Select visible</Button><Button type="button" size="sm" variant="ghost" onClick={clearVisible} disabled={visibleProjects.every((project) => !selected.has(project.id))}>Clear visible</Button></div>
        </div>
        {selectionMessage ? <p role="status" className="text-xs text-muted-foreground">{selectionMessage}</p> : null}
        <div className="max-h-72 space-y-1 overflow-y-auto rounded-md border border-border p-2">
          {visibleProjects.length === 0 ? <p className="px-2 py-6 text-center text-sm text-muted-foreground">No repositories match this view.</p> : visibleProjects.map((project) => <label key={project.id} className="flex cursor-pointer items-start gap-3 rounded px-2 py-2 hover:bg-muted/60">
            <Checkbox checked={selected.has(project.id)} disabled={!selected.has(project.id) && selected.size >= MAX_WORKSPACE_REPOSITORIES} onCheckedChange={(checked) => toggleRepository(project.id, checked === true)} aria-label={project.name} />
            <span className="min-w-0"><span className="block text-sm font-medium">{project.name}</span><span className="block truncate text-xs text-muted-foreground">{project.sources[0]?.path ?? "No source configured"}</span></span>
          </label>)}
        </div>
      </fieldset>
      <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button><Button type="submit" disabled={pending || !name.trim() || selected.size === 0}>{initial ? "Save workspace" : "Create workspace"}</Button></div>
    </form>
  );
}

function rememberedSelection(workspaceId: string, projectIds: string[]): Set<string> {
  try {
    const stored = globalThis.localStorage.getItem(`bb-workspaces:selection:${workspaceId}`);
    if (stored !== null) {
      const parsed: unknown = JSON.parse(stored);
      if (Array.isArray(parsed)) {
        const allowed = new Set(projectIds);
        return new Set(parsed.filter((projectId): projectId is string => typeof projectId === "string" && allowed.has(projectId)));
      }
    }
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
  return new Set(projectIds);
}

type SessionRoute = { providerId: string; model: string };

function rememberedRoute(workspaceId: string): SessionRoute | null {
  try {
    const stored = globalThis.localStorage.getItem(`bb-workspaces:route:${workspaceId}`);
    if (stored !== null) {
      const parsed: unknown = JSON.parse(stored);
      if (parsed !== null && typeof parsed === "object") {
        const candidate = parsed as Record<string, unknown>;
        if (typeof candidate.providerId === "string" && candidate.providerId.trim()
          && typeof candidate.model === "string" && candidate.model.trim()) {
          return { providerId: candidate.providerId.trim(), model: candidate.model.trim() };
        }
      }
    }
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
  return null;
}

function SessionLauncher({ workspace, projects, rpc, onError }: { workspace: Workspace; projects: Project[]; rpc: ReturnType<typeof useRpc<typeof rpcContract>>; onError: (message: string) => void }) {
  const navigate = useBbNavigate();
  const memberProjects = workspace.repositories.map((member) => projects.find((project) => project.id === member.projectId)).filter((project): project is Project => Boolean(project));
  const [selected, setSelected] = useState(() => rememberedSelection(workspace.id, memberProjects.map((project) => project.id)));
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [pending, setPending] = useState(false);
  const [requestKey, setRequestKey] = useState(() => `launch-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const savedRoute = useMemo(() => rememberedRoute(workspace.id), [workspace.id]);
  const [customRoute, setCustomRoute] = useState(savedRoute !== null);
  const [providerId, setProviderId] = useState(savedRoute?.providerId ?? "");
  const [model, setModel] = useState(savedRoute?.model ?? "");
  const trimmedProviderId = providerId.trim();
  const trimmedModel = model.trim();
  const routeComplete = !customRoute || (trimmedProviderId.length > 0 && trimmedModel.length > 0);
  const eligibleHosts = useMemo(() => {
    const chosen = memberProjects.filter((project) => selected.has(project.id));
    if (chosen.length === 0) return [];
    return [...new Set(chosen[0]!.sources.map((source) => source.hostId))].filter((hostId) => chosen.every((project) => project.sources.some((source) => source.hostId === hostId)));
  }, [memberProjects, selected]);
  const [hostId, setHostId] = useState(eligibleHosts[0] ?? "");
  useEffect(() => {
    try { globalThis.localStorage.setItem(`bb-workspaces:selection:${workspace.id}`, JSON.stringify([...selected])); }
    catch { /* Keep the in-memory selection when storage is unavailable. */ }
  }, [selected, workspace.id]);
  useEffect(() => {
    try {
      const key = `bb-workspaces:route:${workspace.id}`;
      if (customRoute && trimmedProviderId && trimmedModel) {
        globalThis.localStorage.setItem(key, JSON.stringify({ providerId: trimmedProviderId, model: trimmedModel }));
      } else {
        globalThis.localStorage.removeItem(key);
      }
    } catch { /* Keep the in-memory route when storage is unavailable. */ }
  }, [customRoute, trimmedProviderId, trimmedModel, workspace.id]);
  useEffect(() => { if (!eligibleHosts.includes(hostId)) setHostId(eligibleHosts[0] ?? ""); }, [eligibleHosts, hostId]);
  const selectedIds = useMemo(() => memberProjects.filter((project) => selected.has(project.id)).map((project) => project.id), [memberProjects, selected]);
  const { bases, error: basesError } = useRepositoryBases(rpc, hostId, selectedIds);
  const [chosenBases, setChosenBases] = useState<Record<string, string>>({});
  const [showBases, setShowBases] = useState(false);
  useEffect(() => { setChosenBases({}); }, [bases]);
  const baseFor = (projectId: string) => chosenBases[projectId] ?? DEFAULT_BASE_REF;
  const allDefault = selectedIds.every((projectId) => baseFor(projectId) === DEFAULT_BASE_REF);
  const start = async (event: FormEvent) => {
    event.preventDefault();
    if (!prompt.trim() || !eligibleHosts.includes(hostId) || pending || !routeComplete) return;
    setPending(true); onError("");
    try {
      const overrides = Object.fromEntries(selectedIds.map((projectId) => [projectId, baseFor(projectId)]));
      const session = await rpc.call("session_start", {
        workspaceId: workspace.id, expectedRevision: workspace.revision, hostId,
        projectIds: [...selected], prompt: prompt.trim(), requestKey, bases: overrides,
        ...(customRoute ? { providerId: trimmedProviderId, model: trimmedModel } : {}),
        ...(name.trim() ? { name: name.trim() } : {}),
      });
      if (session.threadId) { setRequestKey(`launch-${Date.now()}-${Math.random().toString(36).slice(2)}`); navigate.toThread(session.threadId); }
    } catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(false); }
  };
  return <form onSubmit={start} className="space-y-3 rounded-lg border border-border p-4">
    <div><h3 className="text-sm font-semibold">Start a task</h3><p className="text-xs text-muted-foreground">Each selected repository gets its own isolated worktree.</p></div>
    <div className="flex flex-wrap gap-2">{memberProjects.map((project) => <label key={project.id} className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5 text-sm"><Checkbox checked={selected.has(project.id)} onCheckedChange={(checked) => setSelected((current) => { const next = new Set(current); checked === true ? next.add(project.id) : next.delete(project.id); return next; })} aria-label={`Use ${project.name}`} />{project.name}</label>)}</div>
    {eligibleHosts.length > 1 ? <label className="block text-sm">Host<select className={`${fieldClass} mt-1`} value={hostId} onChange={(event) => setHostId(event.target.value)}>{eligibleHosts.map((candidate) => <option key={candidate} value={candidate}>{candidate}</option>)}</select></label> : null}
    {eligibleHosts.length === 0 && selected.size > 0 ? <p className="text-sm text-destructive">The selected repositories do not share a configured host.</p> : null}
    {selectedIds.length > 0 ? <div className="rounded-md border border-border p-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">{bases ? (allDefault ? "Branching from each repository's default branch, freshly fetched." : "Using a custom base for at least one repository.") : basesError ? "Could not read repository branches." : "Reading repository branches…"}</p>
        <Button type="button" variant="ghost" size="sm" disabled={!bases} onClick={() => setShowBases((current) => !current)}>{showBases ? "Hide bases" : "Change base"}</Button>
      </div>
      {basesError ? <p className="mt-1 text-xs text-destructive">{basesError}</p> : null}
      {showBases && bases ? <div className="mt-2 space-y-2">{selectedIds.map((projectId) => {
        const row = bases[projectId];
        const project = memberProjects.find((candidate) => candidate.id === projectId);
        if (!row || !project) return null;
        return <div key={projectId} className="flex flex-wrap items-center gap-2">
          <label className="min-w-40 text-sm" htmlFor={`base-${projectId}`}>{project.name}</label>
          <select id={`base-${projectId}`} aria-label={`Base for ${project.name}`} className={`${fieldClass} max-w-xs`} value={baseFor(projectId)} onChange={(event) => setChosenBases((current) => ({ ...current, [projectId]: event.target.value }))}>
            {baseOptions(row).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          {row.fetchError ? <span className="text-xs text-destructive">Fetch failed; using the last fetched commit.</span> : null}
        </div>;
      })}</div> : null}
    </div> : null}
    <div className="rounded-md border border-border p-2">
      <label className="block text-sm" htmlFor={`route-${workspace.id}`}>Agent route
        <select id={`route-${workspace.id}`} className={`${fieldClass} mt-1`} value={customRoute ? "explicit" : "project"} onChange={(event) => setCustomRoute(event.target.value === "explicit")}>
          <option value="project">Project default</option>
          <option value="explicit">Custom provider and model</option>
        </select>
      </label>
      {customRoute ? <div className="mt-2 flex flex-wrap gap-2">
        <label className="min-w-48 flex-1 text-sm">Provider ID<Input aria-label="Provider ID" className="mt-1" value={providerId} onChange={(event) => setProviderId(event.target.value)} placeholder="Provider id" /></label>
        <label className="min-w-48 flex-1 text-sm">Model ID<Input aria-label="Model ID" className="mt-1" value={model} onChange={(event) => setModel(event.target.value)} placeholder="Model id" /></label>
      </div> : null}
      <p className="mt-2 text-xs text-muted-foreground">{customRoute ? `Route: ${trimmedProviderId || "—"} · ${trimmedModel || "—"}` : "Route: project default"}</p>
      {customRoute && !routeComplete ? <p className="mt-1 text-xs text-destructive">Provider and model are sent as a pair — fill in both, or switch back to the project default.</p> : null}
    </div>
    <div><label className="mb-1 block text-sm font-medium" htmlFor={`session-name-${workspace.id}`}>Session name <span className="font-normal text-muted-foreground">(optional)</span></label><Input id={`session-name-${workspace.id}`} aria-label="Session name" maxLength={80} value={name} onChange={(event) => setName(event.target.value)} placeholder="Derived from the first line of the prompt" /></div>
    <textarea aria-label="Task prompt" className={`${fieldClass} min-h-28 resize-y`} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Describe the outcome across these repositories…" />
    <Button type="submit" disabled={pending || !prompt.trim() || selected.size === 0 || !eligibleHosts.includes(hostId) || !routeComplete}><Icon name="Play" className="size-4" />{pending ? "Preparing worktrees…" : "Start thread"}</Button>
  </form>;
}

function SessionRow({ session, rpc, onChanged, onError }: {
  session: SessionSnapshot;
  rpc: ReturnType<typeof useRpc<typeof rpcContract>>;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const navigate = useBbNavigate();
  const [pending, setPending] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(session.name ?? "");
  useEffect(() => { setName(session.name ?? ""); }, [session.name]);
  const archive = async () => {
    setPending(true);
    try { await rpc.call("session_archive", { id: session.id }); onChanged(); }
    catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(false); }
  };
  const cleanup = async () => {
    if (!globalThis.confirm("Remove this session's clean worktrees? Repository branches will be preserved.")) return;
    setPending(true);
    try { await rpc.call("session_cleanup", { id: session.id }); onChanged(); }
    catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(false); }
  };
  const saveName = async () => {
    if (!name.trim() || pending) return;
    setPending(true); onError("");
    try {
      const result = await rpc.call("session_rename", { id: session.id, name: name.trim() });
      setName(result.session.name ?? ""); setRenaming(false); onChanged();
      if (!result.threadTitleUpdated && result.session.threadId) onError("Session renamed, but its BB thread title could not be updated.");
    } catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(false); }
  };
  const displayName = session.name ?? `Session · ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(session.createdAt))}`;
  const created = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(session.createdAt));
  return <div className="flex flex-col items-start justify-between gap-3 rounded-lg border border-border px-3 py-2 sm:flex-row sm:items-center">
    <div className="min-w-0 flex-1">{renaming ? <div className="flex max-w-md items-center gap-2"><Input aria-label="Rename session" maxLength={80} value={name} onChange={(event) => setName(event.target.value)} autoFocus /><Button size="sm" disabled={pending || !name.trim()} onClick={saveName}>Save session name</Button><Button size="sm" variant="ghost" disabled={pending} onClick={() => { setName(session.name ?? ""); setRenaming(false); }}>Cancel</Button></div> : <><p className="truncate text-sm font-medium">{displayName}</p><p className="mt-0.5 text-xs text-muted-foreground">{session.state} · {created} · {session.repositories.length} {session.repositories.length === 1 ? "repository" : "repositories"}</p><p className="truncate text-xs text-muted-foreground">{session.repositories.map((repo) => repo.alias).join(", ")}</p></>}{session.error ? <p className="text-xs text-destructive">{session.error}</p> : null}</div>
    <div className="flex shrink-0 flex-wrap gap-2">
      {session.threadId ? <Button variant="outline" size="sm" onClick={() => navigate.toThread(session.threadId!)}>Open thread</Button> : null}
      {!renaming ? <Button variant="ghost" size="sm" disabled={pending} aria-label="Rename session" onClick={() => setRenaming(true)}>Rename</Button> : null}
      {session.state === "active" || session.state === "failed" ? <Button variant="ghost" size="sm" disabled={pending} onClick={archive}>Archive</Button> : null}
      {session.state === "archived" ? <Button variant="ghost" size="sm" disabled={pending} onClick={cleanup}>{pending ? "Checking…" : "Remove worktrees"}</Button> : null}
    </div>
  </div>;
}

function WorkspaceRepositoryApproval({ interaction, submit, cancel }: PluginPendingInteractionProps) {
  const payload = useMemo(() => expansionApprovalPayloadSchema.safeParse(interaction.payload), [interaction.payload]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const pendingRef = useRef(false);
  useEffect(() => { generation.current += 1; pendingRef.current = false; setPending(false); setError(null); }, [interaction.id]);
  const run = async (operation: () => Promise<void>) => {
    if (pendingRef.current) return;
    const requestGeneration = generation.current;
    let failed = false;
    pendingRef.current = true;
    setPending(true); setError(null);
    try { await operation(); }
    catch (cause) {
      failed = true;
      if (generation.current === requestGeneration) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (generation.current === requestGeneration && failed) { pendingRef.current = false; setPending(false); }
    }
  };
  const submitAction = async (action: "add-once" | "add-and-auto" | "cancel") => {
    await run(() => submit(expansionApprovalResponseSchema.parse({ action })));
  };
  const cancelSafely = async () => {
    await run(cancel);
  };
  if (!payload.success) return <div className="space-y-3 rounded-lg border border-destructive/40 p-4">
    <p role="alert" className="text-sm text-destructive">This repository request could not be read safely.</p>
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    <Button variant="ghost" onClick={cancelSafely} disabled={pending}>Cancel</Button>
  </div>;
  return <div className="space-y-3 rounded-lg border border-border p-4">
    <div><h2 className="font-semibold">Add {payload.data.repositoryAlias} to this session?</h2><p className="mt-1 text-sm text-muted-foreground">Workspace: {payload.data.workspaceName}</p><p className="text-sm text-muted-foreground">Repository: {payload.data.repositoryAlias}</p><p className="mt-2 text-sm">{payload.data.reason}</p></div>
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    <div className="flex flex-wrap gap-2"><Button onClick={() => submitAction("add-once")} disabled={pending}>Add this repo</Button><Button onClick={() => submitAction("add-and-auto")} disabled={pending}>Add and auto-approve more</Button><Button variant="ghost" onClick={() => submitAction("cancel")} disabled={pending}>Cancel</Button></div>
  </div>;
}

function WorkspacesPage() {
  const { rpc, dashboard, error, setError, load } = useDashboard();
  const [editing, setEditing] = useState<Workspace | "new" | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [workspaceQuery, setWorkspaceQuery] = useState("");
  const [workspaceFilter, setWorkspaceFilter] = useState<"active" | "pinned" | "archived">("active");
  const [visibleWorkspaceCount, setVisibleWorkspaceCount] = useState(50);
  const workspaces = dashboard?.workspaces ?? [];
  const activeCount = workspaces.filter((workspace) => workspace.archivedAt === null).length;
  const pinnedCount = workspaces.filter((workspace) => workspace.archivedAt === null && workspace.pinned).length;
  const archivedCount = workspaces.filter((workspace) => workspace.archivedAt !== null).length;
  const selected = workspaces.find((workspace) => workspace.id === selectedId)
    ?? workspaces.find((workspace) => workspace.archivedAt === null)
    ?? workspaces[0];
  const filteredWorkspaces = useMemo(() => {
    const query = workspaceQuery.trim().toLocaleLowerCase();
    return workspaces
      .filter((workspace) => workspaceFilter === "archived" ? workspace.archivedAt !== null : workspace.archivedAt === null)
      .filter((workspace) => workspaceFilter !== "pinned" || workspace.pinned)
      .filter((workspace) => !query || workspace.name.toLocaleLowerCase().includes(query)
        || workspace.description.toLocaleLowerCase().includes(query)
        || workspace.repositories.some((repository) => repository.alias.toLocaleLowerCase().includes(query)))
      .sort((left, right) => Number(right.pinned) - Number(left.pinned) || left.name.localeCompare(right.name));
  }, [workspaceFilter, workspaceQuery, workspaces]);
  useEffect(() => { setVisibleWorkspaceCount(50); }, [workspaceFilter, workspaceQuery]);
  const visibleWorkspaces = filteredWorkspaces.slice(0, visibleWorkspaceCount);
  const mutateWorkspace = async (operation: () => Promise<unknown>) => {
    try { await operation(); load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <div className="h-full min-h-0 flex-1 overflow-y-auto"><div className="mx-auto w-full max-w-5xl space-y-4 px-4 pb-8 pt-4">
    <div className="flex items-start justify-between gap-3"><div><h1 className="text-xl font-semibold">Workspaces</h1><p className="text-sm text-muted-foreground">Group related repositories and run one isolated task across the ones you choose.</p></div><Button onClick={() => setEditing("new")}><Icon name="Plus" className="size-4" />New workspace</Button></div>
    {error ? <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}
    <Dialog open={editing !== null} onOpenChange={(open) => { if (!open) setEditing(null); }}><DialogContent className="max-h-[90vh] overflow-y-auto sm:grid-rows-[auto_minmax(0,1fr)] sm:overflow-hidden sm:max-w-2xl">{editing ? <><DialogHeader><DialogTitle>{editing === "new" ? "Create workspace" : "Edit workspace"}</DialogTitle><DialogDescription>Choose the BB projects that should be available together.</DialogDescription></DialogHeader><WorkspaceForm projects={dashboard?.projects ?? []} initial={editing === "new" ? undefined : editing} onCancel={() => setEditing(null)} onSave={async (draft) => { try { editing === "new" ? await rpc.call("workspace_create", draft) : await rpc.call("workspace_update", { id: editing.id, expectedRevision: editing.revision, draft }); setEditing(null); load(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } }} /></> : null}</DialogContent></Dialog>
    {dashboard === null ? <Empty>Loading workspaces…</Empty> : workspaces.length === 0 && !editing ? <Empty>No workspaces yet. Create one to group repositories.</Empty> : <div className="grid gap-4 md:grid-cols-[minmax(240px,0.75fr)_minmax(0,1.6fr)]">
      <aside className="self-start md:sticky md:top-4"><div className="space-y-2 rounded-lg border border-border bg-card p-2"><Input type="search" aria-label="Search workspaces" placeholder="Search workspaces…" value={workspaceQuery} onChange={(event) => setWorkspaceQuery(event.target.value)} /><div className="grid grid-cols-3 gap-1" aria-label="Workspace filters"><Button type="button" size="sm" variant={workspaceFilter === "active" ? "secondary" : "ghost"} onClick={() => setWorkspaceFilter("active")}>Active {activeCount}</Button><Button type="button" size="sm" variant={workspaceFilter === "pinned" ? "secondary" : "ghost"} onClick={() => setWorkspaceFilter("pinned")}>Pinned {pinnedCount}</Button><Button type="button" size="sm" variant={workspaceFilter === "archived" ? "secondary" : "ghost"} onClick={() => setWorkspaceFilter("archived")}>Archived {archivedCount}</Button></div><div className="max-h-[calc(100vh-14rem)] space-y-2 overflow-y-auto pr-1">{visibleWorkspaces.map((workspace) => <button data-testid="workspace-navigation-item" key={workspace.id} onClick={() => setSelectedId(workspace.id)} className={`w-full rounded-lg border p-3 text-left ${selected?.id === workspace.id ? "border-foreground bg-muted" : "border-border bg-card hover:bg-muted/60"}`}><span className="flex items-center justify-between gap-2"><span className="truncate font-medium">{workspace.name}</span>{workspace.pinned ? <Icon name="Pin" className="size-3.5 shrink-0 text-muted-foreground" /> : null}</span><span className="mt-1 block text-xs text-muted-foreground">{workspace.repositories.length} repositories</span></button>)}{visibleWorkspaces.length === 0 ? <div className="px-2 py-6 text-center text-sm text-muted-foreground">{workspaceQuery.trim() ? "No matching workspaces." : `No ${workspaceFilter} workspaces.`}</div> : null}{filteredWorkspaces.length > visibleWorkspaces.length ? <Button type="button" variant="ghost" className="w-full" onClick={() => setVisibleWorkspaceCount((count) => count + 50)}>Show 50 more workspaces</Button> : null}</div></div></aside>
      {selected ? <main className="space-y-4"><div className="rounded-lg border border-border bg-card p-4"><div className="flex items-start justify-between gap-2"><div><h2 className="text-lg font-semibold">{selected.name}</h2><p className="text-sm text-muted-foreground">{selected.description || "No description"}</p></div><div className="flex gap-1">{selected.archivedAt === null ? <><Button variant="ghost" size="sm" onClick={() => setEditing(selected)}>Edit</Button><Button variant="ghost" size="sm" onClick={() => mutateWorkspace(() => rpc.call("workspace_set_pinned", { id: selected.id, expectedRevision: selected.revision, pinned: !selected.pinned }))}>{selected.pinned ? "Unpin" : "Pin"}</Button><Button variant="ghost" size="sm" onClick={async () => { await mutateWorkspace(() => rpc.call("workspace_set_archived", { id: selected.id, expectedRevision: selected.revision, archived: true })); setSelectedId(null); }}>Archive</Button></> : <><Button variant="outline" size="sm" onClick={() => mutateWorkspace(() => rpc.call("workspace_set_archived", { id: selected.id, expectedRevision: selected.revision, archived: false }))}>Restore</Button><Button variant="ghost" size="sm" onClick={() => { if (globalThis.confirm(`Delete workspace “${selected.name}”? Its session history will remain.`)) void mutateWorkspace(() => rpc.call("workspace_remove", { id: selected.id, expectedRevision: selected.revision })); }}>Delete</Button></>}</div></div><div className="mt-3 flex flex-wrap gap-2">{selected.repositories.map((repository) => <span key={repository.projectId} className="rounded-full bg-muted px-2.5 py-1 text-xs">{repository.alias}</span>)}</div></div>
        {selected.archivedAt === null ? <SessionLauncher key={selected.id} workspace={selected} projects={dashboard.projects} rpc={rpc} onError={(message) => setError(message || null)} /> : null}
        <section><h3 className="mb-2 text-sm font-semibold">Sessions</h3>{dashboard.sessions.filter((session) => session.workspaceId === selected.id).length === 0 ? <Empty>No workspace sessions yet.</Empty> : <div className="space-y-2">{dashboard.sessions.filter((session) => session.workspaceId === selected.id).map((session) => <SessionRow key={session.id} session={session} rpc={rpc} onChanged={load} onError={(message) => setError(message)} />)}</div>}</section>
      </main> : null}
    </div>}
  </div></div>;
}

function RepositoriesPanel({ threadId }: { threadId: string }) {
  const { rpc, dashboard, error, load } = useDashboard();
  const session = dashboard?.sessions.find((candidate) => candidate.threadId === threadId);
  const [statuses, setStatuses] = useState<Record<string, { loading?: boolean; error?: string; clean?: boolean; aheadOfBase?: boolean; changedFiles?: Array<{ path: string; status: string }> }>>({});
  const [options, setOptions] = useState<ExpansionOption[] | null>(null);
  const [optionsSessionState, setOptionsSessionState] = useState<SessionSnapshot["state"] | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [adding, setAdding] = useState(false);
  const [baseRef, setBaseRef] = useState(DEFAULT_BASE_REF);
  const baseRefRef = useRef(DEFAULT_BASE_REF);
  const { bases: addBases } = useRepositoryBases(rpc, showAddForm ? session?.hostId ?? "" : "", showAddForm && selectedProjectId ? [selectedProjectId] : []);
  const requestKey = useRef<string | null>(null);
  const submittedOption = useRef<ExpansionOption | null>(null);
  const generation = useRef(0);
  const latestOptionsRequest = useRef(0);
  const currentThreadId = useRef(threadId);
  const latestOptions = useRef<ExpansionOption[]>([]);
  const latestOptionsSessionState = useRef<SessionSnapshot["state"] | null>(null);
  const selectedProjectIdRef = useRef("");
  const addFormOpen = useRef(false);
  const addPending = useRef(false);
  const makeRequestKey = () => `manual-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const closeAddForm = useCallback((clearRequestKey = true) => {
    addFormOpen.current = false; selectedProjectIdRef.current = "";
    if (clearRequestKey) { requestKey.current = null; submittedOption.current = null; }
    setShowAddForm(false); setSelectedProjectId("");
    baseRefRef.current = DEFAULT_BASE_REF; setBaseRef(DEFAULT_BASE_REF);
  }, []);
  useEffect(() => {
    generation.current += 1; currentThreadId.current = threadId;
    latestOptionsRequest.current += 1;
    latestOptions.current = []; latestOptionsSessionState.current = null;
    addPending.current = false; requestKey.current = null;
    submittedOption.current = null;
    addFormOpen.current = false; selectedProjectIdRef.current = "";
    setOptions(null); setOptionsSessionState(null); setOptionsError(null); setShowAddForm(false); setSelectedProjectId(""); setAdding(false);
  }, [threadId]);
  const loadOptions = useCallback(async () => {
    const requestGeneration = generation.current;
    const requestSequence = latestOptionsRequest.current + 1;
    latestOptionsRequest.current = requestSequence;
    try {
      const result = await rpc.call("session_expansion_options", { threadId });
      if (generation.current !== requestGeneration || currentThreadId.current !== threadId || latestOptionsRequest.current !== requestSequence) return;
      latestOptions.current = result.repositories; latestOptionsSessionState.current = result.session.state;
      setOptions(result.repositories); setOptionsSessionState(result.session.state); setOptionsError(null);
      const completed = result.session.expansions.some((expansion) => expansion.requestKey === requestKey.current && (expansion.outcome === "provisioned" || expansion.outcome === "superseded"));
      if (completed) closeAddForm();
      else if (result.session.state !== "active" || (addFormOpen.current && !submittedOption.current && !result.repositories.some((option) => option.projectId === selectedProjectIdRef.current))) closeAddForm(false);
    } catch (cause) {
      if (generation.current === requestGeneration && currentThreadId.current === threadId && latestOptionsRequest.current === requestSequence) setOptionsError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [closeAddForm, rpc, threadId]);
  useEffect(() => { void loadOptions(); }, [loadOptions]);
  useRealtime("workspaces-changed", loadOptions);
  const refresh = async (projectId: string) => {
    setStatuses((current) => ({ ...current, [projectId]: { loading: true } }));
    try { const status = await rpc.call("session_repository_status", { sessionId: session!.id, projectId }); setStatuses((current) => ({ ...current, [projectId]: status })); }
    catch (cause) { setStatuses((current) => ({ ...current, [projectId]: { error: cause instanceof Error ? cause.message : String(cause) } })); }
  };
  const openAddForm = () => {
    if (session?.state !== "active" || latestOptionsSessionState.current !== "active" || !options?.length) return;
    baseRefRef.current = DEFAULT_BASE_REF; setBaseRef(DEFAULT_BASE_REF);
    if (requestKey.current === null) requestKey.current = makeRequestKey();
    const projectId = options[0]!.projectId;
    if (submittedOption.current && submittedOption.current.projectId !== projectId) { requestKey.current = makeRequestKey(); submittedOption.current = null; }
    selectedProjectIdRef.current = projectId; addFormOpen.current = true;
    setSelectedProjectId(projectId); setShowAddForm(true); setOptionsError(null);
  };
  const addRepository = async (event: FormEvent) => {
    event.preventDefault();
    const option = latestOptions.current.find((candidate) => candidate.projectId === selectedProjectIdRef.current) ?? submittedOption.current;
    if (addPending.current || session?.state !== "active" || latestOptionsSessionState.current !== "active" || !option || requestKey.current === null) return;
    const requestGeneration = generation.current;
    const key = requestKey.current;
    submittedOption.current = option;
    addPending.current = true;
    setAdding(true); setOptionsError(null);
    try {
      const result = await rpc.call("session_add_repository", { threadId, projectId: option.projectId, requestKey: key, baseRef: baseRefRef.current });
      if (generation.current !== requestGeneration || currentThreadId.current !== threadId) return;
      if (result.outcome !== "provisioned" && result.outcome !== "superseded") {
        setOptionsError(result.error ?? (result.outcome === "pending" ? "Repository addition is pending recovery. Retry this request." : result.outcome === "cancelled" ? "Repository request was cancelled." : "Repository addition failed."));
        return;
      }
      requestKey.current = makeRequestKey();
      submittedOption.current = null;
      closeAddForm(false);
      load(); await loadOptions();
    } catch (cause) {
      if (generation.current === requestGeneration && currentThreadId.current === threadId) setOptionsError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (generation.current === requestGeneration && currentThreadId.current === threadId) { addPending.current = false; setAdding(false); }
    }
  };
  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!dashboard) return <p className="text-sm text-muted-foreground">Loading repositories…</p>;
  if (!session) return <Empty>This thread was not launched from a multi-repository workspace session.</Empty>;
  if (session.state === "cleaned") return <Empty>This session's worktrees were removed. Its repository branches are still available.</Empty>;
  const changeBase = (ref: string) => { baseRefRef.current = ref; setBaseRef(ref); };
  const changeTarget = (projectId: string) => {
    if (selectedProjectIdRef.current !== projectId) { requestKey.current = makeRequestKey(); submittedOption.current = null; changeBase(DEFAULT_BASE_REF); }
    selectedProjectIdRef.current = projectId;
    setSelectedProjectId(projectId);
  };
  const activeForAddition = session.state === "active" && optionsSessionState === "active";
  const displayedOptions = submittedOption.current && !options?.some((option) => option.projectId === submittedOption.current!.projectId)
    ? [...(options ?? []), submittedOption.current] : options;
  const memberOptions = displayedOptions?.filter((option) => option.member) ?? [];
  const otherOptions = displayedOptions?.filter((option) => !option.member) ?? [];
  const pendingOption = displayedOptions?.find((option) => option.projectId === selectedProjectId);
  return <div className="space-y-3"><div className="rounded-lg border border-border p-3"><div className="flex items-center justify-between gap-2"><div><h2 className="font-medium">Add a repository</h2><p className="text-xs text-muted-foreground">Workspace repositories are checked out directly. Any other project joins the workspace first, then this session.</p></div>{activeForAddition && options && options.length > 0 && !showAddForm ? <Button size="sm" onClick={openAddForm}>Add repository</Button> : null}</div>{activeForAddition && options?.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">Every project on this session’s host is already checked out here.</p> : null}{optionsError ? <p role="alert" className="mt-2 text-sm text-destructive">{optionsError}</p> : null}{showAddForm && activeForAddition ? <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={addRepository}><label className="text-sm" htmlFor="repository-to-add">Repository to add<select id="repository-to-add" className={`${fieldClass} mt-1`} value={selectedProjectId} onChange={(event) => changeTarget(event.target.value)} disabled={adding}>{memberOptions.length ? <optgroup label="In this workspace">{memberOptions.map((option) => <option key={option.projectId} value={option.projectId}>{option.alias} — {option.projectName}</option>)}</optgroup> : null}{otherOptions.length ? <optgroup label="Other projects">{otherOptions.map((option) => <option key={option.projectId} value={option.projectId}>{option.alias} — {option.projectName}</option>)}</optgroup> : null}</select></label>{addBases?.[selectedProjectId] ? <label className="text-sm" htmlFor="repository-base">Branch from<select id="repository-base" className={`${fieldClass} mt-1`} value={baseRef} onChange={(event) => changeBase(event.target.value)} disabled={adding}>{baseOptions(addBases[selectedProjectId]!).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label> : null}<Button type="submit" disabled={adding || !selectedProjectId}>{adding ? "Adding…" : "Add selected repository"}</Button><Button type="button" variant="ghost" disabled={adding} onClick={() => closeAddForm()}>Cancel</Button>{pendingOption && !pendingOption.member ? <p className="w-full text-xs text-muted-foreground">{pendingOption.projectName} also joins workspace “{session.workspaceName}” as {pendingOption.alias}.</p> : null}</form> : null}</div>{session.repositories.map((repository) => { const status = statuses[repository.projectId]; return <section key={repository.projectId} className="rounded-lg border border-border p-3"><div className="flex items-center justify-between gap-2"><div><h3 className="font-medium">{repository.alias}</h3><p className="font-mono text-xs text-muted-foreground">{repository.branch ?? repository.worktreePath}</p>{repository.baseRef ? <p className="text-xs text-muted-foreground">from {repository.baseRef}{repository.baseCommit ? ` · ${repository.baseCommit.slice(0, 8)}` : ""}</p> : null}</div><Button variant="outline" size="sm" onClick={() => refresh(repository.projectId)} disabled={status?.loading}>{status?.loading ? "Refreshing…" : "Refresh"}</Button></div>{status?.error ? <p className="mt-2 text-xs text-destructive">{status.error}</p> : status?.changedFiles ? <div className="mt-2"><p className="text-xs text-muted-foreground">{status.clean ? "Clean" : `${status.changedFiles.length} changed files${status.aheadOfBase ? ", commits ahead" : ""}`}</p><ul className="mt-1 space-y-1">{status.changedFiles.map((file) => <li key={`${file.status}:${file.path}`} className="flex gap-2 text-xs"><span className="w-16 text-muted-foreground">{file.status}</span><code className="min-w-0 break-all">{file.path}</code></li>)}</ul></div> : null}</section>; })}</div>;
}

export default definePluginApp((app) => {
  app.slots.navPanel({ id: "workspaces", title: "Workspaces", icon: "Layers", path: "workspaces", component: WorkspacesPage });
  app.slots.threadPanelAction({ id: "repositories", title: "Repositories", icon: "FolderGit", component: RepositoriesPanel });
  app.slots.pendingInteraction({ id: "workspace-add-repository", component: WorkspaceRepositoryApproval });
});
