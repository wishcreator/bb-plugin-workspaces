// @vitest-environment jsdom
import { act, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

const project = {
  id: "proj_auth",
  name: "identity-service",
  gitRemoteUrl: "https://example.invalid/identity.git",
  sources: [{ id: "src_auth", hostId: "host_local", path: "/repos/identity", isDefault: true }],
};

const gatewayProject = {
  id: "proj_gateway",
  name: "api-gateway",
  gitRemoteUrl: "https://example.invalid/gateway.git",
  sources: [{ id: "src_gateway", hostId: "host_local", path: "/repos/gateway", isDefault: true }],
};

const workspace = {
  id: "ws_auth",
  name: "Authentication",
  description: "",
  instructions: "",
  revision: 1,
  pinned: false,
  archivedAt: null as number | null,
  createdAt: 1,
  updatedAt: 1,
  repositories: [
    { projectId: "proj_auth", alias: "identity", ordinal: 0 },
    { projectId: "proj_gateway", alias: "gateway", ordinal: 1 },
  ],
};

const activeSession = {
  id: "session_auth",
  name: "Rotate signing keys",
  workspaceId: "ws_auth",
  workspaceName: "Authentication",
  workspaceRevision: 1,
  instructions: "",
  repositories: [{ projectId: "proj_auth", alias: "identity", branch: "workspace/identity", worktreePath: "/worktrees/identity" }],
  initialRepositories: [{ projectId: "proj_auth", alias: "identity" }],
  expansionPolicy: "ask" as const,
  expansions: [],
  manifestRevision: 1,
  state: "active" as const,
  hostId: "host_local",
  rootPath: "/worktrees",
  ownerProjectId: "proj_auth",
  threadId: "thr_auth",
  error: null,
  createdAt: 1,
  updatedAt: 1,
};

const expansionOption = {
  projectId: "proj_gateway",
  alias: "gateway",
  projectName: "api-gateway",
  sourcePath: "/repos/gateway",
  member: true,
};

const billingOption = {
  projectId: "proj_billing",
  alias: "billing",
  projectName: "billing-service",
  sourcePath: "/repos/billing",
  member: true,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

describe("repository approval interaction", () => {
  const validPayload = {
    sessionId: "session_auth",
    workspaceName: "Authentication",
    repositoryAlias: "gateway",
    repositoryName: "api-gateway",
    reason: "The task needs gateway routes.",
  };

  it.each([
    ["Add this repo", { action: "add-once" }],
    ["Add and auto-approve more", { action: "add-and-auto" }],
    ["Cancel", { action: "cancel" }],
  ])("submits %s from a validated approval request", async (label, expected) => {
    const app = await loadPluginApp(() => import("../app"));
    const submissions: unknown[] = [];
    const slot = renderSlot(app.pendingInteractions.find((registration) => registration.id === "workspace-add-repository")!, {
      interaction: { id: "approval-1", threadId: "thr_auth", title: "Add repository", payload: validPayload, createdAt: 1, expiresAt: null },
      submit: async (value: unknown) => { submissions.push(value); },
      cancel: async () => {},
    });

    expect(await slot.findByText("Workspace: Authentication")).toBeTruthy();
    expect(slot.getByText("Repository: gateway")).toBeTruthy();
    expect(slot.getByText("The task needs gateway routes.")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: label }));

    await expect.poll(() => submissions).toContainEqual(expected);
    slot.lifecycle.unmount();
  });

  it("rejects malformed approval payloads and only offers safe host cancellation", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const submissions: unknown[] = [];
    let cancellations = 0;
    const slot = renderSlot(app.pendingInteractions.find((registration) => registration.id === "workspace-add-repository")!, {
      interaction: { id: "approval-invalid", threadId: "thr_auth", title: "Add repository", payload: { workspaceName: "spoofed" }, createdAt: 1, expiresAt: null },
      submit: async (value: unknown) => { submissions.push(value); },
      cancel: async () => { cancellations += 1; },
    });

    expect(await slot.findByRole("alert")).toBeTruthy();
    expect(slot.queryByRole("button", { name: "Add this repo" })).toBeNull();
    expect(slot.queryByRole("button", { name: "Add and auto-approve more" })).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Cancel" }));

    await expect.poll(() => cancellations).toBe(1);
    expect(submissions).toEqual([]);
    slot.lifecycle.unmount();
  });

  it.each([
    ["submit", validPayload, "Add this repo"],
    ["cancel", { workspaceName: "malformed" }, "Cancel"],
  ])("does not let stale %s completion overwrite a replacement interaction", async (kind, payload, buttonName) => {
    const app = await loadPluginApp(() => import("../app"));
    const approval = app.pendingInteractions.find((registration) => registration.id === "workspace-add-repository")!;
    const stale = deferred<void>();
    const current = deferred<void>();
    const slot = renderSlot(approval, {
      interaction: { id: "approval-a", threadId: "thr_auth", title: "Add repository", payload, createdAt: 1, expiresAt: null },
      submit: async () => kind === "submit" ? stale.promise : undefined,
      cancel: async () => kind === "cancel" ? stale.promise : undefined,
    });

    fireEvent.click(await slot.findByRole("button", { name: buttonName }));
    const Approval = approval.component;
    slot.lifecycle.rerender(<Approval interaction={{ id: "approval-b", threadId: "thr_auth", title: "Add repository", payload: validPayload, createdAt: 2, expiresAt: null }} submit={async () => current.promise} cancel={async () => {}} />);
    fireEvent.click(await slot.findByRole("button", { name: "Add and auto-approve more" }));
    expect(slot.getByRole("button", { name: "Add and auto-approve more" }).hasAttribute("disabled")).toBe(true);

    await act(async () => { stale.reject(new Error("stale completion")); await stale.promise.catch(() => {}); });
    expect(slot.queryByRole("alert")).toBeNull();
    expect(slot.getByRole("button", { name: "Add and auto-approve more" }).hasAttribute("disabled")).toBe(true);
    await act(async () => { current.resolve(); await current.promise; });
    slot.lifecycle.unmount();
  });
});

describe("Workspaces page", () => {
  beforeEach(() => globalThis.localStorage.clear());

  it("creates a workspace from selected BB projects", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const calls: unknown[] = [];
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      rpc: {
        dashboard: () => ({ workspaces: [], sessions: [], projects: [project] }),
        workspace_create: (input: unknown) => {
          calls.push(input);
          return { id: "ws_auth", revision: 1 };
        },
      },
    });

    fireEvent.click(await slot.findByRole("button", { name: /new workspace/i }));
    expect(await slot.findByRole("dialog", { name: /create workspace/i })).toBeTruthy();
    fireEvent.change(slot.getByLabelText("Workspace name"), { target: { value: "Authentication" } });
    fireEvent.click(slot.getByRole("checkbox", { name: /identity-service/i }));
    fireEvent.click(slot.getByRole("button", { name: /create workspace/i }));

    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0]).toEqual({
      name: "Authentication",
      description: "",
      instructions: "",
      repositories: [{ projectId: "proj_auth", alias: "identity-service" }],
    });
    slot.lifecycle.unmount();
  });

  it("searches hundreds of repositories and keeps selection visible across filters", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const projects = Array.from({ length: 250 }, (_, index) => ({
      ...project,
      id: `proj_${index}`,
      name: `service-${String(index).padStart(3, "0")}`,
      sources: [{ ...project.sources[0]!, id: `src_${index}`, path: `/repos/group-${Math.floor(index / 10)}/service-${index}` }],
    }));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: {
      dashboard: () => ({ workspaces: [], sessions: [], projects }),
    } });

    fireEvent.click(await slot.findByRole("button", { name: /new workspace/i }));
    expect(await slot.findByText("0 / 100 selected")).toBeTruthy();
    fireEvent.change(slot.getByRole("searchbox", { name: "Search repositories" }), { target: { value: "group-24" } });
    expect(slot.getAllByRole("checkbox")).toHaveLength(10);
    fireEvent.click(slot.getByRole("button", { name: "Select visible" }));
    expect(slot.getByText("10 / 100 selected")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Selected repositories" }));
    expect(slot.getAllByRole("checkbox")).toHaveLength(10);
    expect(slot.getByText("service-240")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Clear visible" }));
    expect(slot.getByText("0 / 100 selected")).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("enforces the workspace repository limit during bulk selection", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const projects = Array.from({ length: 125 }, (_, index) => ({
      ...project,
      id: `proj_${index}`,
      name: `service-${index}`,
      sources: [{ ...project.sources[0]!, id: `src_${index}`, path: `/repos/service-${index}` }],
    }));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: {
      dashboard: () => ({ workspaces: [], sessions: [], projects }),
    } });

    fireEvent.click(await slot.findByRole("button", { name: /new workspace/i }));
    fireEvent.click(await slot.findByRole("button", { name: "Select visible" }));
    expect(slot.getByText("100 / 100 selected")).toBeTruthy();
    expect(slot.getByText("25 visible repositories were not selected because a workspace can contain at most 100.")).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("selects every workspace repository initially and remembers a changed subset", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const rpc = {
      dashboard: () => ({ workspaces: [workspace], sessions: [], projects: [project, gatewayProject] }),
    };
    const first = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc });

    const identity = await first.findByRole("checkbox", { name: "Use identity-service" });
    const gateway = first.getByRole("checkbox", { name: "Use api-gateway" });
    expect(identity.getAttribute("data-state")).toBe("checked");
    expect(gateway.getAttribute("data-state")).toBe("checked");
    expect(first.queryByText("Primary repository")).toBeNull();
    fireEvent.click(gateway);
    expect(gateway.getAttribute("data-state")).toBe("unchecked");
    first.lifecycle.unmount();

    const reopened = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc });
    expect((await reopened.findByRole("checkbox", { name: "Use identity-service" })).getAttribute("data-state")).toBe("checked");
    expect(reopened.getByRole("checkbox", { name: "Use api-gateway" }).getAttribute("data-state")).toBe("unchecked");
    reopened.lifecycle.unmount();
  });

  it("searches, filters, and progressively reveals a large workspace collection", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const workspaces = Array.from({ length: 120 }, (_, index) => ({
      ...workspace,
      id: `ws_${index}`,
      name: `Workspace ${String(index).padStart(3, "0")}`,
      description: index === 77 ? "Payments platform" : "",
      pinned: index === 119,
      repositories: [{ projectId: "proj_auth", alias: index === 88 ? "rare-repository" : `repo-${index}`, ordinal: 0 }],
    }));
    workspaces.push({ ...workspace, id: "ws_archived", name: "Retired workspace", archivedAt: 99 });
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: {
      dashboard: () => ({ workspaces, sessions: [], projects: [project, gatewayProject] }),
    } });

    expect(await slot.findByRole("searchbox", { name: "Search workspaces" })).toBeTruthy();
    expect(slot.getByRole("button", { name: "Active 120" })).toBeTruthy();
    expect(slot.getByRole("button", { name: "Pinned 1" })).toBeTruthy();
    expect(slot.getByRole("button", { name: "Archived 1" })).toBeTruthy();
    expect(slot.getAllByTestId("workspace-navigation-item")).toHaveLength(50);
    expect(slot.getAllByTestId("workspace-navigation-item")[0]?.textContent).toContain("Workspace 119");
    fireEvent.click(slot.getByRole("button", { name: "Show 50 more workspaces" }));
    expect(slot.getAllByTestId("workspace-navigation-item")).toHaveLength(100);

    fireEvent.change(slot.getByRole("searchbox", { name: "Search workspaces" }), { target: { value: "rare-repository" } });
    expect(slot.getAllByTestId("workspace-navigation-item")).toHaveLength(1);
    expect(slot.getByText("Workspace 088")).toBeTruthy();
    expect(slot.getByRole("heading", { name: "Workspace 000" })).toBeTruthy();
    fireEvent.change(slot.getByRole("searchbox", { name: "Search workspaces" }), { target: { value: "" } });
    fireEvent.click(slot.getByRole("button", { name: "Archived 1" }));
    fireEvent.click(slot.getByText("Retired workspace"));
    expect(slot.getByRole("button", { name: "Restore" })).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("defaults every repository to its default branch and sends a chosen override", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const launches: Array<{ bases: Record<string, string> }> = [];
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: {
      dashboard: () => ({ workspaces: [workspace], sessions: [activeSession], projects: [project, gatewayProject] }),
      repository_bases: () => ({ repositories: [
        { projectId: "proj_auth", defaultBase: "origin/master", currentBranch: "feature/work", currentCommit: "a".repeat(40), refs: ["origin/master", "feature/work", "origin/release"], fetchError: null },
        { projectId: "proj_gateway", defaultBase: "origin/main", currentBranch: "main", currentCommit: "b".repeat(40), refs: ["origin/main"], fetchError: null },
      ] }),
      session_start: (input: unknown) => { launches.push(input as { bases: Record<string, string> }); return activeSession; },
    } });

    expect(await slot.findByText("Branching from each repository's default branch, freshly fetched.")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Change base" }));
    fireEvent.change(await slot.findByLabelText("Base for identity-service"), { target: { value: "feature/work" } });
    expect(slot.getByText("Using a custom base for at least one repository.")).toBeTruthy();

    fireEvent.change(slot.getByLabelText("Task prompt"), { target: { value: "Deploy the contract" } });
    fireEvent.click(slot.getByRole("button", { name: "Start thread" }));
    await expect.poll(() => launches).toHaveLength(1);
    expect(launches[0]!.bases).toEqual({ proj_auth: "feature/work", proj_gateway: "@default" });
    slot.lifecycle.unmount();
  });

  it("starts and renames a session with a meaningful name", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const launches: unknown[] = [];
    const renames: unknown[] = [];
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: {
      dashboard: () => ({ workspaces: [workspace], sessions: [activeSession], projects: [project, gatewayProject] }),
      session_start: (input: unknown) => { launches.push(input); return activeSession; },
      session_rename: (input: unknown) => { renames.push(input); return { session: { ...activeSession, name: "Gateway verification" }, threadTitleUpdated: true }; },
    } });

    expect(await slot.findByText("Rotate signing keys")).toBeTruthy();
    fireEvent.change(slot.getByLabelText("Session name"), { target: { value: "Auth rollout" } });
    fireEvent.change(slot.getByLabelText("Task prompt"), { target: { value: "Deploy the contract" } });
    fireEvent.click(slot.getByRole("button", { name: "Start thread" }));
    await expect.poll(() => launches).toHaveLength(1);
    expect(launches[0]).toMatchObject({ name: "Auth rollout", prompt: "Deploy the contract" });

    fireEvent.click(slot.getByRole("button", { name: "Rename session" }));
    fireEvent.change(slot.getByLabelText("Rename session"), { target: { value: "Gateway verification" } });
    fireEvent.click(slot.getByRole("button", { name: "Save session name" }));
    await expect.poll(() => renames).toEqual([{ id: "session_auth", name: "Gateway verification" }]);
    slot.lifecycle.unmount();
  });

  it("gives migrated unnamed sessions a dated fallback label", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: {
      dashboard: () => ({ workspaces: [workspace], sessions: [{ ...activeSession, name: null }], projects: [project, gatewayProject] }),
    } });

    expect(await slot.findByText(/^Session · /)).toBeTruthy();
    expect(slot.getByText(/active · .* · 1 repository/)).toBeTruthy();
    expect(slot.getByRole("button", { name: "Rename session" })).toBeTruthy();
    slot.lifecycle.unmount();
  });
});

describe("Session route picker", () => {
  beforeEach(() => globalThis.localStorage.clear());

  const billingWorkspace = {
    ...workspace,
    id: "ws_billing",
    name: "Billing",
    repositories: [{ projectId: "proj_gateway", alias: "gateway", ordinal: 0 }],
  };

  it("forwards an explicit provider and model pair to session_start", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const launches: Array<Record<string, unknown>> = [];
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: {
      dashboard: () => ({ workspaces: [workspace], sessions: [], projects: [project, gatewayProject] }),
      session_start: (input: unknown) => { launches.push(input as Record<string, unknown>); return activeSession; },
    } });

    expect(await slot.findByText("Route: project default")).toBeTruthy();
    fireEvent.change(slot.getByLabelText("Agent route"), { target: { value: "explicit" } });
    fireEvent.change(slot.getByLabelText("Provider ID"), { target: { value: "acp-oxi-devin-pool" } });
    fireEvent.change(slot.getByLabelText("Model ID"), { target: { value: "acp-default" } });
    expect(slot.getByText("Route: acp-oxi-devin-pool · acp-default")).toBeTruthy();
    fireEvent.change(slot.getByLabelText("Task prompt"), { target: { value: "Rotate the signing keys" } });
    fireEvent.click(slot.getByRole("button", { name: "Start thread" }));

    await expect.poll(() => launches).toHaveLength(1);
    expect(launches[0]).toMatchObject({ providerId: "acp-oxi-devin-pool", model: "acp-default" });
    expect(launches[0]).not.toHaveProperty("permissionMode");
    slot.lifecycle.unmount();
  });

  it("omits provider and model entirely for the project default route", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const launches: Array<Record<string, unknown>> = [];
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: {
      dashboard: () => ({ workspaces: [workspace], sessions: [], projects: [project, gatewayProject] }),
      session_start: (input: unknown) => { launches.push(input as Record<string, unknown>); return activeSession; },
    } });

    expect(await slot.findByText("Route: project default")).toBeTruthy();
    fireEvent.change(slot.getByLabelText("Task prompt"), { target: { value: "Rotate the signing keys" } });
    fireEvent.click(slot.getByRole("button", { name: "Start thread" }));

    await expect.poll(() => launches).toHaveLength(1);
    expect(launches[0]).not.toHaveProperty("providerId");
    expect(launches[0]).not.toHaveProperty("model");
    slot.lifecycle.unmount();
  });

  it.each([
    ["Provider ID", "acp-oxi-devin-pool"],
    ["Model ID", "acp-default"],
  ])("cannot dispatch with only %s filled", async (label, value) => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: {
      dashboard: () => ({ workspaces: [workspace], sessions: [], projects: [project, gatewayProject] }),
      session_start: () => activeSession,
    } });

    fireEvent.change(await slot.findByLabelText("Agent route"), { target: { value: "explicit" } });
    fireEvent.change(slot.getByLabelText(label), { target: { value } });
    fireEvent.change(slot.getByLabelText("Task prompt"), { target: { value: "Rotate the signing keys" } });
    expect(slot.getByText(/sent as a pair/)).toBeTruthy();
    const startButton = slot.getByRole("button", { name: "Start thread" });
    expect(startButton.hasAttribute("disabled")).toBe(true);
    fireEvent.click(startButton);
    fireEvent.submit(startButton.closest("form")!);
    await act(async () => { await Promise.resolve(); });

    expect(slot.inspection.rpcCalls.filter((call) => call.method === "session_start")).toHaveLength(0);
    slot.lifecycle.unmount();
  });

  it("restores a workspace's explicit route without leaking it to another workspace", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const launches: Array<Record<string, unknown>> = [];
    const rpc = {
      dashboard: () => ({ workspaces: [workspace, billingWorkspace], sessions: [], projects: [project, gatewayProject] }),
      session_start: (input: unknown) => { launches.push(input as Record<string, unknown>); return activeSession; },
    };
    const first = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc });
    fireEvent.change(await first.findByLabelText("Agent route"), { target: { value: "explicit" } });
    fireEvent.change(first.getByLabelText("Provider ID"), { target: { value: "acp-oxi-devin-pool" } });
    fireEvent.change(first.getByLabelText("Model ID"), { target: { value: "acp-default" } });
    first.lifecycle.unmount();

    const second = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc });
    expect((await second.findByLabelText("Agent route") as HTMLSelectElement).value).toBe("explicit");
    expect((second.getByLabelText("Provider ID") as HTMLInputElement).value).toBe("acp-oxi-devin-pool");
    expect((second.getByLabelText("Model ID") as HTMLInputElement).value).toBe("acp-default");
    expect(second.getByText("Route: acp-oxi-devin-pool · acp-default")).toBeTruthy();
    expect(globalThis.localStorage.getItem("bb-workspaces:route:ws_billing")).toBeNull();

    fireEvent.click(second.getByText("Billing"));
    expect((await second.findByLabelText("Agent route") as HTMLSelectElement).value).toBe("project");
    expect(second.getByText("Route: project default")).toBeTruthy();
    expect(second.queryByLabelText("Provider ID")).toBeNull();
    fireEvent.change(second.getByLabelText("Task prompt"), { target: { value: "Audit the invoices" } });
    fireEvent.click(second.getByRole("button", { name: "Start thread" }));
    await expect.poll(() => launches).toHaveLength(1);
    expect(launches[0]).not.toHaveProperty("providerId");
    expect(launches[0]).not.toHaveProperty("model");
    second.lifecycle.unmount();
  });
});

describe("Repositories panel", () => {
  it("keeps a pending request retryable when reconciliation removes its option", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const calls: Array<{ requestKey: string }> = [];
    let available = true;
    const slot = renderSlot(app.threadPanelActions[0]!, { threadId: "thr_auth", params: null }, { rpc: {
      dashboard: () => ({ workspaces: [workspace], sessions: [activeSession], projects: [project, gatewayProject] }),
      session_expansion_options: () => ({ session: activeSession, repositories: available ? [expansionOption] : [] }),
      session_add_repository: (input: unknown) => { calls.push(input as typeof calls[number]); return { added: false, outcome: "pending", error: "Pending database recovery", alias: "gateway", worktreePath: null, policy: "ask", session: activeSession }; },
    } });
    fireEvent.click(await slot.findByRole("button", { name: "Add repository" }));
    fireEvent.click(await slot.findByRole("button", { name: "Add selected repository" }));
    await slot.findByRole("alert");
    available = false;
    await slot.behavior.emitRealtime("workspaces-changed", { at: 9 });
    expect(slot.getByLabelText("Repository to add")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Add selected repository" }));
    await expect.poll(() => calls.length).toBe(2);
    expect(calls[1]!.requestKey).toBe(calls[0]!.requestKey);
    slot.lifecycle.unmount();
  });
  it.each(["failed", "pending", "cancelled"])("retains request identity after a resolved %s result and rotates on deliberate target change", async (outcome) => {
    const app = await loadPluginApp(() => import("../app"));
    const calls: Array<{ projectId: string; requestKey: string }> = [];
    const slot = renderSlot(app.threadPanelActions[0]!, { threadId: "thr_auth", params: null }, { rpc: {
      dashboard: () => ({ workspaces: [workspace], sessions: [activeSession], projects: [project, gatewayProject] }),
      session_expansion_options: () => ({ session: activeSession, repositories: [expansionOption, billingOption] }),
      session_add_repository: (input: unknown) => { calls.push(input as typeof calls[number]); return { added: false, outcome, error: "Please retry this request", alias: "gateway", worktreePath: null, policy: "ask", session: activeSession }; },
    } });
    fireEvent.click(await slot.findByRole("button", { name: "Add repository" }));
    fireEvent.click(await slot.findByRole("button", { name: "Add selected repository" }));
    await slot.findByRole("alert");
    expect(slot.getByLabelText("Repository to add")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Add selected repository" }));
    await expect.poll(() => calls.length).toBe(2);
    expect(calls[1]!.requestKey).toBe(calls[0]!.requestKey);
    await expect.poll(() => slot.getByRole("button", { name: "Add selected repository" }).hasAttribute("disabled")).toBe(false);
    fireEvent.change(slot.getByLabelText("Repository to add"), { target: { value: "proj_billing" } });
    fireEvent.click(slot.getByRole("button", { name: "Add selected repository" }));
    await expect.poll(() => calls.length).toBe(3);
    expect(calls[2]!.requestKey).not.toBe(calls[1]!.requestKey);
    slot.lifecycle.unmount();
  });
  it("groups unenrolled projects separately and warns that picking one joins the workspace", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const newcomerOption = { projectId: "proj_reporting", alias: "reporting", projectName: "reporting-service", sourcePath: "/repos/reporting", member: false };
    const slot = renderSlot(app.threadPanelActions[0]!, { threadId: "thr_auth", params: null }, {
      rpc: {
        dashboard: () => ({ workspaces: [workspace], sessions: [activeSession], projects: [project, gatewayProject] }),
        session_expansion_options: () => ({ session: activeSession, repositories: [expansionOption, newcomerOption] }),
      },
    });

    fireEvent.click(await slot.findByRole("button", { name: "Add repository" }));
    const select = await slot.findByLabelText("Repository to add");
    expect(Array.from(select.querySelectorAll("optgroup"), (group) => group.getAttribute("label"))).toEqual(["In this workspace", "Other projects"]);
    expect(slot.queryByText(/joins workspace/)).toBeNull();

    fireEvent.change(select, { target: { value: "proj_reporting" } });
    expect((await slot.findByText(/joins workspace/)).textContent).toBe("reporting-service also joins workspace “Authentication” as reporting.");
    slot.lifecycle.unmount();
  });

  it("adds a trusted eligible repository once and refreshes the displayed session", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const additions: Array<{ threadId: string; projectId: string; requestKey: string }> = [];
    let dashboardCalls = 0;
    const addedSession = { ...activeSession, repositories: [...activeSession.repositories, { projectId: "proj_gateway", alias: "gateway", branch: "workspace/gateway", worktreePath: "/worktrees/gateway" }] };
    const slot = renderSlot(app.threadPanelActions[0]!, { threadId: "thr_auth", params: null }, {
      rpc: {
        dashboard: () => ({ workspaces: [workspace], sessions: [dashboardCalls++ < 1 ? activeSession : addedSession], projects: [project, gatewayProject] }),
        session_expansion_options: () => ({ session: activeSession, repositories: [expansionOption] }),
        session_add_repository: (input: unknown) => {
          additions.push(input as { threadId: string; projectId: string; requestKey: string });
          return { added: true, outcome: "provisioned", error: null, alias: "gateway", worktreePath: "/worktrees/gateway", policy: "ask", session: addedSession };
        },
      },
    });

    fireEvent.click(await slot.findByRole("button", { name: "Add repository" }));
    const select = await slot.findByLabelText("Repository to add");
    fireEvent.change(select, { target: { value: "proj_gateway" } });
    fireEvent.click(slot.getByRole("button", { name: "Add selected repository" }));

    await expect.poll(() => additions).toHaveLength(1);
    expect(additions[0]).toMatchObject({ threadId: "thr_auth", projectId: "proj_gateway" });
    expect(additions[0]!.requestKey).toMatch(/^manual-/);
    expect(await slot.findByText("gateway")).toBeTruthy();
    expect(slot.inspection.rpcCalls.filter((call) => call.method === "dashboard").length).toBeGreaterThan(1);
    slot.lifecycle.unmount();
  });

  it("keeps its request key for a retry and disables duplicate submissions while pending", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const additions: Array<{ threadId: string; projectId: string; requestKey: string }> = [];
    let attempt = 0;
    const slot = renderSlot(app.threadPanelActions[0]!, { threadId: "thr_auth", params: null }, {
      rpc: {
        dashboard: () => ({ workspaces: [workspace], sessions: [activeSession], projects: [project, gatewayProject] }),
        session_expansion_options: () => ({ session: activeSession, repositories: [expansionOption] }),
        session_add_repository: async (input: unknown) => {
          additions.push(input as { threadId: string; projectId: string; requestKey: string });
          if (attempt++ === 0) throw new Error("Temporary host error");
          return { added: true, outcome: "provisioned", error: null, alias: "gateway", worktreePath: "/worktrees/gateway", policy: "ask", session: activeSession };
        },
      },
    });

    fireEvent.click(await slot.findByRole("button", { name: "Add repository" }));
    fireEvent.change(await slot.findByLabelText("Repository to add"), { target: { value: "proj_gateway" } });
    const addButton = slot.getByRole("button", { name: "Add selected repository" });
    fireEvent.click(addButton);
    expect(addButton.hasAttribute("disabled")).toBe(true);
    fireEvent.click(addButton);

    await expect.poll(() => additions).toHaveLength(1);
    expect((await slot.findByRole("alert")).textContent).toContain("Temporary host error");
    fireEvent.click(slot.getByRole("button", { name: "Add selected repository" }));
    await expect.poll(() => additions).toHaveLength(2);
    expect(additions[1]!.requestKey).toBe(additions[0]!.requestKey);
    slot.lifecycle.unmount();
  });

  it("reloads eligible repositories after workspace changes and explains exhausted options", async () => {
    const app = await loadPluginApp(() => import("../app"));
    let optionCalls = 0;
    const slot = renderSlot(app.threadPanelActions[0]!, { threadId: "thr_auth", params: null }, {
      rpc: {
        dashboard: () => ({ workspaces: [workspace], sessions: [activeSession], projects: [project, gatewayProject] }),
        session_expansion_options: () => ({ session: activeSession, repositories: optionCalls++ === 0 ? [expansionOption] : [] }),
      },
    });

    expect(await slot.findByRole("button", { name: "Add repository" })).toBeTruthy();
    await slot.behavior.emitRealtime("workspaces-changed", { at: 2 });
    expect(await slot.findByText("Every project on this session’s host is already checked out here.")).toBeTruthy();
    expect(slot.getByText("Workspace repositories are checked out directly. Any other project joins the workspace first, then this session.")).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it.each(["resolve", "reject"])("ignores a stale mount options %s after a newer realtime refresh", async (outcome) => {
    const app = await loadPluginApp(() => import("../app"));
    const mount = deferred<{ session: typeof activeSession; repositories: typeof expansionOption[] }>();
    const realtime = deferred<{ session: typeof activeSession; repositories: typeof expansionOption[] }>();
    let calls = 0;
    const slot = renderSlot(app.threadPanelActions[0]!, { threadId: "thr_auth", params: null }, {
      rpc: {
        dashboard: () => ({ workspaces: [workspace], sessions: [activeSession], projects: [project, gatewayProject] }),
        session_expansion_options: () => calls++ === 0 ? mount.promise : realtime.promise,
      },
    });

    await expect.poll(() => calls).toBe(1);
    await slot.behavior.emitRealtime("workspaces-changed", { at: 3 });
    await expect.poll(() => calls).toBe(2);
    await act(async () => { realtime.resolve({ session: activeSession, repositories: [] }); await realtime.promise; });
    expect(await slot.findByText("Every project on this session’s host is already checked out here.")).toBeTruthy();

    if (outcome === "resolve") await act(async () => { mount.resolve({ session: activeSession, repositories: [expansionOption] }); await mount.promise; });
    else await act(async () => { mount.reject(new Error("stale mount failure")); await mount.promise.catch(() => {}); });

    expect(slot.queryByRole("button", { name: "Add repository" })).toBeNull();
    expect(slot.queryByRole("alert")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("keeps only the latest thread's overlapping option response", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const panel = app.threadPanelActions[0]!;
    const first = deferred<{ session: typeof activeSession; repositories: typeof expansionOption[] }>();
    const secondSession = { ...activeSession, id: "session_billing", threadId: "thr_billing" };
    const second = deferred<{ session: typeof secondSession; repositories: typeof billingOption[] }>();
    const calls: string[] = [];
    const slot = renderSlot(panel, { threadId: "thr_auth", params: null }, {
      rpc: {
        dashboard: () => ({ workspaces: [workspace], sessions: [activeSession, secondSession], projects: [project, gatewayProject] }),
        session_expansion_options: (input: unknown) => {
          const threadId = (input as { threadId: string }).threadId;
          calls.push(threadId);
          return threadId === "thr_auth" ? first.promise : second.promise;
        },
      },
    });

    await expect.poll(() => calls).toEqual(["thr_auth"]);
    const Panel = panel.component;
    slot.lifecycle.rerender(<Panel threadId="thr_billing" params={null} />);
    await expect.poll(() => calls).toEqual(["thr_auth", "thr_billing"]);
    await act(async () => { second.resolve({ session: secondSession, repositories: [billingOption] }); await second.promise; });
    fireEvent.click(await slot.findByRole("button", { name: "Add repository" }));
    expect((await slot.findByLabelText("Repository to add") as HTMLSelectElement).value).toBe("proj_billing");
    await act(async () => { first.resolve({ session: activeSession, repositories: [expansionOption] }); await first.promise; });
    expect((slot.getByLabelText("Repository to add") as HTMLSelectElement).value).toBe("proj_billing");
    slot.lifecycle.unmount();
  });

  it("closes an open form when realtime removes its selected option", async () => {
    const app = await loadPluginApp(() => import("../app"));
    let repositories = [expansionOption, billingOption];
    const slot = renderSlot(app.threadPanelActions[0]!, { threadId: "thr_auth", params: null }, {
      rpc: {
        dashboard: () => ({ workspaces: [workspace], sessions: [activeSession], projects: [project, gatewayProject] }),
        session_expansion_options: () => ({ session: activeSession, repositories }),
      },
    });

    fireEvent.click(await slot.findByRole("button", { name: "Add repository" }));
    fireEvent.change(await slot.findByLabelText("Repository to add"), { target: { value: "proj_billing" } });
    repositories = [expansionOption];
    await slot.behavior.emitRealtime("workspaces-changed", { at: 3 });
    await expect.poll(() => slot.queryByLabelText("Repository to add")).toBeNull();
    expect(slot.getByRole("button", { name: "Add repository" })).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("closes and disables manual addition when latest options report an inactive session", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const inactiveSession = { ...activeSession, state: "archived" as const };
    let latestSession: typeof activeSession | typeof inactiveSession = activeSession;
    const slot = renderSlot(app.threadPanelActions[0]!, { threadId: "thr_auth", params: null }, {
      rpc: {
        dashboard: () => ({ workspaces: [workspace], sessions: [activeSession], projects: [project, gatewayProject] }),
        session_expansion_options: () => ({ session: latestSession, repositories: [expansionOption] }),
      },
    });

    fireEvent.click(await slot.findByRole("button", { name: "Add repository" }));
    expect(await slot.findByLabelText("Repository to add")).toBeTruthy();
    latestSession = inactiveSession;
    await slot.behavior.emitRealtime("workspaces-changed", { at: 4 });
    await expect.poll(() => slot.queryByLabelText("Repository to add")).toBeNull();
    expect(slot.queryByRole("button", { name: "Add repository" })).toBeNull();
    latestSession = activeSession;
    await slot.behavior.emitRealtime("workspaces-changed", { at: 5 });
    expect(await slot.findByRole("button", { name: "Add repository" })).toBeTruthy();
    slot.lifecycle.unmount();
  });
});
