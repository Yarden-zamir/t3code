# Fork features

The user-facing features of the fork [Yarden-zamir/t3code](https://github.com/Yarden-zamir/t3code). The groups follow the README list and Settings > Fork. Settings > Fork shows every fork setting, with the same rows as their proper places, and links to each place. Maintainer procedures are in [operations.md](operations.md).

Each section names:

- **Setting:** the settings key, its default and its place in Settings. A server setting applies to every client of that environment. A client setting applies to one browser or device.
- **Works on:** web, desktop and mobile. "Server" means that the server does it for every client.
- **Limits:** known limits, each with the condition to revisit it.

## Local usage hubs

An agent with full access can add a local CLIProxyAPI hub to the server's usage sources. It can
request the management key privately, or read an existing owner-only key file on macOS or Linux.
The source belongs to that server; remove it in Settings > Providers > Usage providers.

- **Works on:** server, for web, desktop, mobile and agent tools.
- **Limits:** the hub URL must use a loopback IP address. Windows supports a private key request;
  importing a key from a file requires a server on macOS or Linux.

## Central build caches

Local builds can keep their disposable Vite caches and Android app outputs outside checkouts.

- **Setting:** `T3_FORK_CENTRAL_BUILD_CACHE=1` in the build environment (off by default). `XDG_CACHE_HOME` chooses the cache base; otherwise it is `~/.cache`. No installed-app setting is needed.
- **Works on:** local web, server, desktop and marketing Vite tools, shared-client tests, and Android prebuilds. Each canonical checkout path has its own SHA-256 key. APKs remain at `apps/mobile/android/app/build/outputs/apk` through a link.
- **Limits:** existing local outputs are not moved or deleted. Enable before a clean Android prebuild. Root Android outputs, dependency codegen and `.cxx` stay in place. Disabling the variable does not remove an existing link; the next clean prebuild restores the normal layout. `node scripts/fork-build-cache-prune.ts --dry-run` previews central-only cleanup, with 14 days as the default age. See [operations](operations.md#central-build-caches).

## Worktrees

### Restore worktrees on resume

Restore a missing worktree at its saved path before starting the next turn. An existing folder starts as it is, on any branch, as upstream does. After artifact eviction, setup runs in it when it is still a worktree of the project. If its branch still exists, recovery preserves it. If the branch was deleted, recovery fetches origin's default branch and creates the saved branch name from that revision. The thread warns that earlier uncommitted work is not in the recreated checkout. Project setup runs before the agent starts. Dependencies that artifact eviction removed also run normal setup. A missing `node_modules` that eviction did not remove does not run setup. The thread shows the restore as an activity. A stopped, failed or crashed setup closes that activity, and so does a server restart during setup. Missing build outputs do not add a setup or build step on resume; the next build recreates them.

- **Setting:** `restoreWorktreesOnResume` (server setting, off by default). Settings > Worktrees > Creation > "Restore worktrees on resume".
- **Works on:** server, for web, desktop, mobile, agent tools and scheduled turns.
- **Way out:** when the folder of a branch worktree is gone and cannot be restored, the failure row offers "Recreate on a new branch" on web, desktop and mobile. It creates a worktree on `<branch>-restored`, from the old branch when it still exists and from the default branch otherwise. It runs project setup and sends the message of the latest failed run again, as the user who clicked. That message runs before the messages that the failure held. If the message cannot be sent, the button shows the error. A lead agent moves such a thread with `t3_worktree_handoff` and its `threadId`. A `continuationPrompt` from the lead can run after the messages that the failure held, and the lead gets its result.
- **Limits:** a conflicting path stops recovery and setup after eviction. A failed recovery fails the turn with the reason ("Couldn't restore thread workspace"). Only this checkout's Git registration is repaired; no broad prune runs. When its branch exists, its saved index and refs, including staged changes, stay. Existing branches are never reset. Deleted-branch recovery requires a reachable origin with a discoverable default branch; its old index is not restored. Dependencies require a configured project setup script. When this setting is off, upstream's recovery runs unchanged: for a managed worktree path, it runs `git worktree prune` and adds the worktree again, without project setup. It creates a deleted branch from the current branch of the project, and a failed recovery fails the turn. Pending dependency restoration after artifact eviction still runs.

### Auto-settle waits for background commands

Auto-settle skips a thread while a background command of its agent runs, for example a typecheck that a Claude agent started with `run_in_background`. Settling stops the agent session, and that kills the command before it can wake the agent. Upstream auto-settle waits only for monitors, background agents and other background tasks.

- **Setting:** `autoSettleWaitsForBackgroundCommands` (server setting, off by default). Settings > Threads > Auto-settle > "Auto-settle waits for background commands".
- **Works on:** server, for every provider that reports background commands. Manual settle still stops the session.
- **Limits:** a command left running, such as a dev server, holds the thread until the session releases idle background work (`DEFAULT_MAX_IDLE_PIN_MS` in `apps/server/src/orchestration-v2/ProviderSessionManager.ts`). Revisit this if threads with dev servers stay unsettled too long.

### Artifact-only worktree cleanup

Remove regenerable build outputs before dependencies, without removing the worktree or its branch. The storage cleanup report splits logical file bytes and folder counts into Android builds, Gradle caches, other builds, other caches and `node_modules`. These are not recorded as physical space freed: pnpm files can share APFS blocks with its store. Evicted dependencies run normal project setup before the next turn, even if eviction has since been switched off. Build outputs do not trigger setup or an extra build step on resume; the agent's next build recreates them.

The measured Mac examples were 6.91 GiB logical `node_modules` removed for 0.13 GiB reclaimed, and 1.35 GiB `apps/mobile/android/app/build` removed for 1.18 GiB reclaimed. These are reference measurements, not a conversion rule or a prediction of the next cleanup's physical reclamation.

- **Setting:** `worktreeArtifactEviction` (server setting, off by default) and `worktreeArtifactEvictionDays` (14 days by default, 1–3650). Settings > Worktrees > Creation > "Evict worktree artifacts".
- **Works on:** server. All clients, scheduled turns and agent tools use the same recovery path.
- **Eligibility:** this protects process cwds and T3-known active work. A single idle thread must own the checkout and be settled or inactive for the configured days. Shared threads and subagents, running, queued or pending work, setup, builds, open terminals and uncertain process visibility keep artifacts. T3 metadata naming the worktree blocks cleanup even when its cwd is higher. Any process cwd in the checkout, a descendant or its container (the immediate parent holding sibling worktrees) also blocks cleanup. A deleted or unreadable cwd blocks cleanup only when its old path is in the checkout, a descendant or its container. The nearest readable folder above it gives that path. This rule also applies to T3 terminal and provider session cwds. A project setup script must be configured. These guards stay independent of the process scan and run again before deletion.
- **Files:** exact reviewed relative paths only, including `apps/mobile/android/app/build`; there is no arbitrary `build` or `dist` basename rule. Dependency paths are expanded from workspace declarations into exact `node_modules` paths. Git must ignore each folder and track no file within it. Extension and path rules classify conservatively; they do not prove where a file came from or distinguish every hand-written ignored `.js` or `.json` file from generated output. A `.env*` file, secret, original source or unknown content, `_shared` link, or link outside the checkout keeps the whole folder. For an unrecognized file type, the report says the folder was kept and gives its reason and an example path. Kotlin incremental table exceptions apply only under `kotlin/<task>/cacheable/caches-jvm/`. Shared pnpm storage is not managed by this feature.
- **Limits:** orphan Git worktrees without a stored T3 thread are excluded. A clean process list does not prove no external activity. A process above the container, such as one with cwd `$HOME` or `/`, can still act on the worktree through an absolute path; revisit if a real tool does that. T3-known active work remains protected independently of that cwd bound. Process checks support macOS and Linux. Other systems keep artifacts until inspection is available. This setting does not change or disable upstream whole-worktree cleanup rules; turn those off separately if you want every checkout kept. With [central build caches](#central-build-caches) on, `apps/mobile/android/app/build` is a link, so this feature keeps it. Use `node scripts/fork-build-cache-prune.ts` for the central caches.

## Remote access

### Request headers per environment

A saved environment sends its own request headers, for example a Cloudflare Access service token.

- **Setting:** per saved environment. On desktop, edit them in Settings > Environments. On mobile, enter the token under "Cloudflare Access service token" in Add environment, or in the settings of the environment.
- **Works on:** desktop, mobile. The mobile app sends the headers on API requests, the WebSocket, attachment uploads and downloads, the attachment text preview, and project, attachment and Markdown images (also SVG).
- **Limits:** the mobile app does not send them for provider icons, the media gallery, audio and video, thread link previews and web views. Web views cannot limit their sub-requests and redirects to one origin. Revisit when a missing request type blocks a real use.

### Tunnel pairing

A desktop server that listens on loopback makes pairing links with its tunnel URL.

- **Setting:** `tunnelPairingEnabled` (off by default) and `tunnelPairingUrl`. Settings > Sharing & access > "Allow pairing through a tunnel", in the desktop app of the local server. On a headless server, set `T3CODE_TUNNEL_PAIRING_URL`.
- **Works on:** desktop (the setting). Every client can open the pairing link.

### Guest links over the tunnel

Upstream guest links ([Guest links](../user/guest-links.md)) need T3 Connect, and fork builds have no T3 Connect. Without T3 Connect, a guest link uses the host of the server's Cloudflare tunnel.

- **Setting:** the upstream beta `guestSharingEnabled` (off by default), Settings > Labs > Guest links. The tunnel address is `T3CODE_TUNNEL_PAIRING_URL`.
- **Works on:** server. The guest uses any browser. The owner creates links from web, desktop and mobile, as upstream.
- **Limits:** the tunnel host must let guests reach the guest paths. See [Guest links through Cloudflare Access](operations.md#guest-links-through-cloudflare-access). When T3 Connect starts to serve the machine, links on the tunnel host stop working, because each guest request must match the current host. Revisit when upstream guest links accept a host other than T3 Connect.

### Trusted sibling environments

Trusted browser origins get credentialed CORS and session cookies. One browser page then pairs with and reaches the other hosts.

- **Setting:** `trustedBrowserOrigins` (empty by default). Settings > Sharing & access > "Allow pairing through a tunnel", in the desktop app. On a headless server, set `T3CODE_TRUSTED_BROWSER_ORIGINS`. A server with kitshn trusts the origins of the machines that it reaches without this setting.
- **Works on:** web, desktop. Mobile does not need it.

### Quiet reconnect after restart

After an update, the app and the remote servers restart at about the same time. A remote server can need about 40 seconds before it accepts the connection again. With this setting on, the composer does not show "<server> is reconnecting" in the first 45 seconds after the app starts.

- **Setting:** client setting `restartReconnectWarningGrace` (off by default). Settings > Environments > Connection warnings > "Quiet reconnect after restart".
- **Works on:** web, desktop. The sidebar, the environment chips and Settings > Environments still show the state at once. A send in that time still shows "Not connected: message not sent".
- **Limits:** a refused sign-in or an offline device shows at once. Later reconnects keep the upstream wait of 2 seconds. The mobile app shows only a small "Reconnecting" status, so it has no wait. Revisit the 45 seconds when a normal restart takes longer.

### Sync timings on mobile

Settings > About > Diagnostics > Sync timings, below the crash reports, shows how long the app needs to sync chats, so that a slow sync can be measured on the phone. Each run is one cold start or one return to the foreground. For each environment, a run shows the time of each sync step and the duration of the connection steps:

- the cached list shown, "synchronizing", the socket ready, the HTTP snapshot applied and "live";
- the open thread from "synchronizing" to "live";
- the foreground probe result: alive, silent, timed out or failed;
- the route checks, the bearer authorization, the connection, the HTTP snapshot, the cached shell load and the silent socket check.

"Copy sync timings" copies all runs as text. The text names environments by their label, never by address.

- **Setting:** none. The timings stay in memory and cost no network traffic.
- **Works on:** mobile. The recorder is in `packages/client-runtime`, so web can show it later.
- **Limits:** the app keeps the cold start and the last 10 returns to the foreground. A restart clears them. The cold start time counts from when the app code loaded, not from the start of the process.

## kitshn

kitshn connects the T3 machines of the owner. Each T3 server is the provider `t3` of the kitshn daemon on its machine. The owner shares access between machines on the kitshn map. T3 Code has no map of its own.

- **Setting:** none. The server uses kitshn when the machine has kitshn 2, is joined, and its daemon runs. Without kitshn, the server keeps the owner login only.
- **Join:** on the machine, run `kitshn join <code> --server <address>`. "Add machine" on the kitshn map gives the code. Agents cannot join.
- **Works on:** server, web, desktop and mobile.
- **Reference:** agents use [fork-agents.md](../fork-agents.md).

### Cards

The server puts these cards on the kitshn map:

- `t3.app`, "T3 on <machine>": the version, the running turns and a busy fact. Its commands are Restart server, Install update when idle, Stop all agents, Pause scheduled tasks and Collect diagnostics. Its lists hold the scheduled tasks (Run now, Pause, Resume) and the client sessions (Revoke session), at most 100 rows each. Its setting `updateChannel` picks the release feed, see [Fork releases](#fork-releases).
- `t3.thread`: one card for each thread with an open guest link.
- `t3.settings`: the T3 settings state, see [Settings and theme sync](#settings-and-theme-sync).

kitshn runs a command at once when a grant allows it. Otherwise the command waits for the owner as a kitshn job.

- **Limits:** the busy fact and the lists refresh every 15 seconds. kitshn gets a card again only when it changed.
- kitshn drops a card part that breaks its rules, such as a list row, and keeps the rest. Settings > Machines names what it dropped.

### Access from kitshn

The kitshn grants decide who gets in: browsers through Cloudflare Access, other machines and guests. The kitshn daemon checks each new visitor and tells the server its levels. On `t3.app`, view gives `read`, use gives `standard` and control gives `admin`.

- A grant that drops ends the sessions that it no longer allows. A session whose Access token only expired stays; its next request brings a new token.
- **Pause:** kitshn's emergency pause closes every grant and every link at once (K-1618).
- **Limits:** while the kitshn daemon is down, new visitors are refused. Open sessions keep working until their answer ends: at the latest when the Access token expires, a grant ends, or 24 hours after kitshn's last answer.

### Environment name from kitshn

Use the kitshn map name of the machine as the server environment name. A name change on the kitshn map updates connected clients without a restart.

- **Setting:** `environmentLabelFromMachineMap` (server setting, off by default). Settings > Machines > kitshn > "Environment name from kitshn".
- **Limits:** without a kitshn name, the server keeps the operating system name.

### Work on other machines

A kitshn link makes another machine a linked environment. Agents pass its `environmentId` to the T3 tools, for example `t3_thread_list`, `t3_thread_launch` or `delegate_task` with `target.environmentId`. `t3_environment_links` lists the linked machines. A delegated task runs on the other machine and wakes the parent thread when it ends.

- **Setting:** on the kitshn map, the owner shares the `t3.app` card of the other machine with this machine.
- **Access:** the level of the `t3.app` grant applies. `read` is read-only. `standard` gives `auto` and changes only the threads that its own link started. `admin` gives full access.
- **Thread limits:** each call carries the limits of the calling thread. The other machine applies the narrower of those and the level.
- **Manual links:** `t3 environment link` and `t3 environment unlink` refuse. Settings > Environments shows the kitshn links read-only.
- **Audit:** the kitshn link proxy records each forwarded tool call, without arguments or output.
- **Limits:** a call goes through the link socket of the kitshn daemon, a named pipe on Windows.

### Commands on other machines

An agent runs a shell command on another machine with `machine_exec`. kitshn runs the command on that machine, as the user of its T3 provider, in the home directory or a given directory. T3 on that machine is not needed, so this also works to repair it. The result holds the exit code, stdout and stderr. In a shell, `t3 machine exec` runs a command like ssh: stdin goes in, stdout and stderr come back as the command writes them, and the exit code is the command's.

- **Setting:** this machine reaches the `t3.app` card of the other machine, and the kitshn right "Runs commands" of this machine on that machine. "Ask" holds each run for the owner's approval; "Automatic" runs it at once. A terminal thread that another machine starts here needs "Runs commands" at "Automatic" too.
- **Approval:** `machine_exec` waits up to 60 seconds for the owner, then answers "waiting". The run starts when the owner approves it, and its result shows in `machines_read` (`execResults`). `t3 machine exec` prints a waiting line and waits.
- **Who can:** a live full-access/default thread with the orchestration, worktree and pull-request tool capabilities. Restricted threads are refused. In an agent's shell, `t3 machine exec` acts as the agent's thread. Without a thread credential it is refused. No command list grants or refuses a command.
- **Stop:** a lost connection to kitshn ends the run on both machines.
- **In a shell:** in a checkout, use `node apps/server/src/bin.ts` instead of `t3`.
  - `t3 machine exec vps -- uname -a`
  - `t3 machine exec vps --cwd ~/app -- git status`
  - `t3 machine exec vps -- cat app.log | grep error`
  - `echo hi | t3 machine exec vps -- cat`
- **Copy files:** use tar through the pipe. The target folder must exist; put `mkdir -p <folder> &&` before the remote `tar` if it does not.
  - Folder to the other machine: `tar c -C dist . | t3 machine exec vps -- tar x -C /srv/app`
  - Folder from the other machine: `t3 machine exec vps -- tar c -C /srv/app . | tar x -C ./backup`
  - One file to the other machine: `t3 machine exec vps -- 'cat > /tmp/file' < file`
- **Exit codes:** the exit code of the command. 124 when `--timeout` stops it. 255 when the stream fails: a refusal, a denial or a lost connection. The reason goes to stderr.
- **Long jobs:** `t3 machine exec` runs for up to an hour. The end of the agent's turn does not stop it, so an agent can run it in the background. A lost connection stops the command, as with ssh. For a job that must outlive the connection, start it with `nohup <command> > job.log 2>&1 &` in a command that exits 0, and read the log later.
- **Limits:** a `machine_exec` run lasts at most 90 seconds. Use `t3 machine exec` for longer work. `machine_exec` keeps 50,000 bytes of stdout and of stderr. On a Windows machine, PowerShell runs the command, so quote the command for PowerShell.

### Thread mentions across machines

The `@` menu lists the threads of this machine and of the machines that its kitshn links reach. Each thread of another machine names its machine. The agent reads an attached thread of another machine through the link, on the T3 server of that machine.

- **Setting:** a kitshn link to the machine of the thread, see [Work on other machines](#work-on-other-machines). Upstream's Labs setting `linkedEnvironmentsEnabled` must be on for both machines.
- **Works on:** web, desktop and mobile. The client lists the threads of a machine only when it also connects to that machine.
- A send stops when the target machine cannot read an attached thread. Remove the thread, or switch to a machine that can read it.
- **Limits:** a machine asks each linked machine once for its environment id. An offline machine is not listed until it answers.

### Settings and theme sync

The `t3.settings` state on kitshn holds a shared part and a part for each machine, each with server and client settings. Each machine applies the shared part, then its own part over it. In T3 Settings, a change with "All environments" selected goes into the shared part. A synced row shows a sync marker.

- Custom themes (the `themes/` folder, as `sharedThemes`) and `defaultTheme` sync too.
- Keybindings sync while `keybindingSync` is on (off by default). Settings > Keybindings > "Sync keybindings". The shared value replaces the whole `keybindings.json` of each machine, and the machine keeps the file before it as `keybindings.json.bak`.
- Web, desktop and mobile apply the client settings of the machine that serves them. A browser leaves out the settings that only the desktop app uses. The mobile app takes only the settings that it has. A change on the device stays until the synced value changes again.
- Agents set one value of their own machine with `machines_set_setting`. Only the owner changes the shared part: in T3 Settings, or with `t3 tool call` from a shell.
- Paths, secrets and project-keyed maps stay on each machine.

### Settings > Machines

Settings > Machines shows how to join this machine to kitshn, and the kitshn settings of the selected environment. It also shows the kitshn connection: connected, connecting with the last error, or off with the reason, and the reached machines, link proxy and kitshn's last sync. `machines_read` gives agents the same state.

- A notice names the card parts that kitshn dropped.
- `T3CODE_KITSHN=off` in the server environment keeps a server off kitshn. A dev server never registers. Only one T3 server of a machine registers; a second one shows kitshn's refusal.
- The desktop app has "Join with a device invite": paste a kitshn device invite link there, see [Device invites](#device-invites).

### Device invites

A phone or a desktop app joins kitshn with its own device token (K-1601). On the kitshn map, "Add device" gives a one-time link `https://<kitshn>/join/device#code=…`. It works once and expires after 15 minutes.

- **Phone:** scan the link in Add environment, or paste it in Address.
- **Desktop:** paste the link in Settings > Machines > "Join with a device invite". The desktop app never uses the machine token of the kitshn daemon.
- The app keeps only the `t3.app` cards that the token opens, and pairs with each machine. It reads the list at start, when it comes back to the foreground, and on Settings > Fork > App token > Refresh machines (phone). The desktop app also reads it every 30 seconds, adds each new machine as an environment, and removes an environment that it added when the list drops the machine.
- A refused machine pairs again with a backoff, because Access can take some seconds to accept a new token.
- An empty or refused list disables or removes no saved machine. The machine shows the reason instead.
- If kitshn is paused (423), Cloudflare refused the new token (502), or kitshn has no Cloudflare API token (503), the invite stays: try it again. A lost answer uses the invite up, so ask the owner for a new one.

### Machines panel

The right panel of a thread lists the machines that the kitshn links of this machine reach, with a link to the kitshn map. Open it from the "+" menu of the panel, or with "Show machines" in the command palette.

- **Works on:** web, desktop.
- **Limits:** the mobile app has no Machines panel.

## Updates and releases

### Fork releases

Nightly desktop builds for macOS, Windows and Linux, plus Linux server archives and `SHA256SUMS`. A release builds on each push to main that changes more than docs. `t3 update`, "Update everything" and `scripts/install.sh` install from the fork releases. Each morning one nightly becomes a release with notes in three sections: fork changes, upstream changes and their integration. How releases build: [Fork Release](operations.md#fork-release) and [Daily release](operations.md#daily-release).

- **Works on:** desktop and server.
- **Limits:** macOS builds use a self-made certificate and are not notarized, so the first install needs Control-click > Open. Revisit if the fork gets an Apple developer account.
  - The fork releases have one track, so the desktop app hides the upstream Settings > About > Update track switch and its search item (`SHOWS_DESKTOP_UPDATE_TRACK` in `apps/web/src/components/settings/forkSettingsSearch.ts`). That switch moves machines to upstream npm releases. A saved Stable channel loads as nightly (`apps/desktop/src/settings/DesktopAppSettings.ts`), and the server refuses a Stable switch from a remote client (`apps/server/src/cloud/selfUpdate.ts`). Revisit if the fork publishes a stable track.

### Android APK

A signed Android APK of fork main, on fork releases that changed the app. It installs next to the store app and speaks the protocol of fork main.

- **Install:** on the phone, open [Add with Obtainium](https://apps.obtainium.imranr.dev/redirect?r=obtainium://app/%7B%22id%22%3A%22com.yardenzamir.t3code%22%2C%22url%22%3A%22https%3A%2F%2Fgithub.com%2FYarden-zamir%2Ft3code%22%2C%22author%22%3A%22Yarden-zamir%22%2C%22name%22%3A%22T3%20Code%20fork%22%2C%22additionalSettings%22%3A%22%7B%5C%22includePrereleases%5C%22%3Atrue%2C%5C%22fallbackToOlderReleases%5C%22%3Atrue%2C%5C%22apkFilterRegEx%5C%22%3A%5C%22android%5C%5C%5C%5C.apk%24%5C%22%7D%22%7D). It tracks the fork releases with "Include prereleases" and "Fallback to older releases" on, and the APK filter `android\.apk$`.
- **Install by hand:** open the APK of the newest release that has one, and allow installs from that browser. Install a newer APK over it to update. Most releases have no APK, because only a release that changed the app builds one.
- **Limits:**
  - No push notifications, because the build has no `google-services.json`. Revisit when the fork has a Firebase project.
  - `t3code://` links open the Play Store app, because the APK uses the `t3code-preview` scheme. Revisit when the APK build registers its own scheme for those links.
  - No over-the-air updates, because those come from the upstream Expo project. Update with Obtainium.
  - arm64 phones only.

### Fork installers

One command installs the fork from the fork releases on macOS, Windows or Linux, then names the kitshn join step. The installer does not build from source. Commands and options: [Install the fork](operations.md#install-the-fork).

### Install when idle

While agents or programs in terminal threads run, the desktop update button offers "Install when idle" next to "Install now". The app installs the update when no agent turn and no terminal thread program runs. A terminal thread program holds the update by the rules of [Server auto-update](#server-auto-update): at most 6 hours from the choice, then a notice in its terminal, and the install about 10 minutes later.

- **Works on:** desktop.
- **Limits:** the wait lives in the window, so a window reload drops it. Revisit if a reload during the wait loses an update in practice.

### Server auto-update

A headless server that runs as the background service installs each newer fork release when no agent turn, no background shell and no program in a terminal thread runs. A program in a terminal thread holds the update for at most 6 hours (`TERMINAL_UPDATE_HOLD_MAX_HOURS` in `packages/contracts/src/forkTerminalThreads.ts`). Then its terminal shows a notice, and the update installs about 10 minutes later and ends the program.

- **Setting:** server setting `forkAutoUpdate` (off by default). Settings > Maintenance > Updates > "Server auto-update".
- **Works on:** server (the background service of `t3 service install`). The desktop app updates itself.
- **Limits:** the restart stops running turns. Turn on [Recover interrupted agents](#recover-interrupted-agents) to continue them. Details: [Server updates](operations.md#server-updates).

### Newer update before install

Before the desktop app installs a downloaded update, it checks for a newer release. If one exists, it asks "Download newer" or "Install this one". Install when idle and the kitshn install-update command take the newer release.

- **Setting:** client setting `checkNewerBeforeUpdateInstall` (off by default). Settings > About > App > "Check for a newer update before install".
- **Works on:** desktop.

### Changelog

A timeline of fork releases and their commits, the upstream commits that fork main does not have yet, and the Fork Sync runs.

- **Setting:** client setting `forkChangelogEnabled` (on by default). Settings > About > App > "Fork changelog".
- **Works on:** web and desktop (the Settings row). The update popover is on desktop only.
- **Open it:** from the Fork changelog row in Settings, or from "Open changelog" in the update popover. With the setting on, the update popover shows the changelog of every release between the installed version and the offered one.
- **Releases tab:** commits, newest first, with a divider for each release, its time and an "Installed" mark. A fork icon marks a fork commit, and a down-arrow icon marks an upstream commit. A `#123` in a commit subject links to the pull request of its repository. Merge commits do not show.
- **Upstream tab:** the upstream main commits that fork main does not have yet. "Start Fork Sync" starts the sync and shows the run and each job. It needs the `source-control:write` scope.
- **Ask agent:** opens a thread in the fork project of the same machine, with a changelog chip and a prompt to read and send. The fork project is the first project whose repository is `Yarden-zamir/t3code`, as the only remote or as `origin` beside an `upstream` remote. Without one, the menu shows an error.
- **Limits:**
  - The server reads GitHub with the GitHub credential of its machine (settings, `GH_TOKEN` or `gh auth login`). Without a credential, the changelog shows the GitHub error.
  - Each release costs two GitHub requests, so the timeline shows 10 releases first, and "Show older releases" adds 10 more. A range of more than 500 commits stops at 500 with a note. Revisit if GitHub rate limits become a problem.
  - When GitHub does not answer, the update popover shows the release notes instead.

### Maintainer tools

These README lines are maintainer procedures:

- Local deploy: [Deploy a local build](operations.md#deploy-a-local-build).
- Local Mac build: [Local Mac build](operations.md#local-mac-build).
- Fork Sync: [Fork Sync](operations.md#fork-sync).
- Fork CI: [Fork CI](operations.md#fork-ci).
- Repair agent: [Repair agent](operations.md#repair-agent).

## Agents

### Recover interrupted agents

Every agent runs as a child process of the T3 server, so an update, a crash or a quit stops them all. With this setting, the next server start sends each cut-off thread a short message, so that its agent continues.

- **Setting:** server settings `recoverInterruptedTurns` (off by default), `recoverInterruptedTurnsMessage` (default "Recover and continue") and `recoverInterruptedTurnsSubagentMessage` (default "Recover and continue. Your parent thread was also restarted."). Settings > Maintenance > Updates > "Recover interrupted agents".
- **Works on:** server.
- A thread gets the message when the restart stopped its turn, or when its finished turn still had open background work: a native subagent, a monitor or a background shell. A delegated thread gets the subagent message.
- The thread shows the message as a "T3 Code restarted" notice. The agent receives the message text.
- No message goes to a thread that you stopped, snoozed or settled, to a turn that ended on its own, to a turn that waited for an answer, an approval or a secret, to a turn that did not start, to a thread without a saved provider session, or to a thread with newer work. Held queued messages stay held.
- **Limits:**
  - A native subagent, for example a Claude Code Task subagent, is not a T3 thread. The message to its parent covers it, with a note that names the stopped work.
  - Each stopped turn gets one message at most. After three recoveries in a row, the thread waits for you, so a restart loop stops.
  - A project that turns off "Continue threads after restarts" gets no message.

### Background work details

Background work notifications name their tasks and output files. A status icon opens a details popover, and the links in a plain title open.

- **Setting:** client setting `backgroundWorkDetails` (on by default). Settings > General > Display > "Background work details".
- **Works on:** web, desktop.
- **Limits:** the mobile app shows only the upstream pending work. Revisit when mobile users need the task names and output files.

### Pull requests from origin

A fork checkout lists, reads and watches the pull requests of its fork, not of upstream. Upstream T3 names a checkout by its `upstream` remote first. With this setting, `origin` comes first.

- **Setting:** server setting `preferOriginRemote` (off by default). Settings > Source control > Fork checkouts > "Pull requests from origin".
- **Works on:** server, so every client.
- **Limits:** pull request creation and the pull request of the current branch follow gh's default repository, then `upstream`. Run `gh repo set-default <owner>/<fork>` in each fork checkout. Revisit if a fork checkout without a gh default creates a pull request on upstream.

### Pull request watch remark filter

Selects which comments and reviews wake an agent that watches a pull request.

- **Setting:** server setting `pullRequestWatchRemarkFilter` with `authorAssociations`, `authorLogins` and `agentMarker` (all empty by default). Settings > Source control > Pull request watch: "Roles that wake agents", "Logins that wake agents" and "Agent remark marker".
- **Works on:** server. Edit it on web or desktop.
- With both lists empty, the upstream rule applies: a remark wakes the agent unless the account of the server wrote it.
- With a list set, a remark wakes the agent only when its author matches a role (`OWNER`, `MEMBER`, `COLLABORATOR` and so on) or a login. Logins compare without case. The own-account rule does not apply then.
- A remark that contains `agentMarker`, for example `<!-- agent -->`, never wakes the agent.
- Check, conflict and push news and the comment wake limit do not change.
- **Limits:** a GitHub App bot has no role, and only GitHub reports roles. On other hosts, and for bots, use `authorLogins`.

### Agent session import limits

Sets how far back recent Claude Code and Codex sessions are offered for import, and how many messages an imported session keeps.

- **Setting:** server settings `agentSessionImportWindowDays` (default 30, 1 to 3650) and `agentSessionImportMaxMessages` (default 200, 1 to 10000). Settings > Threads > New projects > "Session import window" and "Imported messages per session".
- **Works on:** server.
- An imported session keeps its first user message and the newest messages up to the limit.

### Publish to kitshn

Agents publish a file or a folder of their workspace to kitshn, and give the card a new address name. The tools are `kitshn_publish` and `kitshn_address`. They run the machine's kitshn 2 CLI, which sends each call through the local kitshn daemon (kitshn K-1116, K-1120, K-1123, K-1714). No agent and no T3 setting holds a kitshn token.

- **Setting:** none in T3. Join the machine to kitshn, so its daemon runs. Without a daemon, the tool returns the kitshn error.
- The call carries the thread's token in `KITSHN_ATTEST` (`t3:<token>`). The daemon asks this server over the provider connection who holds it, and kitshn labels the call with the thread (K-1752). Agent shells get `KITSHN_ATTEST` too, so `kitshn` commands of an agent name its thread.
- A call with a thread credential fails closed. When the server cannot vouch for the thread in 2 seconds, or the thread is archived or deleted, the tool returns the kitshn error.
- **Works on:** server, so every client.
- Only a live full-access/default thread on this machine can publish. An agent on another machine cannot.
- A caller without a thread credential, such as an OAuth client, gets a refusal.
- `path` is relative to the thread's worktree, or its project folder. The tool refuses a path outside that folder after links resolve, and a path in a dot folder or to a dotfile.
- The server uses `~/.local/bin/kitshn`, else the first `kitshn` in an absolute PATH folder that is kitshn 2. The PATH is the one that the server reads from the login shell at start. The check runs without a credential. A binary is kitshn 2 when `kitshn version --json` prints `{"product":"kitshn","generation":2,…}`. KitSHn 1 never runs. When no binary is kitshn 2, the error names the paths that it found.
- A call stops after 150 seconds, a little above the daemon's own 120-second call limit. kitshn refuses at once when a right is unset or set to "ask".
- **Limits:**
  - The server checks a binary once per path and change time. A new install at the same path with the same change time is not checked again. Revisit if kitshn installs keep the change time.
  - While the server is not connected to kitshn, kitshn calls of its threads fail, because no server vouches for the thread.
  - A process of the same user, such as an agent in another full-access thread, can replace `~/.local/bin/kitshn` with a file that answers the version check. That file then gets the credential of the next thread that calls a kitshn tool. The change-time cache does not stop this, because the file can keep the old change time. Revisit when agents run as a user other than the server, or when kitshn signs its binary.

### kitshn provider

The server shows itself as cards on the kitshn map, with its commands (kitshn K-704 to K-709). kitshn is the only way this server joins other machines. The server runs `kitshn provider` of the machine's kitshn 2 and keeps it running. The child sends JSON lines to the local kitshn daemon. Without kitshn 2, the server works as upstream T3 Code, with no machine features.

- **Start:** join the machine with `kitshn join <code> --server <address>`, or with the agent tool `machines_join` from a shell (agents cannot join). There is no setting: the server connects whenever kitshn 2 is on the machine.
- **Cards:** one `t3.app` card "T3 on <environment name>", with the version, the running turns and a busy fact, and the server port as its site; kitshn names the host. The busy fact is "true" while an agent turn runs, so kitshn holds jobs sent "when idle". Each thread with an open guest link also gets a `t3.thread` card under the app card, named by the thread title, with an "Open thread" sticker to its guest page. The card goes when the link ends. The server checks the facts and the shared threads every 15 seconds, and sends only the cards that changed. The `t3.app` kind has owner control, so the owner always holds it.
- **Name:** with "Environment name from kitshn" on, the environment name is the machine name on the kitshn map.
- **Access:** for each request with identity headers (a tunnel request), the server asks the daemon (`check`, K-721). The daemon checks the Access token and the grants, and answers the levels of the subject: a person, a device or another machine. The server keeps the answer until it ends. The desktop window, loopback and tailnet pairing keep T3's own auth. A refused tunnel request gets no session; there is no other Access login.
  - `t3.app`: `read`, `standard` and `admin` give the scopes of the levels of the same name, without pairing-link and relay rights. Another machine gets the session of that machine, with the link access of its level.
  - `t3.thread`: opens only the guest page of that thread, without a guest link. `view` reads the thread. `send` also sends as the guest does, after the guest joined. The guest link itself works as before.
  - When the grants change, the server checks its sessions again and ends the ones that lost access, with their WebSockets. Failed ends wait on disk (`kitshn-grants.json` in the server state dir) and run again, also after a restart.
- **Settings:** the `t3.settings` state on kitshn sets the server settings, themes and keybindings: the shared part first, then this machine's own part over it. `machines_set_setting` sets one key of this machine's part or of the shared part; the shared part needs a full-access caller, and machine-local keys are refused.
- **Commands:** Restart server, Install update when idle, Stop all agents, Pause scheduled tasks and Collect diagnostics. The card shows only the commands that this server can run now: Restart server needs a supervisor, and Install update needs the background service. A restart answers kitshn first and then restarts. An agent sends a command to a machine with `machines_command`, as a kitshn job; it can wait for the owner.
- **Agent tools:** `machines_read` (what kitshn shows this machine), `machines_command`, `machines_queue_cancel` (only jobs that this machine queued), `machines_resources` (CPU, memory and disk of this machine for the last hour), `machines_set_setting` and `machines_join`. Access between machines, history, undo and presets are on the kitshn map.
- **Diagnostics:** kitshn gets redacted diagnostics. Each process shows only its program name, never its arguments. Secrets in error texts become `REDACTED`: URL tokens such as a pairing link, `key=value` and `"key":"value"` for secret key names such as `token` and `password`, `NAME=value` env values, the word after `Bearer`, `token:` or `--token`, and known token formats.
- **Failures:** without kitshn 2, after a refusal, or when the child exits, T3 runs normally and tries again. After a connection that registered, T3 tries again after 1 second, because a daemon restart ends the child. A child that does not answer `register` in 10 seconds, or that sends nothing for the daemon's grace time (45 seconds), counts as ended: T3 ends it and says why in Settings > Machines. Each further try waits 5, 10, 20 and then 30 seconds. After a daemon restart, kitshn holds a queued command for 60 seconds until T3 registers again, and these waits stay inside that time.
- **Instance:** the server registers with its environment id. kitshn refuses a second T3 server of the same machine while the first one is connected. A dev server never registers, and `T3CODE_KITSHN=off` keeps a server off kitshn.
- **Protocol:** kitshn provider protocol 2 only. The server and the kitshn daemon of a machine update together.
- **Remove T3:** stop the T3 server first. Then run `kitshn provider forget t3` as the kitshn daemon user. The owner then selects "Forget provider" on the kitshn map.

### Scheduled task model

A scheduled task runs on any provider instance, or on the project default model. Pick it in the scheduled task editor.

The model applies to runs that launch a new thread. A run that posts into a bound thread uses the current model of that thread.

- **Works on:** web, desktop, mobile.

## Threads

### Sidebar tabs

Tabs under the sidebar search hold threads. A thread lives in one tab, so the tabs act like folders.

- **Setting:** client settings `sidebarTabsEnabled` (off by default) and `sidebarTabSingleThreadOpens` (off by default). Settings > General > Sidebar > "Sidebar tabs" and "Single-thread tabs". The tabs are the server setting `sidebarTabs` of the primary server. kitshn syncs them to every machine. The mobile app shows the tabs while the server setting `mobileSidebarTabs` is on (off by default): Settings > Appearance > Mobile app, or Fork in the mobile Settings.
- **Works on:** web, desktop, mobile. On mobile the tabs show above the thread list. Tap a tab to show its threads. Long-press a tab to edit, move or delete it, and tap + to make a tab. Long-press a thread and pick "Assign to tab". Settings > Fork > Sidebar tabs lists the tabs too.
- **Use it:**
  - The first tab, "Threads", holds every thread that is in no other tab. It can be renamed, and it can show all threads.
  - Drag a thread onto a tab to assign it to that tab. During a drag, a + shows at the end of the bar. A drop on it makes a new tab.
  - Right-click the bar outside a tab and pick "New tab" to make an empty tab. Right-click a tab, or click the sliders button of the open tab, to rename it, pick its icon, edit its rules, move it or delete it.
  - Rules put threads in a tab. A thread matches a tab when it matches every rule. Rules compare the repository, the repository owner, the status, the provider, the creator, the background work and the title. A repository rule matches on every machine.
  - A thread lives in the tab that you assigned it to. Otherwise it lives in the first tab, from left to right, whose rules match. Otherwise it lives in "Threads".
  - A rule on "Tab" makes a view: a tab that shows the threads of other tabs. Pick Tab > "Any tab" for an "All" tab.
  - A tab shows the status of its most urgent thread. Settled and snoozed threads stay in the Settled and Snoozed shelves of their tab.
  - With "Single-thread tabs", a tab with one thread shows that thread on its tab, and a click opens it.
  - Each tab has an icon, or a dot by default. Turn off "Show the name on the tab" to show the icon only.
  - Tabs that do not fit go to a "+N" menu. Drag a tab to move it; the first tab stays first.
  - Search covers every tab. A thread that you open from a link or a notification shows its tab.
- **Limits:**
  - On mobile, "Single-thread tabs" does not apply, and a thread link does not switch to the tab of the thread. Revisit if users open threads from links on the phone often.
  - The hosted app at app.t3.codes has no primary server to keep the tabs, so it shows no tabs. Revisit if hosted clients get a place for shared settings.
  - When two devices change tabs at the same moment, the last change wins. Revisit if tabs get lost in practice.
  - A machine without the map role `edit`, or off the map, keeps a change on its own server only.
  - Tabs were called groups before. A server moves `sidebarGroups` and `mobileSidebarGroups` in `settings.json` to the new keys once at start, and renames the old `sidebar.group.*`, `sidebar.previousGroup` and `sidebar.nextGroup` keybindings. A client moves `sidebarGroupsEnabled` and `sidebarGroupSingleThreadOpens` when it loads. A machine on an older version keeps the old keys, so it does not sync tabs with a machine on a newer version until both update. The open tab resets to "Threads" once.
  - Applies only after upstream thread groups merge ([pingdotgg/t3code#15988](https://github.com/pingdotgg/t3code/pull/15988) "feat: related threads stay together as a group"): a nested thread always shows in the tab of its top thread, so a nested group never splits across tabs. This holds for views too. A drag or "Assign to tab" on a nested thread assigns its top thread. Fork Sync resolves that merge with this rule.

### Waiting shelf

The sidebar lists threads that wait in a Waiting shelf, under the Working shelf.

- **Setting:** the Working shelf setting, client setting `sidebarWorkingShelfEnabled`. Settings > General > "Working section". On mobile: Settings > General > Sidebar > "Working section".
- **Works on:** web, desktop, mobile.
- **Use it:** a thread is in the Waiting shelf when its run waits on another thread, or when background work that the agent waits on holds its completion (`forkThreadIsWaiting` in `packages/client-runtime/src/state/forkTerminalThreads.ts`). A thread is in one shelf only. Waiting wins over Working. The shelf has the count, the collapse toggle, the sort and the drag rules of the Working shelf. When no thread waits, the shelf does not show.
- **Limits:** the boring sidebar in Labs has no Working shelf, so it has no Waiting shelf.

### Worktree path template

A template decides where new worktrees go, for example next to `main/` in a `.bare` container.

- **Setting:** server setting `worktreePathTemplate` (empty by default: the worktree location setting applies). Settings > Worktrees > Creation > "Worktree path template".
- **Works on:** server.
- The variables are `{worktrees}` (the worktree location), `{repoDir}` (the checkout, or the `.bare` container), `{repo}` (the folder name of `{repoDir}`), `{branch}` (with `/` changed to `-`) and `{branchLeaf}` (the last part of the branch). The template must hold `{branch}` or `{branchLeaf}`.
- For a `.bare` container, use `{repoDir}/{branchLeaf}`. A worktree for `feat/api/qcdi-1234-auth` then goes to `<container>/qcdi-1234-auth`, next to `main/`.
- In a normal clone, a template path inside a checkout uses the default worktree location instead, so `{repoDir}/{branchLeaf}` works for both layouts. To place normal clone worktrees elsewhere, use `{worktrees}/{repo}/{branch}` or `{repoDir}/../{repo}-{branch}`.
- With a template, an auto-named thread names its branch from the first six words of its first message, so the folder and the branch keep the same name. The static branch naming mode adds its prefix. A taken name gets a `-1`, `-2` suffix. When a branch such as `t3` blocks `t3/x`, the name becomes `t3-x`.
- **Limits:** a branch that you type, and a pull request branch, keep their names. If their folder exists, the launch fails and names the folder. Use `{branch}` when different branches end in the same last part.

### Thread link chips

Upstream shows every `t3-thread://` link in chat as the chip of an attached thread. With this setting, thread addresses and app links become chips too, and open the thread in T3 Code.

- **Setting:** server setting `threadLinkChips` (off by default). Settings > Appearance > Thread links > "Thread link chips". In the mobile Settings: Threads, or Fork.
- **Works on:** web, desktop, mobile. Mobile reads the setting of the server of the thread, and has no switch of its own.
- The chip reads `t3code://threads/<environmentId>/<threadId>`, `https://<host>/<environmentId>/<threadId>`, and the attached-thread marker `[Thread: <title>; ref=<contextId>]` that agents copy.
- An app link or a web address becomes a chip only when this client knows the environment. Copy keeps the link as written.
- A `t3-thread://` link to a thread on another machine opens that thread when this client knows its environment.
- A link that names a message shows a marker: `#` on web and desktop, a message icon on mobile. See [Message links](#message-links).
- **Limits:** on mobile, the project icon of the thread replaces the message icon in chat messages (upstream pingdotgg/t3code#22585). Revisit if message links on mobile need their marker back.

### Message links

A thread link that names a message opens the thread at that message. Use **Copy message link** beside a message on web and desktop, or hold its copy button on mobile. The command palette copies the message under the timeline cursor; bind `timeline.copyMessageLink` in Settings > Keybindings if needed. The app loads earlier history and opens a folded turn when needed, scrolls to the message and highlights it for a moment.

- **Setting:** server setting `messageLinks` (on by default). Settings > Appearance > Thread links > "Message links". In the mobile Settings: Threads, or Fork. Off: **Copy message link** is hidden. A link that names a message still opens the thread at that message.
- **Works on:** web, desktop, mobile.
- **Forms:** `t3-thread://v2/<environmentId>/<threadId>#<messageId>`, `t3-thread://v1/<threadId>#<messageId>`, and a thread address or app link with `#<messageId>` or `?message=<messageId>`. Agents take `messageId` from `t3_thread_read`, also for a thread on another machine.
- A message that the thread does not have shows "Message not found", and the thread stays open.
- **History:** on web and desktop, each jump to a message is a history entry. This includes links, pins and citations. Back and Forward return to where you were in each entry. A scroll by hand adds no entry. No setting turns this off.
- **Limits:** the app keeps the position of each entry in memory, so after a reload Back opens the message of the entry again. On mobile, a jump in the same thread adds no Back step. On mobile, a reply hidden in the fold of a prompt without a run shows as not found. Revisit when upstream pingdotgg/t3code#19203 merges; then use its scroll code.

### Message pins

Pin a message with the pin button beside its copy buttons, or with the command palette item "Pin or unpin message" for the message under the timeline cursor. Bind `timeline.pinMessage` in Settings > Keybindings if needed. A pinned message keeps its buttons visible. **Pins** in thread details lists the pins of the thread. A pin button next to Usage in the sidebar footer lists the pins of all connected environments; it shows only while one pin or more exists. A click on a pin opens the thread at that message.

- **Settings:** client setting `messagePins` (off by default), Settings > General > Display > "Message pins". Server setting `mobileMessagePins` (off by default), Settings > Appearance > Mobile app > "Message pins on mobile": a long press on a message in the mobile app offers Pin and Unpin.
- **Works on:** web and desktop. Mobile: Pin and Unpin only, no list.
- **Storage:** the server setting `pinnedMessages` of the environment, so all its clients show the same pins. Restore defaults keeps the pins. kitshn does not sync them, because thread ids belong to one environment.
- **Limits:** an environment keeps 200 pins. A pin keeps a 160-character excerpt and the thread title from the time of the pin. A pin of a thread that the sidebar does not list shows "Thread archived or deleted". "Message deleted" shows only for the open thread, when all its history is loaded. Agents have no MCP tool for pins.

### Thread addresses open the desktop app

A thread address opened from outside T3 Code, for example from Slack or GitHub, hands the thread to the desktop app. The browser tab then shows "Continue here" and "Open in desktop app".

- **Setting:** server setting `threadLinksOpenDesktopApp` (off by default). Settings > Appearance > Thread links > "Thread addresses open the desktop app".
- **Works on:** web browser tabs. The desktop app, the installed web app and app.t3.codes never redirect.
- **Limits:**
  - When the desktop app is not running, the link that starts it is lost (upstream pingdotgg/t3code#18613). Revisit when pingdotgg/t3code#18422 merges upstream.
  - With `threadLinkChips` off, a thread address clicked in T3 web chat opens a new tab that counts as a link from outside, so it goes to the desktop app too. Revisit if users keep `threadLinkChips` off while this setting is on.

### New thread on mobile

What New thread opens in the mobile app.

- **Setting:** server setting `mobileNewThreadProject`: `picker` (default, the project list), `last` (a draft in the project of the last new thread on the phone) or `none` (a draft without a project). Settings > Appearance > Mobile app. In the mobile Settings: Threads, or Fork.
- **Works on:** mobile.
- Back from the draft shows the project list. A share, a prompt link and "Choose a project" in the draft keep the project list.
- The "New task" launcher shortcut on Android opens the same draft, also when the app was closed.
- The draft opens at once when the phone knows its project, also before a server connects: the last project, or the project of the last thread without a project. Sending waits for the connection.
- A connected environment wins over an offline one. Without a project, the draft opens on a connected environment when the remembered one is offline. With `last`, a last project on an offline environment keeps the project list while another environment is connected. With no connected environment, the remembered project opens.
- **Limits:** `none` needs a server that offers threads without a project. Without one, and with `last` and no earlier new thread, the project list shows. The first thread without a project on a phone waits for the server to make that project.

### Camera in the mobile composer

The plus button of the mobile composer, the new thread draft and question answers offers "Take Photo" next to "Photo Library" and "Choose Files".

- **Setting:** server setting `mobileComposerCamera` (off by default, because on a server without file attachments the plus button opens a menu instead of the photo library). Settings > Appearance > Mobile app. In the mobile Settings: Threads, or Fork.
- **Works on:** mobile.
- **Limits:** photos only, because the app asks for no microphone access. Revisit if video from the camera is needed.

### Android assistant panel

T3 Code can be the Android digital assistant. The assistant button opens a panel over the current app. The panel attaches the screenshot and the screen text, takes typed or spoken text, and starts a new thread or adds the message to an existing thread. The title of the panel opens a picker with a search, the recent threads and the projects. With more than one machine, a machine icon opens the machine list, and the picker then shows the threads and projects of that machine. "Ask T3 Code" in the Android share sheet opens the same panel with the shared text or image. Context pills show the context: the shared item, the screenshot, the screen text, the text selected on screen, the page link, the clipboard, and, when turned on in Settings > Voice, the newest photo of the last 15 minutes and the last known location. A tap attaches a pill or leaves it out; a hold opens it to read and edit the text, or to crop and draw on an image. The "+" pill comes first and adds photos, a camera photo, files (when the server takes uploads), and the newest photo or the location for one press. The arrow on top of the panel, tapped or dragged up, continues in the app: a thread gets the text and the attachments in its composer, and a new thread opens its draft screen. After sending, the panel can show the replies to its messages and send follow-ups to the same thread. The screen text pill is named after what the screen shows (video, chat, music, page, home screen, or the app), from the link, the structured data and the clip that the app reports (`apps/mobile/src/features/assistant/screenSubject.ts`). App categories and window titles are not used, because phones report them wrong. On a Chrome page, the screen text is the whole page from Chrome's page content provider, which Chrome opens to the default assistant for 60 seconds. A video link opens at the reported position. A glow along the screen edges replaces a dim layer, so the app under the panel stays readable. Text that was not sent comes back when the panel opens again within a minute.

- **Setting:** the Android setting Default apps > Digital assistant app. The options are phone-local preferences under `voice` (`apps/mobile/src/persistence/forkVoicePreferences.ts`), in Settings > Voice of the mobile app: a new thread or the last opened thread (a new thread by default), keyboard or voice first (keyboard by default), start the thread after speaking (off), attach the screenshot (on), attach the screen text (on), the whole page in Chrome (on), after sending: close, show the reply in the panel, or open the thread (close), the edge glow time (5 seconds; off, 3, 5, 10 seconds, or until the panel closes), read the first reply aloud (off), and the project (the last new thread project by default).
- **Works on:** mobile, Android 10 or later.
- The panel and the app share one JS runtime. The outbox sender and the T3 Connect sign-in run once across both (`apps/mobile/src/lib/singletonHost.ts`).
- The message goes through the thread outbox, so a new thread uses the project's model defaults, and the message waits for the connection when offline. A message to an existing thread is queued after a running turn, so "read the first reply aloud" reads the reply to that message.
- **Limits:** no lock screen launch, because anyone that holds the phone could start agent work. A share of several images keeps only the first; revisit if users share albums. The location is the last fix the phone knows, so it can be old or missing; it never turns on GPS. Revisit with a request to unlock first. Password fields are left out of the screen text. Apps that block screenshots send none.

### Read aloud on mobile

A read-aloud button next to copy and fork on each reply. Holding it reads every new reply of that thread aloud, until it is held again.

- **Setting:** phone-local preferences under `voice`, in Settings > Voice of the mobile app: the read-aloud button (on by default), the threads that read new replies, and the speech rate.
- **Works on:** mobile.
- The text is cleaned for speech: a code block becomes "Code block.", and markup characters are dropped.
- Only replies of runs that complete after the thread starts to read aloud count, so a thread never reads its history.
- **Limits:** replies are read only while the app or the assistant panel is on screen, because Android pauses JS timers in the background. Revisit if users ask for replies with the screen off: that needs a native player driven by the agent push notification.

### Thread card layouts

Build the thread card from its elements, for desktop and web and for mobile.

- **Setting:** server setting `threadCardLayouts` with `desktop` and `mobile` (both `null` by default: the built-in card). Settings > Appearance > Thread cards. The setting is shared with every connected server that supports shared settings.
- **Works on:** web, desktop, mobile.
- A layout is rows of elements. Each row has a left group that takes the free width and a right group that keeps its size. Drag an element into the Hidden tray to hide it. The title and the status cannot be hidden.
- Each element carries `data-thread-card-element="<name>"`, so theme CSS can style one element.
- **Limits:** the mobile tab offers no terminal or diff element. The preview shows the mobile arrangement with web styles. Sidebar search results and app.t3.codes keep the built-in card.

## Filters

### Repository owner filters

Filters the pull request page and the sidebar by the owner of each repository: a GitHub account or organization.

- **Setting:** client setting `repositoryOwnerFilters` (on by default). Settings > General > Sidebar > "Repository owner filters". The sidebar choice is the client setting `sidebarOwnerFilter`.
- **Works on:** web, desktop.
- Pull request page: open Filters > Owner, pick "Show only selected" or "Hide selected", then pick the owners. In the search, type `org:` or `owner:` to show an owner, and `-org:` or `-owner:` to hide one.
- Sidebar: click the building icon next to the project scope. A chip under the header names the filter, counts the hidden projects, and shows how many hidden threads need you.
- A fork checkout counts under the owner of the fork in the sidebar, and under the upstream owner on the pull request page. A project without a remote has no owner: pick "No repository owner" for it.
- **Limits:** the mobile app has no owner filter. Revisit when the mobile parity work reaches filters.

### Pull request filter chips

The active pull request filters show as chips above the list.

- **Setting:** client setting `pullRequestFilterChips` (on by default). Settings > General > Sidebar > "Pull request filter chips".
- **Works on:** web, desktop.
- Click "is" or "is not" on a chip to flip it. A label flips into a typed `-label:`. Click × to remove a filter, or "Clear all".
- When no pull request matches, the empty list names the filters and offers "Clear filters".
- **Limits:** typed qualifiers stay in the search box and get no chip. The mobile app has its own filter menu. Revisit when the mobile parity work reaches filters.

## Scripts and terminal

### Global scripts

Scripts for every project, pinned script buttons, desktop global shortcuts, floating previews and app overlays.

- **Setting:** server settings `globalScripts`, `pinnedGlobalScriptIds` and `pinnedProjectScriptIds` (all empty by default). Settings > Threads > Global scripts.
- **Works on:** web, desktop.
- Pin a script to get a button. Global pins show in the title bar. Project pins show next to the thread details toggle. Right-click a button for the pin menu.
- A global script's preview opens as a floating popup. A script can run in the background without the terminal drawer (`runInBackground`).
- An action with "Open as an app overlay" (`previewOverlay`) opens its page in a large panel over the app. It probes the page URL first. If the page is down, it runs the command in a background terminal and waits up to 20 seconds for an answer. The page can post `{ type: "t3:close-overlay" }` to close the overlay.
- In the global script editor, set "Global shortcut" (`globalScripts[].globalShortcut`) to an Electron accelerator, for example `CommandOrControl+Alt+N` or `F18`. It is off until set. It works from any app while the desktop app runs. It shows and focuses T3 Code, then runs the script like its pinned button. Clear the field, or delete the script, to release its key. Settings > Threads > Global scripts opens the same editor.
- The open thread's environment supplies the shortcuts. With no open thread, the primary environment supplies them. App-toggle keys take priority, then the first script with a key. An unavailable key shows a notification; choose a different key. An unrelated settings write does not release unchanged keys.
- For navgator, add a global script with command `navgator web --no-open`, preview URL `http://127.0.0.1:4747` and "Open as an app overlay" on. Set its global shortcut and open a thread with terminal access. The shortcut starts navgator only if the page does not answer. It uses the page URL, not `/api/health` or a navgator-specific marker.
- **Limits:** starting a command needs an open thread with terminal access, as pinned scripts do. A running overlay page can open without a thread. A remote environment opens an app overlay in the preview instead, because the client cannot frame its page. Web clients can edit the shortcut but cannot register an OS key. The mobile app runs project scripts only. Revisit when the mobile parity work reaches scripts.

### App toggle shortcuts

Global keys that show and hide the desktop app.

- **Setting:** client setting `appToggleShortcuts` (empty by default). Settings > Keybindings > Keyboard > "App toggle shortcuts", for example `F17, Alt+Space`.
- **Works on:** desktop.
- Each entry is an Electron accelerator. The settings field rejects a key that Electron cannot name.
- **Limits:** the ISO section key `§` has no Electron name. Map it to a function key, for example with Karabiner. If another app holds a key, the desktop app logs a warning and skips it. On macOS, the app hides without animation.

### Keyboard focus levels

Escape moves focus from the composer to the timeline, then to the sidebar. Arrow keys move a cursor there to open threads, switch tabs and cite parts of messages. Inside a message, the cursor also stops on links, section headers and buttons, and Enter clicks them.

- **Setting:** client settings `keyboardFocusLevels` (off by default) and `focusLevelHighlight` (on by default). Settings > Keybindings > Keyboard > "Keyboard focus levels" and "Focus highlight". Change the keys in Settings > Keybindings (`focus.*`, `sidebar.*` and `timeline.*` commands).
- **Works on:** web, desktop.
- Keys for thread actions, approvals and right panel tabs, and `mod+,` on web, work with the setting off.
- `focusLevelHighlight` outlines the area that takes focus from a key.
- **Limits:** the setting is off by default because it changes existing keys. Escape in the timeline and the right panel moves focus. A click into the timeline makes Up and Down move the cursor instead of scrolling. `mod+f` in the sidebar focuses sidebar search. Letters typed in the sidebar no longer go to the composer, and digits switch tabs.

### Shortcuts in tooltips

Tooltips, menus and the command palette show the keys of an action as chips, such as "Stash ⌘S".

- **Setting:** client settings `tooltipShortcuts` (on by default) and `tooltipShortcutLimit` (default 4, 1 to 9). Settings > Keybindings > Keyboard > "Shortcuts in tooltips" and "Keys per tooltip".
- **Works on:** web, desktop.
- Your own keys come first. More keys than the limit show as "+N".
- **Limits:** a sidebar tab names no digit while focus levels are off. A sidebar row names the pin and settle keys only for the open thread.

### Keyboard cheat sheet

`mod+/` opens a list of every key that works, grouped by screen area. The area that had focus comes first, marked "Here".

- **Setting:** none; the key is the keybinding command `keyboard.cheatSheet`. Rebind or remove it in Settings > Keybindings. The command palette also has "Show keyboard shortcuts".
- **Works on:** web, desktop.
- A key shows only when it works in its area, and your own keys come first. A search box filters by action or key. While `keyboardFocusLevels` is off, the focus level areas show dimmed, with a button that turns the setting on.
- The terminal keeps `mod+/`, because Ctrl+/ is undo in shells.
- **Limits:** the 1 to 9 jump commands show as one row each.

### Find in settings

On a Settings page, `mod+f` opens a find box in the header. The rows of that page that do not match hide, and a section without a match hides with its header. Enter jumps to the first match. Escape in the box or another page closes the box and shows all rows again. Escape elsewhere closes Settings.

- **Setting:** client setting `settingsFind` (off by default, because it takes `mod+f` from the search of all settings, which keeps `/`). Settings > Keybindings > Keyboard > "Find in settings". The key is the keybinding command `settings.find`, with the `when` condition `settingsPageOpen`. Rebind it in Settings > Keybindings. While the box can open, the command palette has "Find in settings".
- **Works on:** web, desktop. On the list pages Archive, Scheduled tasks, Projects and Open source licenses, `mod+f` stays with the search of all settings. The mobile app has no settings search, so this does not apply there.
- **Limits:** a row matches by its search title and keywords, not by its description. A row without a search item, such as a row that another switch reveals, hides while the box has text.

### Terminal threads

A thread whose screen is a live terminal, next to the other threads of a project. A schedule or an agent can type into it; a webhook task cannot. User guide: [Terminal threads](terminal-threads.md).

- **Setting:** server setting `terminalThreads` (off by default); client settings `terminalThreadFontSizeMin` and `terminalThreadFontSizeMax` (8 and 24), the zoom limits of every terminal (Cmd+=, Cmd+-, Cmd+0, macOS only, because Ctrl+- is undo in shells), and `currentProjectTerminalOpensThread` (off), which makes New terminal thread in current project press the enlarge button at once. Settings > Terminal (`TerminalSettings.tsx`), which holds every terminal setting: the drawer terminal and terminal threads. The terminal font stays in Appearance > Typography, where upstream keeps it; Settings > Terminal has a row that opens it there. Its fork rows render through the places `terminal-all-terminals` and `terminal-threads` (`forkSettingsCatalog.ts`). The Fork page lists them again, with a link to Settings > Terminal, and the settings search finds each row at both places. Keybinding commands `chat.newTerminal` (`mod+alt+t`) and `chat.newTerminalLocal` (`mod+alt+shift+n`).
- **Works on:** web, desktop and mobile create and use them. The mobile app opens one on its native terminal screen. It has no draft terminal: the Terminal control of the new-thread draft (`ForkNewTerminalThreadControl.tsx`), shown only for a draft with a project because a terminal thread needs a project folder, opens a sheet (`ForkNewTerminalThreadSheet.tsx`) that takes the shell and the folder (project folder, an existing worktree from the first page of branches, or a new worktree from the base branch of the draft through `vcs.prepareDraftWorktree`), then creates the thread at once, with the input that the web draft also uses (`terminalThreadCreateInput` in `client-runtime/src/state/forkTerminalThreadCreation.ts`). The mobile terminal screen renames such a thread after its first command, as the web screen does. Remote environments work the same, because the terminal runs on the server of the thread.
- **Setting off:** the server starts no shell of a terminal thread. `terminal.open` and `terminal.restart` of its main terminal, and any `shell` field, fail with `TerminalThreadsOffError`. `terminal.attach` of its main terminal streams the live session or the saved output without a shell (`TerminalManager.forkSavedOutputStream`), so every client, also an older one, shows it read only. The web screen blocks input and names the setting (`readOnlyNotice` of `ForkShellTerminal`). The `terminal` provider instance is disabled, so a message, a schedule or an MCP launch fails. Agents get the text about terminal threads only while the setting is on: it is the `usage` of the `terminal` entry of `orchestrator_capabilities` (`fork/terminalProvider/agentUsage.ts`), not part of the session instructions. A program that still runs keeps running, and its drawer terminals work as in any thread.
- **Thread:** a normal thread with the provider `terminal` (constants in `packages/contracts/src/forkTerminalThreads.ts`). `ThreadRouteView` renders `ForkTerminalThreadScreen` for it, not `ChatView`: the thread header above the main terminal `term-1`, with the drawer for the other terminals. The right panel, the thread details and their shortcuts work like the ones of ChatView: `components/chat/useThreadRightPanel.tsx` holds the panel state of the screen and takes its actions and its layout from ChatView's `useRightPanelActions` and `ChatRightPanel`. Without a composer (`composerDraftTarget` null), the panel offers no "send to chat", "Add to chat" or diff and file comments, and the thread details leave out the project scripts. The environment notices are ChatView's (`useSystemComposerBanners`). The snooze and settle line (`useForkThreadStatusLine`, with the terminal snooze rule) copies the status line part of ChatView's `useThreadLifecycle`, which needs a composer. The thread error banner is the only place a failed message shows.
- **Shells:** the model of a terminal thread is its shell. The `terminal` driver lists the shells of the server as its models (`apps/server/src/fork/terminalShells.ts`): on Unix the executable entries of `/etc/shells` and `$SHELL`, on Windows `pwsh`, `powershell`, `cmd` and Git Bash from the Git install folders (not the WSL `bash.exe` on the PATH), the default shell first, with the path as `subProvider`. Custom shells follow as `isCustom` models: `customShells` (name, executable, args; `TerminalCustomShells` in contracts) in the config of the `terminal` provider instance, edited in Settings > Terminal > Shells (`TerminalShellsSettings.tsx`). The schema refuses a name of `TERMINAL_SHELL_NAMES`, the legacy `terminal` and duplicates. The manager resolves the executable at each start on the PATH of the terminal, with PATHEXT on Windows and a `.cmd` or `.bat` through `cmd.exe /d /c` (`customShellCandidate`). Each provider snapshot checks the executable of each custom shell on the PATH of the server and sets `unavailableReason` (a fork field of `ServerProviderModel`) when it is missing, so Settings shows the error inline, also for a remote server, and both shell pickers mark the shell as not found. `TerminalShellNotFoundError` lists only the shells that can start. Saving a missing executable is allowed, because the PATH can change and each start checks again. A chosen shell runs alone: a failed start fails with its error in the terminal, and only the default shell (no `shell`) falls back to the next candidate. The manager writes the reason of a failed start into the history (`[terminal] …`), because an attach drops an error event that is older than its snapshot. The legacy model `terminal` means the default shell. `terminal.open` and `terminal.attach` take the shell as `shell` (`terminalThreadShell` maps a model to it); an unknown shell, such as a custom shell that was removed, fails the start and not the open, so the session keeps its history and shows `TerminalShellNotFoundError` in it. A message to that thread fails with the same reason (`TerminalPort.open` reads the error event). Settings names the threads that use a custom shell that the user removes or renames. Another shell restarts a running terminal, like another cwd or env. The server owns the launch of the main terminal of an existing terminal thread: `terminal.open`, `terminal.attach` and `terminal.restart` take its folder, worktree, env and shell from the thread record and ignore the client's values (`fork/terminalThreadShellFill.ts`). A client with other values, such as an older web or mobile bundle, would otherwise restart the running program and drop its shell integration. Its drawer and panel terminals keep the client's folder and get the thread's shell when the client names none. A draft has no thread record, so its client sends the launch context (`terminalThreadLaunch`). Agent model pickers (composer, project defaults, mobile) leave the shells out (`withoutTerminalProvider`); scheduled tasks and `orchestrator_capabilities` offer them.
- **Abandoned drafts:** the server closes, with its history, the main terminal of a terminal thread that has no attach stream and no thread for 30 seconds (`apps/server/src/fork/AbandonedTerminalDrafts.ts`, a check every 10 seconds), also one whose shell exited. It is the only place that discards a draft shell. A terminal of a thread that exists stays. The shell of a draft attaches through `attachDraft` (`client-runtime/src/state/terminal.ts`), which detaches 5 seconds after its last view goes, so a draft that the user leaves in the app ends within about 45 seconds. Other terminals keep the 5-minute stream, so a switch back replays no history.
- **Creation:** a new terminal is a new-thread draft in Terminal mode (`apps/web/src/forkDraftTerminalStore.ts`). `useNewThreadHandler` takes a `kind`, so every way to open a draft sets its mode and the project rules of the New thread button apply. `ForkDraftTerminalComposer` replaces the prompt with the main terminal under the thread id that the draft reserves, and a prompt typed in Agent mode stays in the draft: after promotion the draft keeps it under a new reserved thread id. The first command end mark, or a command that runs for a second, creates the thread with the same id and the draft's shell as its model, titled with `terminalThreadTitle` (the command, else the shell); a shell that printed no mark yet (no integration, or bash 3.2) counts an Enter after typed text instead. The enlarge button creates it at once, titled after the shell, and the thread screen renames it after its first command (`terminalThreadCommandTitle`). `startNewThreadFromContext`, the path of every "in current project" entry point, passes `currentProjectTerminalOpensThread` as `opensAsThread`; the draft then calls the same promotion once the server shells are known. The project picker calls `startNewThreadInProject` and keeps the draft. The context strip sets the folder of the shell with the meaning that a chat draft gives it (`forkDraftTerminalWorkspace.ts`), and a change restarts the shell there. New worktree shows Create worktree in place of the shell: `vcs.prepareDraftWorktree` calls `ThreadLaunchService.prepareDraftWorktree`, which runs the worktree preparation of a thread launch without a thread (fetch from origin, temporary `t3/` branch, setup script, `WorktreeSetupTracker` progress under the draft's thread id). The panel shows that progress with `WorktreeSetupCard`. The call returns once the setup script started, or ended for a script that is not async, and the draft then points at the worktree like at an existing worktree. A failure or a cancel before that removes the worktree and closes the setup terminal. An async setup script keeps running in its terminal under the draft's thread id, so the thread gets it in its drawer. A draft that the user leaves keeps the worktree, and the script runs to its end. Limit: a draft has no message to name the branch after, so the branch keeps its temporary `t3/` name, and a worktree path template names the folder after that name. A view transition (`t3-fork-terminal` in `fork-theme.css`) grows the draft terminal into the thread screen; reduced motion skips it. A draft that the user leaves (another route) goes back to Agent mode. No client closes a draft shell, because another tab or client can show the same draft; the server closes it once no client is attached (`AbandonedTerminalDrafts.ts`). `useGrabTerminalFocus` focuses a new terminal once its surface exists, unless the user moved to a text field, a dialog or a menu.
- **Shell integration:** the server starts the shell of the main terminal with a hook that prints OSC 133 marks for the prompt, the start of a command and its end with the exit code (`apps/server/src/fork/shellIntegration.ts`; bash 4.4 or newer, also Git Bash, and zsh; never a custom shell, which keeps its own arguments). A custom shell reports no running program from its child process (`customShell` of the session), because `uv run python` runs python as that child. The start mark carries the command line (`133;C;cmdline=`, control characters as spaces), except for a command that starts with a space, which users type to keep a secret out of the history. `shellMarks.ts` reads the marks and the bell, and `terminalShellState.ts` keeps `shell` (`starting`, `prompt` or `running`), `hasRunningSubprocess`, `attention` and `command` on the terminal summary. `command` is only the program and up to two subcommand words of the last command line (`terminalCommandTitle` in contracts), because it and the titles made from it sync to every client and machine. A finished command raises `attention` only after it ran for `NOTIFIED_COMMAND_MIN_MS` (10 seconds), and a bell at the prompt (a completion beep) raises none. A shell without the hook reports no state. When the server cannot write the hook files at start (a full disk, no permission), it logs a warning, and each terminal thread shell starts without the hook and prints the reason above its prompt. The process poll checks `starting` and `running` against the child processes: after 10 seconds without one (`exec zsh`, a `.bashrc` that runs `exec zsh`), the state is forgotten.
- **Messages:** with `shell` at `prompt`, the `terminal` driver pastes the message (bracketed paste) and presses Enter, so all lines run as one command line with one end mark. It answers with the exit code of the first end mark and the output after the first start mark. A continuation prompt mark (`133;A;k=s`) fails the run and sends Ctrl+C. With `running`, the message waits for the prompt, and a steer meanwhile types into the program; a program that holds the shell for the whole run (10 minutes) fails it with `BUSY_SHELL_MESSAGE`. With no state, it types the message and Enter and answers at once. The adapter supports active steering: a steer waits until the message of the run was typed. A run outside full access mode, or one that the terminal cannot run, fails.
- **Sidebar state:** an unseen bell shows Input, over Working and over the end of the program that rang it (`bellAt` of the attention). An unseen finished command of 10 seconds or more shows Done, or Failed with a non-zero exit code. A shell that failed to start shows Failed until a visit after the failure (`failedAt`, the last update of the failed session). A thread that nobody opened counts everything as unseen. An open thread marks its attention and a failed start as seen while its page is visible, also without focus, like the chat watermark. A program in the foreground (`hasRunningSubprocess` of the main terminal) shows Working, like an agent run, and puts the thread on the Working shelf; the running-terminals icon of the row counts only drawer terminals, because the main terminal is the thread. A bell or a program end returns the thread to the top of the inbox, also in the folder sidebar, which sorts by send time (`sortWorkingThreadsBySend` with `forkInboxReturnAt`). A bell or an ended program after a snooze wakes the thread, in every list, menu and group tab. The web sidebar and the mobile thread list show the same states (`packages/client-runtime/src/state/forkTerminalThreads.ts`): the thread shell atoms put the state of the main terminal on each terminal thread as `terminal`, and read terminal metadata only for an environment with terminal threads. A terminal thread has no Mark unread: the server marks a thread unread from its last message run, and a terminal thread shows its states without runs.
- **Shell exit:** a shell that exits or is killed leaves the session of the main terminal exited, with its history, so the dead state survives a reload and a visit from another client. The screen shows "Start a new shell" (or Enter), also when the shell could not start; that, or the next message, opens a fresh shell below the old output. Next to it, a shell picker changes the model of the thread, so a thread whose shell was removed can go on with another one. An open with another folder, env or shell, and the first open after a server restart, also start the new shell below the old output. A dim `— new shell —` line in the history (`NEW_SHELL_MARKER` in `Manager.ts`) separates them, because a client that attaches again redraws from the history. Only a shell that starts adds it, so a failed start adds no line. Archive deletes the history, like for every thread. Settle closes only the idle drawer terminals: the main terminal stays open (`keepTerminalId` of `TerminalManager.closeIdle`), because the shell is the content of the thread.
- **Drawer to thread:** the Move to a terminal thread button of a drawer (`useForkMoveTerminalToThread`, chat threads and terminal threads, not drafts) calls `terminal.moveToThread` with a thread id that the client reserves. `TerminalThreadMove` creates the terminal thread in the project and folder of the source thread, with the shell of the session as model (`terminal` for the default shell) and a title from its command, program or shell (`terminalThreadTitle`). Then `TerminalManager.forkMoveSession` moves the running process, its output and its events to `term-1` of the new thread, with the launch context of the thread screen, so its open attaches instead of restarting. The old key gets a `closed` event, and every client with write access drops that tab. A drawer shell has no shell integration, so the thread reports Done or Failed only when the shell exits.
- **Guards:** a webhook task cannot run in a terminal thread: the save refuses the terminal model, and each run refuses a resolved terminal model or a bound terminal thread (`refuseTerminalThread` of `sendToThread`). And `schedule_task` with the terminal model must pass `bindToCurrentThread:false` unless the caller is a terminal thread. `delegate_task` refuses the terminal instance, because a markdown brief would run in a shell. The orchestrator refuses a model selection that turns an agent thread into a terminal thread or back (`changesThreadKind`), in selection commands and in messages, so `t3_thread_configure`, schedules and Settings edits of a bound task fail too.
- **Limits:** a terminal thread has no timeline, so the messages that a schedule sent show only in the terminal. A server restart ends the programs; a multiplexer would keep them, and find in thread would need its own search. With bash older than 4.4 (macOS `/bin/bash`), the first message of each session waits 10 seconds for a prompt mark that never comes. A run ends after 10 minutes (`TERMINAL_RUN_TIMEOUT_MS`), also a message that replaces the shell (`exec zsh`), because the new shell prints no end mark. Terminals other than the main terminal of a terminal thread have no shell integration, and neither has PowerShell: a message to it is only typed, because bracketed paste in PSReadLine under ConPTY is not verified. Windows support has unit tests with a win32 host stub and no live check yet. bash reads the command line from its history, so a command that the history skips (`HISTCONTROL=ignorespace` or `ignoredups`) reports no command line. The server finds its shells once at start. Git status and the open diff refresh when a program in the main terminal ends, not while it runs. Revisit when these block daily use.

### Terminal key mappings

Keys that every terminal sends as fixed bytes.

- **Setting:** client setting `terminalKeyMappings` (empty by default). Settings > Terminal > Terminal key mappings, with a preset for zsh editor keys on macOS.
- **Works on:** web, desktop.
- An entry has `key` (for example `cmd+z`), `send` (escapes `\e`, `\xNN`, `\uNNNN`, `\r`, `\n`, `\t`). A mapped key replaces the encoding of the key, except copy while text is selected. App shortcuts, zoom and the built-in Cmd+arrow, Cmd+Backspace, Cmd+K and Ctrl+L keys act first, so a mapping on one of them never fires.
- **Limits:** the mobile app ignores the mappings. Revisit when a mobile keyboard needs them.

### Terminal history

Each terminal keeps up to 5,000 lines and 8 MiB of output on the server.

- **Setting:** server settings `terminalHistoryLines` (5000) and `terminalHistoryMegabytes` (8). Settings > Terminal > Terminal history.
- **Works on:** server.
- **Limits:** a change applies after a server restart. Revisit if live terminals must resize their history.

### Terminal settings

App shortcuts take priority in a focused terminal, and the app asks before a terminal closes.

- **Setting:** client settings `terminalAppShortcutsFirst` (off by default) and `confirmTerminalClose` (on by default). Settings > Terminal > "App shortcuts in terminal" and "Terminal close confirmation".
- **Works on:** web, desktop.
- **Limits:** the mobile app does not ask before a terminal closes. Revisit if a mobile user closes a running terminal by mistake.

## Web app and look

### Installed web app

Each server web app, such as `https://t3-vps.yarden-zamir.com`, installs as an app, with an offline page, notifications and an app badge.

- **Setting:** client setting `installedAppEnabled` (on by default). Settings > General > Notifications > "Installed app", in each browser and for each server.
- **Works on:** web browsers. Desktop Chrome and Edge show "Install" in the address bar. Android Chrome shows "Install app" in its menu. On iPhone, use Share > Add to Home Screen.
- The app has shortcuts for a new thread, pull requests and settings. On Android, long-press the app icon.
- The offline page shows when the device is offline, or when the tunnel answers but the server is down.
- Android and iPhone show thread and review guide notifications. Turn on notifications in Settings > General first.
- The app icon shows the same count as the browser tab icon.
- The service worker caches only the offline page. A new build thus shows at once, and Cloudflare Access can ask for a new sign-in.

### In-app notification options

In-app notifications of threads can show for a chosen time, skip finished threads, stay open when a thread needs you, and close when you open their thread.

- **Setting:** client settings `inAppNotificationSeconds` (5 by default), `inAppNotificationCompletions` (on by default), `inAppNotificationAttentionStays` and `inAppNotificationClosesOnOpen` (both off by default). Settings > General > Notifications, below "In-app notifications".
- **Works on:** web, desktop. The options apply to agent threads and terminal threads.
- "Keep notifications that need you" covers input, approval, a usage limit and a failure. Finished threads keep the chosen time.
- **Limits:** the mobile app has no in-app notifications. Revisit if it gets them.

### Web Push

A phone gets thread notifications while the installed app is closed, from each server that the page connects to.

- **Setting:** client setting `webPushEnabled` (on by default). Settings > General > Notifications > "Web Push". It needs the installed app setting and system notifications. "Send a test" sends a test push.
- Failed registration retries automatically with increasing delays, then stops. The failure appears separately from the enabled preference. Reconnect or reload to try again after retries stop.
- **Works on:** web browsers, mainly the installed web app on a phone. The native mobile app has its own push, see [Android APK](#android-apk).
- A server pushes when a thread starts to wait for approval or input, or when a running thread completes or fails. A compaction that T3 Code starts on its own pushes only when it fails, like the page notification. A terminal thread also pushes for a new attention on its main terminal: Input needed, Program done or Program failed, like the page notification.
- A push replaces the page notification of the same thread. No push shows when the window in front already shows that thread.

### Theme style

Published themes can set shape, fonts, a canvas pattern and user CSS, in the theme JSON fields `radius`, `borderWidth`, `shadow`, `fonts`, `canvasPattern`, `canvasPatternColor` and `css`.

- **Setting:** none. Select a published theme in Settings > Appearance. See [Appearance](../user/appearance.md) for published themes.
- **Works on:** web, desktop, and mobile with [Themes on mobile](#themes-on-mobile).
- **Limits:** see [Themes on mobile](#themes-on-mobile) for the fields that mobile skips.

### Themes on mobile

The mobile app uses the themes that its servers publish.

- **Setting:** server setting `mobilePublishedThemes` (off by default). Settings > Appearance > Mobile app, or Fork in the mobile Settings. kitshn syncs it.
- **Works on:** mobile.
- Appearance in the mobile app shows the published themes under "From your servers". A theme with colors for one appearance offers that appearance only.
- The app takes the server setting `defaultTheme` once for each theme id, for the appearances that the theme has colors for. The color scheme mode stays as set on the phone.
- The app stores the last published themes, so the theme shows before a server connects.
- Shape: `radius` sets every radius token except round elements, `borderWidth` sets every border, and `shadow` goes on grouped lists, the composer and the Android buttons. `apps/mobile/fork-theme.css` holds the tokens, and class rules make the fixed pixel radii of upstream (`rounded-[20px]`) follow them.
- A `shadow` that the app cannot read is dropped.
- Fonts: the app bundles Bricolage Grotesque and JetBrains Mono. A theme font with one of these names replaces the stock font.
- Canvas: `dots` and `grid` show behind the thread feed.
- **Limits:**
  - A theme that lists only `canvas` and `accent` gets only those two colors, because the palette generator lives in `apps/web/src/themePalette.ts`. Revisit when such a theme is in use on a phone, or when upstream moves the generator to `packages/shared`.
  - A pixel radius class that upstream adds later keeps its size under a theme until `fork-theme.css` gets a rule for it.
  - Other fonts keep the stock font. The composer takes the `sans` font, and the terminal and diff views keep the platform monospace font.
  - `noise`, user CSS and icon packs have no mobile form. The text of the Android buttons keeps the system font.
  - Setting the same `defaultTheme` again does not apply it again on the phone, because `defaultThemeSetAt` is local to each machine.

### Fork settings on mobile

Fork in the mobile Settings holds the fork settings that apply to the mobile app: published themes, the camera in the composer, thread link chips, message links and what New thread opens. Threads also shows the camera, thread link chips, message links and what New thread opens. A change writes the setting to each selected environment.

- **Works on:** mobile.
- **Limits:** a change on the phone is the own value of each server, not the shared value on kitshn. Set the shared value with "All environments" in T3 Settings.

### Theme icon packs

A published theme can replace app icons with its own SVGs, in the theme JSON field `icons`. Without it, every icon stays stock.

- **Works on:** web, desktop.
- The slots are the sidebar tab icons (`tab.<id>`), the thread statuses (`status.<status>`), the tab bar buttons (`tabs.more`, `tabs.new`, `tabs.edit`) and the sidebar header (`sidebar.search`, `sidebar.filter`, `sidebar.add-project`, `sidebar.new-thread`). `apps/web/src/components/AppIcon.tsx` lists them.
- Each icon carries `data-app-icon="<slot>"`. The sidebar tabs carry `data-sidebar-tab` (`default` or `custom`), `data-selected`, `data-status`, `data-attention` and `data-drop-target` for theme CSS.
- **Limits:** the app strips scripts, styles, links and remote content from each SVG, and an icon is at most 4096 characters. The mobile app shows stock icons. Revisit after sidebar tabs reach mobile.

### Local server groups

The Local servers list of a new browser tab also shows servers that no T3 terminal started. They are in groups: this worktree, other folders of this project, and all others.

The list fills in progressively. Every server shows as soon as the server knows its folder. A server that gets a check shows "checking…" until its first check ends, then "no page found" or no note. Rows keep the order in which they first appeared.

A row shows "from <thread>" when the server knows for certain which other thread started it. A click on the chip opens that thread. For a server of a T3 terminal, that is the thread of the terminal. For a server that an agent started, the server looks up the process tree for the session id of a Claude Code or Codex process that T3 runs.

- **Setting:** server setting `previewLocalServerGroups` (off by default). Settings > Browser > Browsing > "All local servers in the browser".
- **Works on:** web, desktop. The mobile app has no Local servers list.
- **Limits:**
  - A request to an unknown app can crash it (upstream pingdotgg/t3code#18377). The server checks only servers inside a project. Others show the port and the process name with "not checked". A click opens them anyway.
  - An app such as Maya or Blender that starts from a project folder still gets a check. The setting is the opt-in.
  - On Windows, every server outside the T3 terminals is in the last group. Revisit if Windows gets a cheap way to read the working folder of a process.
  - A port with two owner processes, such as one on IPv4 and one on IPv6, gets no check. A project at the home folder or above it counts as no project.
  - A new project or thread worktree counts after up to 30 seconds. A worktree that no thread uses counts after up to 5 minutes.
  - A server whose shell exited has no "from" link on macOS, because macOS hides the environment of other processes. On Linux the server also reads `CLAUDE_CODE_SESSION_ID` and `CODEX_THREAD_ID` from the process environment. Windows has no "from" link for agent servers.

### Lightning icon

The fork desktop app, its notifications and the bundled web page use the Tick3d lightning icon instead of the nightly icon. To change it, see [App icon](operations.md#app-icon).

- **Works on:** desktop, web, Android APK. The APK uses the layers `assets/fork/tick3d-android-{foreground,background,monochrome}.svg`, as PNG files in `apps/mobile/assets/fork/`.
- **Limits:** iOS builds keep the nightly icon.

### Back and forward

Back and forward buttons sit right of the sidebar toggle, like in VS Code. A button is dimmed when it has nothing to go to.

- **Setting:** client settings `backForwardButtons` and `rememberBackForwardHistory` (both off by default). Settings > Appearance > Interface > "Back and forward buttons", and Settings > General > Display > "Remember back and forward history".
- **Works on:** web, desktop. The mobile app uses its own native navigation.
- The buttons, `mod+[` and `mod+]`, the command palette ("Go back", "Go forward") and the browser buttons all move in one history, the browser history of the window. The keys and the palette work also with the buttons hidden.
- With `rememberBackForwardHistory`, back and forward skip threads and drafts that no longer exist. The desktop app also stores the back history of its window. After a restart, back goes to the views of the last run. A browser tab keeps its own history over a reload or a browser restart.
- The desktop preview browser has its own back and forward buttons for the page that it shows.
- **Limits:**
  - The desktop app keeps at most 50 entries, and no forward entries: the start of the app is a new navigation.
  - In a browser without the Navigation API, such as an older Safari or Firefox, both buttons stay enabled, and a missing thread goes to a new thread instead of a skip.
  - Mouse buttons 4 and 5 and trackpad swipes do not go back or forward in the desktop app.

### App context menu

Right-click menus use the app's own menu, also in the desktop app, in place of the system menu. The menu follows the app theme and shows icons, group names, check marks and submenus. Arrow keys move over the items, letters jump to an item, and Escape closes the menu.

- **Setting:** none. Menus always use the app menu. A menu that opens before the app is ready, or on an error screen, uses a plain web menu.
- Controls and menu items that a keybinding can run show the key. Right-click one, or press Shift+F10 or the context menu key on it, for **Keybindings…**. In a menu it opens nested, so the menu stays open, and Escape closes only the nested menu. A menu item without a key shows a faint dash. Command palette and cheat sheet rows have the same menu.
- Messages, code blocks, citation chips, pins and the pins button, queued messages, attachments, check rows, composer banners, the update pill, settings rows, environment rows, connection status dots, the plan card, the context window meter, the thread usage section and the Snoozed and Settled headers have a menu of their own buttons, the items of their "…" menu and copy actions. Selected text, text fields and links keep their own menus. On mobile, a long press on a message bubble, a check row, a usage limit row or the Snoozed and Settled headers opens the same kind of menu.
- **Works on:** web, desktop. The mobile app keeps its native menus.
- Text fields and pages in the browser panel keep the system menu, with spelling suggestions and Cut, Copy and Paste.
- **Limits:**
  - The menu stays inside the app window.
  - Disabled items stay reachable with the arrow keys, as in other app menus.
  - The menu takes focus, so a right-click inside an open picker, such as the branch picker, closes the picker.

## Command line and MCP

### `t3 tool`

`t3 tool list`, `t3 tool describe <name>` and `t3 tool call <name> --input '<json>'` run T3 MCP tools from the command line. In a checkout, use `node apps/server/src/bin.ts` instead of `t3`.

- **Works on:** server.
- In an agent's shell, the command uses the credential of the agent's thread, so the limits of that thread apply. `t3 machine exec` uses the same credential; see [Commands on other machines](#commands-on-other-machines).
- Elsewhere, also in a T3 terminal, it calls the running server of its T3 home with a short full-access session.
- To call a dev server from an agent shell, unset `T3_ACP_MCP_ENDPOINT` and `T3_ACP_MCP_AUTHORIZATION`. The CLI refuses a `--base-dir` or `T3CODE_HOME` that does not match the shell's thread credential.
- **Limits:** the shells of Cursor and OpenCode 2 agents get no thread credential, so they use the full-access session. That session runs nothing on another machine and forwards no tool there: `machine_exec`, `t3 machine exec`, and tools or delegation with the `environmentId` of another machine refuse it. Use a thread. The `machines_*` tools ask the kitshn daemon of this machine.

### Open workspace with a checkout

The desktop open-workspace request accepts a checkout.

- **Works on:** desktop.
