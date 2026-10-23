# Fork tools for agents

This guide maps owner tasks to the fork tools. It is for agents that operate the T3 machines of the owner, the machine map, and the fork deploys and updates. [fork/features.md](fork/features.md) explains each feature, and [fork/operations.md](fork/operations.md) holds the maintainer procedures. [apps/machine-map/SPEC.md](../apps/machine-map/SPEC.md) holds the machine map requirements (MM-xxx).

## Rules

- Before a plan or status report, list recent merged fork PRs for that area. See [Change the fork](fork/operations.md#change-the-fork).
- Before you delegate with `isolation: worktree`, run `git fetch origin && git merge --ff-only origin/main` in your checkout. The child worktree starts from your local commit, not from `origin/main`.
- Prefer upstream code and generic solutions. Isolate fork code with one-line upstream hooks; see [Change the fork](fork/operations.md#change-the-fork).
- Never open or suggest PRs or issues on `pingdotgg/t3code`. Fork fixes stay in `Yarden-zamir/t3code`.
- Never kill a process that you found by a name, a path or a pattern. Kill only a PID that you started.
- Never write to `~/.t3/userdata` on a machine. It is the live install. Read it or copy from it only.
- Stage files by path only. Never use `git add -A` or `git add .`. Worktrees hold links to private files from `_shared/`.
- Before you open a pull request, review the change with the `review-loop` skill (`.agents/skills/review-loop`). Fill the "Review" section of the pull request template.
- Before every push, run `vp run fork:check` and fix each failed step. On a branch with an upstream merge not yet in `origin/main`, it exits without checks; run typecheck and the fork tests instead, then wait for Fork CI. See [Check a change before you push](fork/operations.md#check-a-change-before-you-push).
- Put every fork behaviour behind a setting. A setting that only adds something without noticeable cost starts on. A setting that changes existing behavior or layout, installs or restarts anything, changes access or needs setup starts off.
- Set the values of the owner's machines through the machine map, not through the code default.
- Enable requested features for the owner unless told otherwise. Report this; keep code defaults separate.
- Change shared server `threadCardLayouts` with `machines_set_setting`; backup: `_shared/thread-card-layouts.json`. Never use dotfiles settings pull scripts.
- Harmless screenshots, T3 browser previews, read-only checks and dev servers on copied data need no permission. See [Harmless verification](fork/operations.md#harmless-verification).
- Ask before live-state changes outside the request, publishing outside the fork, or deleting work. Never write live userdata directly.
- A broken Device panel, browser preview or MCP tool blocks work. Tell the owner first; see [Tool blockers](fork/operations.md#tool-blockers).
- Start no session-import threads, PRs or research until the owner raises session import again.
- Never deploy the portal or the VPS by hand. Merge to main. The automation deploys main.
- Never put secrets in the repository, a commit, a pull request or a comment. Secrets stay in `~/Github/t3code/_shared/`.
- Never add a model, harness or AI credit line to a commit, a pull request or a comment. This rule replaces the line in `AGENTS.md` that asks for one.

Mobile testers: read [Android emulator on the Mac](fork/operations.md#android-emulator-on-the-mac) before testing on the owner's Mac.

## Find the tools

- An agent in a T3 thread gets the fork MCP tools with the other T3 tools. Their descriptions hold the permissions, the side effects and the result shapes.
- In a terminal, run `t3 tool list` for all tools and `t3 tool describe <name>` before its first call. Run `t3 tool call <name> --input '<json>'` to call one. In a checkout, `node apps/server/src/bin.ts` replaces `t3`, but does not select the worktree dev server.
- Tool CLI commands, including `tool call` and `machine-map join`, target the live `~/.t3` server even from a worktree. Check `T3_ACP_*` and the CLI's "Pairing with ..." line before changes. Drive dev servers through their own UI or authenticated HTTP/WebSocket API; `pair` uses separate target discovery.
- The fork MCP tools are `machines_read`, `machines_resources`, `machines_set_access`, `machines_set_setting`, `machines_command`, `machines_queue_cancel`, `machines_undo`, `machines_preset`, `machines_join` and `machine_exec`. For other T3 tools on another machine, pass its `environmentId`; `t3_environment_links` lists them.

## Machine map

The portal is `https://t3.yarden-zamir.com`. Each machine is one T3 server, for example Mac, VPS and Windows. Call `machines_read` first: it gives the machine ids, the map roles, the arrows and the supported commands of each machine.

- Take machine ids, revision numbers and command ids from that result. Never guess them.
- The map role limits what the machine can do: `read` reads, `propose` sends changes to the owner Inbox, `edit` applies changes. Only the owner raises access: a change that raises a level, turns on agent tools or exec, or raises a map role always waits in the Inbox, also with `edit` (MM-803). Lower or remove access at once with `edit`. It never raises the calling thread's limits. Map writes need a live full-access/default caller. `machines_command` and `machines_queue_cancel` also need `edit`.
- Cross-machine work uses the arrow and the target's own T3 server, not SSH or a shared database. An arrow with agent tools makes the target a linked environment: pass its `environmentId` to the T3 tools (MM-1921). `read` gives read-only access, `standard` gives `auto` limited to the threads that this machine started there, and `admin` gives full access (MM-302). Each call carries the calling thread's limits, so restricted threads work there within their own modes (MM-1902). A target never lends its map role or onward arrows (MM-1904).
- Links come only from arrows. `t3 environment link` refuses, and Settings > Connections shows the arrow links read-only. Ask the owner to set the arrow in the portal.
- `machines_read` lists `capabilities`, what agents on each machine can do on another (MM-1915), and `calls`, the newest tool calls forwarded over arrow links (MM-1922). The portal History records each forwarded call without its arguments or output.
- `machine_exec` runs a shell command on another machine, through its T3 server and as its T3 user. It needs a live full-access/default caller with orchestration, worktree and pull-requests tool capabilities, and an arrow with exec, agent tools and the level `standard` or `admin` (MM-1908). The target checks the arrow again. A pause, a removed arrow or exec turned off stops a running command at once (MM-1916). Only the arrow and the caller limits control it: there is no command blocklist or allowlist (MM-1909). The portal History lists each run without its output.
- To read a thread on another machine, call `t3_thread_read` with `threadId` and the `environmentId` of the thread, as a thread attachment gives it. It works in every mode (MM-1902, MM-1905).
- While the owner's emergency pause is on, the portal refuses every agent call. Each machine also locks T3 Code for every client except its own desktop app (MM-718). Only the owner can resume, in the portal.
- The owner HTTP API (`apps/machine-map/src/worker.ts`, `/api/*`) needs the owner's Cloudflare Access login. Agents do not use it. Use the MCP tools.
- Clients (browsers and phones of the owner, MM-904) are owner-only. Agents never approve, invite, rename, remove or change the arrows of a client, not even as a proposal (MM-807). `machines_read` shows them. To give a phone access, ask the owner to use "Invite an app" in the portal.
- The server settings `clientAccess` and `machineMap` are owner-only (MM-919). `machines_set_setting` refuses `clientAccess`, the settings RPC refuses both for every client except the local desktop app, and `machines_join` refuses agents. Do not edit it in `settings.json` either: the portal reports each such change to the owner.

| Task                                    | Do this                                                                                                                                                                                                  |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| See the machines and their state        | `machines_read`.                                                                                                                                                                                         |
| See the load and alerts of machines     | `machines_read`. `resources` holds the newest sample, the thresholds and the active alerts.                                                                                                              |
| See the resource history of a machine   | `machines_resources` with `machineId` and `range` (`hour`, `day` or `month`).                                                                                                                            |
| Give machine X access to machine Y      | Ask the owner, or propose it: `machines_set_access` with `from` X, `to` Y, a `level`, `agentTools: true` and `exec: true` as needed, and `expiresInMinutes` for temporary access. It waits in the Inbox. |
| Remove access                           | `machines_set_access` with `level: "none"`. The sessions of X on Y end at once.                                                                                                                          |
| Read a thread on another machine        | `t3_thread_read` with `threadId` and `environmentId`. It needs an arrow with agent tools from this machine to that machine.                                                                              |
| Run a tool on another machine           | The tool itself with `environmentId` from `t3_environment_links`. It needs an arrow with agent tools from this machine to that machine.                                                                  |
| Run a command on another machine        | `machine_exec` with `machine`, `command`, and optionally `cwd` and `timeoutSeconds` (default 30, at most 90). It needs an arrow with exec from this machine to that machine.                             |
| Start work on another machine           | `delegate_task` with `target.environmentId` to wake this thread when it ends, `t3_thread_launch` with `environmentId`, or `machines_command` with `{"_tag":"startThread",...}`.                          |
| Change a setting on every machine       | `machines_set_setting` without `machineId`. Any key works except the machine-local ones (MM-406).                                                                                                        |
| Change a setting on one machine         | `machines_set_setting` with `machineId`. Pass `clear: true` to follow the shared value again.                                                                                                            |
| Sync keybindings                        | `machines_set_setting` for `keybindingSync: true`, then for `keybindings` (the rule list of `keybindings.json`).                                                                                         |
| Share custom themes or the theme        | `machines_set_setting` for the server settings `sharedThemes` (theme id to `{ json, css }`) and `defaultTheme` (MM-408 to MM-410).                                                                       |
| Restart a server, collect diagnostics   | `machines_command` with `restartServer` or `collectDiagnostics`. Read the result later in `commands` of `machines_read`.                                                                                 |
| Stop the agents on one machine          | `machines_command` with `stopAllAgents`.                                                                                                                                                                 |
| See the scheduled tasks of a machine    | `machines_read`. `presence.<machineId>.status.tasks` lists them. A machine without `tasks` runs an older T3.                                                                                             |
| Pause, resume or run one scheduled task | `machines_command` with `{"_tag":"setScheduledTaskEnabled","taskId":...,"enabled":false}` (`true` resumes), or `{"_tag":"runScheduledTask","taskId":...}`. An offline machine gets it from its queue.    |
| Stop everything                         | Ask the owner to press the emergency pause in the portal. It stops all agents and sets all access to none. Agents cannot press it.                                                                       |
| Revert a map change                     | `machines_undo` with the revision number from `history`. Commands cannot be undone.                                                                                                                      |
| Cancel a queued command                 | `machines_queue_cancel` with the command id.                                                                                                                                                             |
| Join a new machine                      | The owner uses a code from Add machine in Settings > Machines on desktop, or runs `t3 machine-map join <code>` on the headless machine. Agents cannot call `machines_join` (MM-919).                     |
| Install the fork on a new machine       | Run the step 0 command of the join dialog there: `install.sh --join <code>` or `install.ps1 -Join <code>` from `scripts/fork-install`. See [Install the fork](fork/operations.md#install-the-fork).      |

## Updates and deploys

| Task                         | Do this                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ship a fork change           | Open a pull request on `Yarden-zamir/t3code` and merge it to main after the checks pass. Main deploys itself.                                                                                                                                                                                                                                            |
| Update the Mac               | Merge to main. Each code push publishes a desktop release; the app updates itself. Then `machines_command` with `{"_tag":"installUpdate","whenIdle":true}` for the Mac or ask the owner to press the update button. The app must run.                                                                                                                    |
| Deploy a local build         | Run `scripts/fork-deploy-local.sh <ssh-host>` from the checkout. Use it only when the owner asks, because it restarts the server at once. See [Deploy a local build](fork/operations.md#deploy-a-local-build).                                                                                                                                           |
| Update a headless server     | A server that runs as the background service updates itself when `forkAutoUpdate` is on. To update it now, `machines_command` with `{"_tag":"installUpdate","whenIdle":true}` for that machine.                                                                                                                                                          |
| Deploy the portal            | Merge a change in `apps/machine-map` or `packages/contracts/src/machineMap*.ts` to main. The workflow "Machine map deploy" tests and deploys it. A deploy from a branch rolls back main.                                                                                                                                                                 |
| Release a desktop app        | Merge to main. Each code push runs the workflow "Fork Release". It builds the Mac, Windows and Linux apps, the Linux server archives and `SHA256SUMS`. Then "Fork Android" adds the Android APK when the app changed.                                                                                                                                    |
| Take upstream changes        | Run the workflow "Fork Sync", or wait for the VPS task "Fork Sync trigger", which starts it every 2 hours. A conflict comments on the issue "Fork sync: upstream merge failed". After a sync that adds a `mobile-*` workflow, disable it with `gh workflow disable "<name>" -R Yarden-zamir/t3code`. Those need Expo, Google Play or Blacksmith runners. |
| Build and install on the Mac | Run `PATH="$PWD/node_modules/.bin:$PATH" ./scripts/fork-desktop-mac.sh --install` from `~/Github/t3code/main`. Use it only when the owner asks, because it replaces the running app.                                                                                                                                                                     |

## Portal data recovery

The portal keeps all its state in one SQLite Durable Object. A change that rewrites stored data cannot be undone by a revert alone. The absolute map places (MM-1114) are such a change: on its first start, the portal moves every place from fractions to map pixels once, and it writes the time in the meta key `absolute_places`.

- Fix forward first. Merge a fix to main; the workflow "Machine map deploy" deploys it.
- Do not revert past the change "accept any finite map place" (#144). Older code decodes places with a 0..1 bound in the Durable Object constructor, so the portal does not start. A revert to a build with #144 and without the migration keeps the portal up, but it shows pixel places as fractions.
- Point-in-time recovery restores the Durable Object to a time in the last 30 days. It does not work in local development. Data written after that time is lost: revisions, commands, alerts and resource points.

To restore, ask the owner first. Then:

1. Find the time. Use the start time of the "Machine map deploy" run that deployed the change, or the `absolute_places` value. Take one minute before it.
2. Merge one change to main that reverts the migration and adds a temporary owner-only route, for example `POST /api/admin/restore` with `{ "at": <milliseconds> }`, that calls this Durable Object method:

   ```ts
   /** Temporary: restores the whole storage to `atMs`. Returns the bookmark that undoes it. */
   async restoreTo(atMs: number): Promise<string> {
     const bookmark = await this.ctx.storage.getBookmarkForTime(atMs);
     const undo = await this.ctx.storage.onNextSessionRestoreBookmark(bookmark);
     this.ctx.abort();
     return undo;
   }
   ```

   Revert the migration in the same change. Otherwise the next start migrates the restored data again.

3. After the deploy, call the route once as the owner. Keep the returned bookmark: a second restore to it undoes the first.
4. Check the map in the portal. Then remove the route in a follow-up change.

## Repair agent

When Fork CI, Fork Sync or Fork Release fails, `scripts/fork-notify-agent.sh` posts the run to the webhook in the GitHub secret `T3_AGENT_WEBHOOK_URL`. The webhook is the scheduled task "Fork repair" on the VPS, in the project "t3code fork". It posts each run into one long-lived thread, "Fork repair", and the repair agent works there. As its last action, each run queues `/compact` into its own thread with `t3_thread_send` (mode `queue`). The compaction runs as its own turn after the run, so the next repair starts with compacted context. A turn cannot compact itself: the orchestrator rejects `/compact` as a steer.

- The repair agent watches the next run of the same workflow.
- The VPS task "Fork Sync trigger" starts Fork Sync every 2 hours. Before you merge upstream by hand, check `gh run list --workflow fork-sync.yml` and the VPS for a running "Fork repair" thread. Run the workflow instead of a manual merge. If a repair agent already merges upstream, send it your notes instead of a second merge.
- On a retry, run the workflow with `notify_agent=false`, so that a second failure does not start another agent.
- A failure right after a failure of the same workflow does not post, when the notify job of the first failure succeeded and the first failure started less than 2 hours before.
- To stop the repair agent, disable the "Fork repair" task on the VPS (`machines_command` with `{"_tag":"setScheduledTaskEnabled","taskId":...,"enabled":false}`). To stop all calls, delete the GitHub secret `T3_AGENT_WEBHOOK_URL`.
