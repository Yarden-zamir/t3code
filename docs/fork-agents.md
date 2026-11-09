# Fork tools for agents

This guide maps owner tasks to the fork tools. It is for agents that operate the T3 machines of the owner through kitshn, and the fork deploys and updates. [fork/features.md](fork/features.md) explains each feature, and [fork/operations.md](fork/operations.md) holds the maintainer procedures. kitshn's SPEC.md holds the K-xxx requirements; MM-xxx numbers name older machine map rules that still hold.

## Rules

- Before a plan or status report, list recent merged fork PRs for that area. See [Change the fork](fork/operations.md#change-the-fork).
- Before you delegate with `isolation: worktree`, run `git fetch origin && git merge --ff-only origin/main` in your checkout. The child worktree starts from your local commit, not from `origin/main`.
- Prefer upstream code and generic solutions. Isolate fork code with one-line upstream hooks; see [Change the fork](fork/operations.md#change-the-fork).
- Never open or suggest PRs or issues on `pingdotgg/t3code`. Fork fixes stay in `Yarden-zamir/t3code`.
- Never kill a process that you found by a name, a path or a pattern. Kill only a PID that you started.
- Start and stop a worktree dev server with `node scripts/fork-dev-server.ts start` and `stop`, not with a bare `vp run dev`. A stop of the dev-runner PID alone leaves `node --watch` alive. See [Harmless verification](fork/operations.md#harmless-verification).
- Never write to `~/.t3/userdata` on a machine. It is the live install. Read it or copy from it only.
- Stage files by path only. Never use `git add -A` or `git add .`. Worktrees hold links to private files from `_shared/`.
- Before you open a pull request, review the change with the `review-loop` skill (`.agents/skills/review-loop`). Fill the "Review" section of the pull request template.
- If a change breaks an existing setup, mark it: put `!` after the type in the pull request title, for example `feat(machine-map)!: …`. Add a "## Breaking changes" section to the body, with one line per break: what changed, who is affected and what to do. The daily release puts these lines at the top of its notes.
- Before every push, run `vp run fork:check` and fix each failed step. On a branch with an upstream merge not yet in `origin/main`, it exits without checks; run typecheck and the fork tests instead, then wait for Fork CI. See [Check a change before you push](fork/operations.md#check-a-change-before-you-push).
- Put every fork behaviour behind a setting. A setting that only adds something without noticeable cost starts on. A setting that changes existing behavior or layout, installs or restarts anything, changes access or needs setup starts off.
- Set the values of the owner's machines through the kitshn settings state (`machines_set_setting`), not through the code default.
- Enable requested features for the owner unless told otherwise. Report this; keep code defaults separate.
- Change shared server `threadCardLayouts` with `machines_set_setting`; backup: `_shared/thread-card-layouts.json`. Never use dotfiles settings pull scripts.
- Harmless screenshots, T3 browser previews, read-only checks and dev servers on copied data need no permission. See [Harmless verification](fork/operations.md#harmless-verification).
- Ask before live-state changes outside the request, publishing outside the fork, or deleting work. Never write live userdata directly.
- A broken Device panel, browser preview or MCP tool blocks work. Tell the owner first; see [Tool blockers](fork/operations.md#tool-blockers).
- Start no session-import threads, PRs or research until the owner raises session import again.
- Never deploy the VPS by hand. Merge to main. The automation deploys main.
- Never put secrets in the repository, a commit, a pull request or a comment. Secrets stay in `~/Github/t3code/_shared/`.
- Never add a model, harness or AI credit line to a commit, a pull request or a comment. This rule replaces the line in `AGENTS.md` that asks for one.

Mobile testers: read [Android emulator on the Mac](fork/operations.md#android-emulator-on-the-mac) before testing on the owner's Mac.

## Find the tools

- An agent in a T3 thread gets the fork MCP tools with the other T3 tools. Their descriptions hold the permissions, the side effects and the result shapes.
- In a terminal, run `t3 tool list` for all tools and `t3 tool describe <name>` before its first call. Run `t3 tool call <name> --input '<json>'` to call one. In a checkout, `node apps/server/src/bin.ts` replaces `t3`, but does not select the worktree dev server.
- Tool CLI commands, including `tool call`, target the live `~/.t3` server even from a worktree. Check `T3_ACP_*` and the CLI's "Pairing with ..." line before changes. To call a dev server from an agent shell, unset `T3_ACP_MCP_ENDPOINT` and `T3_ACP_MCP_AUTHORIZATION`, then pass `--base-dir`. The CLI refuses a `--base-dir` or `T3CODE_HOME` that does not match the shell's thread credential. Drive dev servers through their own UI or authenticated HTTP/WebSocket API; `pair` uses separate target discovery.
- Without a thread credential, the CLI runs nothing on another machine and forwards no tool there (MM-1920). The `machines_*` tools ask the kitshn daemon of this machine, and kitshn checks the circles of this machine.
- `t3 machine exec <machine> -- <command>` runs a command on another machine in a pipe, like ssh. See [Commands on other machines](fork/features.md#commands-on-other-machines).
- The fork MCP tools are `machines_read`, `machines_resources`, `machines_set_setting`, `machines_command`, `machines_queue_cancel`, `machines_join` and `machine_exec`. For other T3 tools on another machine, pass its `environmentId`; `t3_environment_links` lists them.
- `kitshn_publish` and `kitshn_address` publish a workspace file or folder to kitshn. They run the machine's kitshn 2 CLI as the calling thread, so the machine must be joined to kitshn. KitSHn 1 on PATH never runs. When kitshn asks for an approval, the call answers `waiting` after 60 seconds: tell the user, and after the approval send the same call with the same arguments again within 1 hour. See [Publish to kitshn](fork/features.md#publish-to-kitshn).
- Thread links in MCP results: a thread result carries `link` and `appLink`. For an MCP client outside T3 Code, `link` is the web address of the thread on the server that the client reached, `https://<server>/<environmentId>/<threadId>`. `appLink` is the `t3-thread://v2/<environmentId>/<threadId>` link that opens the desktop app and the fork Android app; a result that names a message, such as `t3_thread_send` or a message of `t3_thread_read`, adds `#<messageId>`. In T3 Code, `link` is a Markdown link to the same t3-thread address, labeled with the thread title when the server knows it. The fork never gives upstream's app.t3.codes link, because the fork Android app does not open it.
- Compatibility: `link` has the same address as on fork main before the upstream merge of 2026-11-04. `appLink` is new. No fork client ever received app.t3.codes links.
- A web page shows `appLink` to Android as an intent URL, `intent://v2/<environmentId>/<threadId>#Intent;scheme=t3-thread;package=com.yardenzamir.t3code;S.browser_fallback_url=<link>;end`, and the raw `appLink` elsewhere. The grocries site (`src/grocries/web/app.js` in Yarden-zamir/grocries) does this.

## Machines through kitshn

Each machine is one T3 server, for example Mac, VPS and Windows, and a provider on the kitshn map. kitshn is the only path between machines. The owner shares access on the kitshn map; agents do not change access.

- Call `machines_read` first: it gives this machine's id and name, and what kitshn shows this machine: its rights, circles and cards. It does not list other machines.
- Cross-machine work uses kitshn links and the target's own T3 server, not SSH or a shared database. A machine whose T3 app card is shared with this machine is a linked environment: pass its `environmentId` to the T3 tools (K-1609). The T3 app level gives read-only, `auto` limited to the threads that this machine started there, or full access (MM-302). Each call carries the calling thread's limits (MM-1902). A target never lends its links onward (MM-1904).
- Links come only from kitshn. `t3 environment link` refuses, and Settings > Connections shows the links read-only. Ask the owner to share the cards on the kitshn map.
- `machine_exec` runs a shell command on another machine through kitshn, as the user of that machine's T3 provider; T3 there is not needed, so it also repairs a broken T3 (K-722). It needs a live full-access/default caller with orchestration, worktree and pull-requests tool capabilities, and the kitshn effect "runs" of this machine on the target. With "ask", the call answers `waiting` after 60 seconds: tell the user that the run waits for the owner's approval, do not send it again, and read the result later in `execResults` of `machines_read`. There is no command blocklist or allowlist (MM-1909). kitshn records each run and each forwarded call, without arguments or output (K-1610). In a shell, `t3 machine exec` runs the same command with stdin, streamed output and the exit code (MM-1919).
- To read a thread on another machine, call `t3_thread_read` with `threadId` and the `environmentId` of the thread (MM-1902, MM-1905).
- A kitshn pause empties the links and closes every grant. Only the owner resumes, on the kitshn map.
- Agents never join a machine (`machines_join` refuses them) and never change who may reach a machine.

| Task                                  | Do this                                                                                                                                                                                |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| See this machine on kitshn            | `machines_read`.                                                                                                                                                                       |
| See the load of this machine          | `machines_resources`: CPU, memory and disk for the last hour.                                                                                                                          |
| Give machine X access to machine Y    | Ask the owner to share Y's T3 app card with X on the kitshn map, and to set X's effect "runs" on Y for commands.                                                                       |
| Read a thread on another machine      | `t3_thread_read` with `threadId` and `environmentId`. It needs a link from this machine to that machine.                                                                               |
| Run a tool on another machine         | The tool itself with `environmentId` from `t3_environment_links`.                                                                                                                      |
| Run a command on another machine      | `machine_exec` with `machine`, `command`, and optionally `cwd` and `timeoutSeconds` (default 30, at most 90). In a shell or for longer work: `t3 machine exec <machine> -- <command>`. |
| Start work on another machine         | `delegate_task` with `target.environmentId`, or `t3_thread_launch` with `environmentId`.                                                                                               |
| Change a setting on every machine     | `machines_set_setting` with `part: "shared"`. It needs a full-access/default caller. Machine-local keys are refused.                                                                   |
| Change a setting on this machine      | `machines_set_setting` with `part: "machine"`. It cannot change another machine's part.                                                                                                |
| Change a setting for a circle         | Ask the owner. Agents never set a circle part: `machines_set_setting` with `part: "circle"` refuses an agent thread (K-726). `machines_read` shows the parts in `circleSettings`.      |
| Restart a server, collect diagnostics | `machines_command` with `machineId` and `command` `restart-server` or `collect-diagnostics`. kitshn may hold the job for the owner.                                                    |
| Stop the agents on one machine        | `machines_command` with `stop-all-agents`.                                                                                                                                             |
| Cancel a queued job                   | `machines_queue_cancel` with the job id. Only jobs that this machine queued.                                                                                                           |
| Stop everything                       | Ask the owner to pause on the kitshn map. Agents cannot pause.                                                                                                                         |
| Join a new machine                    | The owner runs `kitshn join <code> --server <address>` on the machine.                                                                                                                 |

## Terminal threads

A terminal thread is a thread whose view is a live shell. See [Terminal threads](fork/features.md#terminal-threads). The server setting `terminalThreads` must be on. Change it with `machines_set_setting`. While it is on, the `terminal` entry of `orchestrator_capabilities` lists the shells as models and explains the use in `usage`.

| Task                               | Do this                                                                                                                                                                                                                                                  |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Start a terminal thread            | `t3_thread_launch` with `modelSelection` `{"instanceId":"terminal","model":"terminal"}`. `message` is typed into the terminal. On another machine, pass its `environmentId`; the kitshn effect "runs" of this machine there must be automatic (MM-1923). |
| Run a command in one and read it   | `t3_thread_send` to the thread, then `t3_thread_wait` and `t3_thread_read`. At a prompt of bash or zsh the answer holds the exit code and the output.                                                                                                    |
| Run one on a schedule or a webhook | `schedule_task` with the same `modelSelection`. Pass `bindToCurrentThread:false`. A webhook cannot use it: its values are typed into a shell, so the server refuses it.                                                                                  |

## Updates and deploys

| Task                         | Do this                                                                                                                                                                                                                                                                            |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ship a fork change           | Open a pull request on `Yarden-zamir/t3code` and merge it to main after the checks pass. Main deploys itself.                                                                                                                                                                      |
| Update the Mac               | Merge to main. Each code push publishes a desktop release, and the app downloads it. To install it, `machines_command` with `command` `install-update` for the Mac: it takes the newest release and waits for idle. Or ask the owner to press the update button. The app must run. |
| Deploy a local build         | Run `scripts/fork-deploy-local.sh <ssh-host>` from the checkout. Use it only when the owner asks, because it restarts the server at once. See [Deploy a local build](fork/operations.md#deploy-a-local-build).                                                                     |
| Update a headless server     | A server that runs as the background service installs updates itself when `forkUpdateMode` is `automatic`. To update it now, `machines_command` with `command` `install-update` for that machine. See [Updates](fork/features.md#updates).                                         |
| Release a desktop app        | Merge to main. Each code push runs the workflow "Fork Release". It builds the Mac, Windows and Linux apps, the Linux server archives and `SHA256SUMS`. Then "Fork Android" adds the Android APK when the app changed.                                                              |
| Take upstream changes        | Run the task "Fork merge" now with `run_scheduled_task_now` on the Mac, or wait for its run every 2 hours. See [Merge agent](#merge-agent). Never merge upstream by hand while a merge thread is active. Send your notes to that thread instead.                                   |
| Build and install on the Mac | Run `PATH="$PWD/node_modules/.bin:$PATH" ./scripts/fork-deploy-local.sh --mac --install` from `~/Github/t3code/main`. Use it only when the owner asks, because it replaces the running app.                                                                                        |

## Merge agent

The T3 task "Fork merge" on the Mac, project "t3code fork", starts a run every 2 hours. All runs use one long-lived thread, and each run starts a fresh session. The task prompt points here, so this section is the contract of the merge agent. The workflow side is in [Fork merge](fork/operations.md#fork-merge).

Start of a run:

0. Call `list_thread_pull_requests`. Every open pull request linked to the thread came from an earlier run of the same thread, also when the fresh session does not remember it. A `fork-sync/` branch is a sync in progress. A `fork-fix/` branch is a release or CI fix. Continue each one, keep it watched, and merge it under the rules below. Never unwatch or drop a linked open pull request. Escalate when you cannot finish it.
1. Fetch `origin main` and `upstream main`.
2. If fork main contains upstream main and `scripts/fork-adopted-upstream-prs.json` is empty, answer one line and stop. If the list has entries, `node scripts/fork-adopted-prs.ts sync` finds their new heads, so run steps 3 or 4. When the merge and the sync change nothing, remove the worktree, answer one line and stop. `node scripts/fork-adopted-prs.ts check` reads only local commits, so it does not find new heads.
3. If the pull request "chore(sync): merge pingdotgg/t3code main" is open, continue it. Do not open a second one. Merge `origin/main` into its branch, then `upstream/main`.
4. Otherwise, run `uv run .agents/skills/fork-repair/scripts/worktree.py create sync`. In that worktree, merge `upstream/main` with the commit subject `chore(sync): merge pingdotgg/t3code main`. `scripts/fork-release-notes.ts` reads this subject.

The merge:

- Resolve every conflict yourself. Keep the fork features and the upstream changes both working.
- Use the [fork-repair skill](../.agents/skills/fork-repair/SKILL.md) in this order: `shared_files.py`, `lockfile.py`, `route_tree.py`, then `node scripts/fork-adopted-prs.ts sync`, `checks.py` and `fork_tests.py`.
- Run `fork_tests.py` in chunks that each take less than 10 minutes.
- Fix the fork tests that upstream API changes broke.
- Update `apps/server/src/provider/agentContextBudget.json` as the skill says.

The pull request:

- Push the branch and open a draft pull request. Write a plain body: what upstream brought, each conflict and its resolution, and the fork fixes. Link the pull request to the thread, and watch it.
- Fix each check failure. Answer each bot thread. A test that fails in a CI shard is a code failure, also when it passes alone on the Mac. Reproduce it with the shard command that CI runs, then fix the cause at the lowest layer. No quarantine skip, no retry, no timeout change.
- Infrastructure failures only (a GitHub 504 on a release download, curl exit 22 on that download): rerun the failed jobs, at most three times. When only those jobs still fail and every code job is green on the head, merge, and name the skipped jobs and the reason in one line of the pull request body.
- The label `agent-context-increase`: when only upstream text grew (the fork share over upstream at the merge base did not grow), add it yourself and write the three deltas and "upstream text only" in the pull request body. When the check already ran red, remove and add the label again for a fresh run. When fork text grew, escalate.
- Merge when Fork CI is green on the head and `origin/main` is an ancestor of the head. Run `gh pr ready`, then `gh pr merge --merge --admin --match-head-commit <head>`.
- After the merge, disable each active workflow that is not a `fork-*` workflow or `agent-context-budget.yml`. `checks.py` prints the commands. Remove the worktree with `worktree.py remove`, unwatch the pull request, and send one line to the orchestrator thread that the task prompt names.
- After the merge, watch the Fork Release run on main once. On a download 504, rerun its failed jobs. On a code failure, run `worktree.py create fix <topic>`, fix it, open a draft pull request, link it and watch it. It is yours until it merges. Its body says "Review: none, merge agent rule", because the merge agent starts no second agent; the orchestrator arranges the review.

Escalation:

- Escalate when you are stuck, when the worktree is in a messy state, or at an owner decision. Owner decisions include an adopted pull request that upstream closed, a fork feature that upstream replaced, a label, and a push that these rules forbid.
- To escalate, send one message to the orchestrator thread with `t3_thread_send`, mode `auto`. Start it with 🤖. Give the pull request link, the branch and the worktree, what you did, the exact error, and the question. Then end your turn. Leave the worktree as it is.
- A run ends in one of four states: nothing to do, merged, pull request open and watched, or escalated. A run never ends in silence.

Working rules:

- Start no subagents and no background runs.
- Never kill processes by a name or path pattern.
- Never write to `~/.t3/userdata`.
- Run tests with `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1`, and without `T3_ACP_MCP_AUTHORIZATION`, `T3_ACP_MCP_ENDPOINT`, `KITSHN_ATTEST` and `T3_SERVICE_LAUNCHER_CONTEXT`.
- Do not run `vp run check:changed`. It takes more than 10 minutes on a merge.
- Do not run evals with an API key.

To pause the merge agent, call `schedule_task` on the Mac with the `scheduledTaskId` of "Fork merge" and `enabled: false`.

## Repair agent

When Fork CI or Fork Release fails on main, `scripts/fork-notify-agent.sh` posts the run to the webhook in the GitHub secret `T3_AGENT_WEBHOOK_URL`. The webhook is the scheduled task "Fork repair" on the VPS, in the project "t3code fork". It posts each run into one long-lived thread, "Fork repair", and the repair agent works there. As its last action, each run queues `/compact` into its own thread with `t3_thread_send` (mode `queue`). The compaction runs as its own turn after the run, so the next repair starts with compacted context. A turn cannot compact itself: the orchestrator rejects `/compact` as a steer.

- The repair agent watches the next run of the same workflow.
- The repair steps use the scripts of the [fork-repair skill](../.agents/skills/fork-repair/SKILL.md). An agent that repeats a manual step adds a script there, in the pull request it works on.
- The repair agent does not merge upstream. If a failure comes from an upstream change, send your notes to the [merge agent](#merge-agent) thread.
- On a retry, run the workflow with `notify_agent=false`, so that a second failure does not start another agent.
- A failure right after a failure of the same workflow does not post, when the notify job of the first failure succeeded and the first failure started less than 90 minutes before.
- To stop the repair agent, disable the "Fork repair" task on the VPS (`machines_command` with `{"_tag":"setScheduledTaskEnabled","taskId":...,"enabled":false}`). To stop all calls, delete the GitHub secret `T3_AGENT_WEBHOOK_URL`.
