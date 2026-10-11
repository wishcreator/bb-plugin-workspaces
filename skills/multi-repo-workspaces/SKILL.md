---
name: multi-repo-workspaces
description: Work safely inside a BB Workspaces multi-repository session. Use when the current working directory contains a Workspaces session.json or the user asks about the repositories available in a multi-repo workspace thread.
---

# Multi-repository workspace sessions

A Workspaces session has one common root and an isolated Git worktree for each selected repository.

## Discover the session

1. Find the shared session root in the launch prompt; a writer starts inside its repository worktree. Read `session.json` at that shared root. Treat its repository list as the authoritative scope for this task.
2. Read the root `AGENTS.md` for the repository map and shared workspace guidance.
3. Before modifying a repository, enter its `repos/<alias>` directory and read every applicable `AGENTS.md` in that repository.

Do not search for or modify sibling repositories that are absent from `session.json`.

## Work across repositories

- Your writable working directory is the repository in which this thread started. For a sibling repository, use the Repositories panel to start its writer as a child of the primary session thread; coordinate edits with the parent. Do not change sandbox policy to gain sibling write access.
- Run Git commands from the specific `repos/<alias>` checkout they apply to. The session root is not itself a Git repository.
- Keep changes separated by repository and report validation results for each repository.
- When an interface change spans repositories, update the producer and consumers coherently, then run the narrow tests in every affected checkout.
- Do not move files between repositories as a substitute for making the corresponding repository changes.
- Do not edit `session.json` manually, or remove session worktrees yourself.
- If a repository already belongs to this saved workspace but is absent from `session.json`, you may call `workspace_add_repository` for a concrete missing dependency. Include the reason it is required and proceed only after the tool reports that its worktree is ready; then re-read `session.json`.
