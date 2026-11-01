# Yarden-zamir fork of T3 Code

This is a personal fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code). The upstream README starts below the line. Each fork behavior is a setting that starts on when it only adds something, and off when it changes behavior, installs or restarts anything, changes access or needs setup. Settings > Fork shows every fork setting, in the groups of this list. Each line links to its section in [docs/fork/features.md](docs/fork/features.md). Maintainer procedures: [docs/fork/operations.md](docs/fork/operations.md).

## Fork features

**Remote access**

- **[Tunnel pairing](docs/fork/features.md#tunnel-pairing):** a desktop server on loopback makes pairing links with its tunnel URL.
- **[Guest links over the tunnel](docs/fork/features.md#guest-links-over-the-tunnel):** guest links work through the Cloudflare tunnel without T3 Connect.
- **[Quiet reconnect after restart](docs/fork/features.md#quiet-reconnect-after-restart):** right after the app starts, the composer waits before it warns that a server is reconnecting (off by default).
- **[Sync timings on mobile](docs/fork/features.md#sync-timings-on-mobile):** Settings > Diagnostics shows how long each step of a chat sync takes, per environment.

**kitshn** (each line needs kitshn 2 on the machine, joined to kitshn)

- **[kitshn](docs/fork/features.md#kitshn):** the T3 server is a provider of kitshn. The owner shares access between machines on the kitshn map.
- **[Joined and manual environments](docs/fork/features.md#joined-and-manual-environments):** environment lists mark the machines that kitshn joined; the others are addresses that the user added.
- **[Cards](docs/fork/features.md#cards):** the T3 card shows the version and busy state, runs the T3 commands, and lists scheduled tasks and client sessions.
- **[Access from kitshn](docs/fork/features.md#access-from-kitshn):** kitshn grants decide who gets in, with saved grants for 24 hours while kitshn is out of reach.
- **[Environment name from kitshn](docs/fork/features.md#environment-name-from-kitshn):** an optional setting keeps environment names equal to kitshn map names.
- **[Work on other machines](docs/fork/features.md#work-on-other-machines):** a kitshn link makes the other machine a linked environment, where agents delegate tasks within their own limits.
- **[Commands on other machines](docs/fork/features.md#commands-on-other-machines):** `machine_exec` and `t3 machine exec` run commands on another machine with the exec grant.
- **[Settings and theme sync](docs/fork/features.md#settings-and-theme-sync):** the shared `t3.settings` on kitshn syncs settings, themes and keybindings to every machine.
- **[Settings > Machines](docs/fork/features.md#settings--machines):** how to join, and notices for the host handover and the desktop machine list.
- **[Device invites](docs/fork/features.md#device-invites):** a phone or the desktop app joins kitshn with its own device token from a one-time link.
- **[Machines panel](docs/fork/features.md#machines-panel):** the right panel of a thread lists the machines that the kitshn links reach.

**Updates and releases**

- **[Fork releases](docs/fork/features.md#fork-releases):** nightly desktop builds and Linux server archives from fork main.
- **[Daily release](docs/fork/operations.md#daily-release):** each morning a VPS task promotes the newest nightly to a release with highlighted notes.
- **[Android APK](docs/fork/features.md#android-apk):** a signed APK of fork main that installs next to the store app.
- **[Updates](docs/fork/features.md#updates):** one install command per OS, and one update policy for the desktop app and the server: the newest release, when idle, automatic or manual.
- **[Changelog](docs/fork/features.md#changelog):** a timeline of fork releases, upstream commits and Fork Sync runs.
- **[Local deploy](docs/fork/operations.md#deploy-a-local-build):** `scripts/fork-deploy-local.sh` deploys this checkout to a headless Linux server or to the Mac app.
- **[Central build caches](docs/fork/features.md#central-build-caches):** opt-in Vite caches and Android app outputs outside checkouts, with central-only pruning.
- **[Fork Sync](docs/fork/operations.md#fork-sync):** a workflow merges upstream main into fork main; a T3 task on the VPS starts it every 2 hours.
- **[Fork CI](docs/fork/operations.md#fork-ci):** runs on each push and pull request to main; branch protection requires "Fork CI result".
- **[Repair agent](docs/fork/operations.md#repair-agent):** a failed Fork Sync, Fork Release or Fork CI run on main calls an agent on the VPS, which repairs it with the scripts of the [fork-repair skill](.agents/skills/fork-repair/SKILL.md).

**Agents**

- **[Local usage hubs](docs/fork/features.md#local-usage-hubs):** full-access agents add a local CLIProxyAPI hub through the existing usage source settings.
- **[Recover interrupted agents](docs/fork/features.md#recover-interrupted-agents):** after a restart, each cut-off thread gets a "Recover and continue" message.
- **[Background work details](docs/fork/features.md#background-work-details):** background work notifications name their tasks and output files.
- **[Pull requests from origin](docs/fork/features.md#pull-requests-from-origin):** a fork checkout uses the pull requests of its fork, not of upstream.
- **[Pull request watch remark filter](docs/fork/features.md#pull-request-watch-remark-filter):** select which comments and reviews wake a watching agent.
- **[Agent session import limits](docs/fork/features.md#agent-session-import-limits):** the import window and the message limit for imported sessions.
- **[Publish to kitshn](docs/fork/features.md#publish-to-kitshn):** agents publish a file or folder of their workspace to kitshn through the kitshn daemon of their machine, with no kitshn token.
- **[kitshn provider](docs/fork/features.md#kitshn-provider):** the server shows itself as a card on the kitshn map, with commands such as Restart server, and its kitshn grants decide tunnel access to the app, shared threads and agent tools (off by default; no site yet).
- **[Scheduled task model](docs/fork/features.md#scheduled-task-model):** a scheduled task runs on any provider instance, or on the project default model.

**Threads**

- **[Worktree lifecycle](docs/fork/features.md#worktree-lifecycle):** a path template places new worktrees, idle worktrees lose ignored build outputs and dependencies, cleanup deletes branches that restore can rebuild, and resume recreates a missing checkout with project setup (each part off by default).
- **[Sidebar tabs](docs/fork/features.md#sidebar-tabs):** tabs above the sidebar list that hold threads, filled by drag or by rules. Mobile shows and edits them too.
- **[Waiting shelf](docs/fork/features.md#waiting-shelf):** threads that wait on other threads or background work get their own shelf under Working.
- **[Message pins](docs/fork/features.md#message-pins):** pin messages, and list the pins in thread details, in the sidebar and in the mobile Settings.
- **[Thread addressing](docs/fork/features.md#thread-addressing):** thread links in chat show as attached-thread chips, each message has a link of its own, and a thread address from Slack or GitHub opens the desktop app (off by default).
- **[New thread on mobile](docs/fork/features.md#new-thread-on-mobile):** New thread in the mobile app opens the project list, the last project, or no project.
- **[Camera in the mobile composer](docs/fork/features.md#camera-in-the-mobile-composer):** the plus button of the mobile composer can take a photo.
- **[Android assistant panel](docs/fork/features.md#android-assistant-panel):** the Android assistant button starts a thread with the screen.
- **[Read aloud on mobile](docs/fork/features.md#read-aloud-on-mobile):** hear a reply, or every new reply of a thread.

**Filters**

- **[Pull request filters](docs/fork/features.md#pull-request-filters):** filter the pull request page and the sidebar by repository owner, and show the active pull request filters as chips.

**Scripts and terminal**

- **[Global scripts](docs/fork/features.md#global-scripts):** scripts for every project, pinned buttons, desktop global shortcuts, floating previews and app overlays.
- **[App toggle shortcuts](docs/fork/features.md#app-toggle-shortcuts):** global keys that show and hide the desktop app.
- **[Keyboard focus levels](docs/fork/features.md#keyboard-focus-levels):** Escape moves focus between composer, timeline and sidebar; arrow keys move a cursor.
- **[Shortcuts in tooltips](docs/fork/features.md#shortcuts-in-tooltips):** control tooltips show the keys of the control as chips.
- **[Keyboard cheat sheet](docs/fork/features.md#keyboard-cheat-sheet):** `mod+/` lists every key that works, with the area you are in first.
- **[Find in settings](docs/fork/features.md#find-in-settings):** `mod+f` on a Settings page hides the rows that do not match (off by default).
- **[Terminal threads](docs/fork/features.md#terminal-threads):** a thread whose screen is a live terminal; schedules and agents can type into it.
- **[Terminal key mappings](docs/fork/features.md#terminal-key-mappings):** keys that a terminal sends as fixed bytes, with a preset for zsh editor keys.
- **[Terminal history](docs/fork/features.md#terminal-history):** how many lines and megabytes of output the server keeps for each terminal.
- **[Terminal settings](docs/fork/features.md#terminal-settings):** app shortcuts first in the terminal, and a confirmation before a terminal closes.

**Web app and look**

- **[Installed web app](docs/fork/features.md#installed-web-app):** each server web app installs as an app, with an offline page and an app badge.
- **[Web Push](docs/fork/features.md#web-push):** a phone gets thread notifications while the app is closed, with registration retries and a separate failure status.
- **[Thread card layouts](docs/fork/features.md#thread-card-layouts):** build the thread card from its elements, for desktop and for mobile.
- **[Local server groups](docs/fork/features.md#local-server-groups):** the browser Local servers list also shows servers that no T3 terminal started.
- **[Themes](docs/fork/features.md#themes):** the theme that you select carries its shape, fonts, canvas pattern, user CSS and icons, and the phone can follow it. The fork app uses the Tick3d lightning icon.
- **[Fork settings on mobile](docs/fork/features.md#fork-settings-on-mobile):** a Fork page in the mobile Settings.
- **[Back and forward](docs/fork/features.md#back-and-forward):** back and forward buttons in the title bar, and a desktop back history that stays after a restart.
- **[App context menu](docs/fork/features.md#app-context-menu):** right-click menus use the app's own menu with keyboard navigation, also in the desktop app.

**Command line and MCP**

- **[`t3 tool`](docs/fork/features.md#t3-tool):** `t3 tool list`, `describe` and `call` run T3 MCP tools from the command line.
- **[Open workspace with a checkout](docs/fork/features.md#open-workspace-with-a-checkout):** the desktop open-workspace request accepts a checkout.

## Fork fixes

- Themes: border width and radius flow through Tailwind tokens. Composer backdrop, outline and banners follow the theme radius. One theme shadow for nested surfaces and for split buttons.
- Menus: a fallback context menu takes keyboard focus when it opens, also from a focused terminal. Arrow keys move over its items and submenus, and Escape closes it.
- MCP: `schedule_task`, `t3_project_create` and `t3_project_update` read and write the project model, environment mode, auto-pull and actions through project settings.
- Desktop updates: the updater never downgrades, so a local build stays installed. The server recovers when quit-and-install does not quit.
- Worktree launch: a worktree request in Scratch runs in a thread folder. A worktree request outside a Git repository runs in the project folder and says so in the thread. A launch refuses a new worktree branch that already exists.
- Session checks: environment API requests from the web client skip the browser HTTP cache, so one stuck session check no longer holds back every later one.
- Queue: a resumed queued turn shows after the turns that ran before it. A paused queue shows while a turn runs. Resume waits for an edit and for a usage limit. Send now on a stopped thread also waits for a usage limit.
- Queue: a message held after a provider failure runs before a later agent message or wake, which waits behind it. Before, the later run started first and the held message stayed queued until the user came back.
- Delegated tasks: a later run that a child starts itself, after a background command or a nested delegated task, reports its result to the parent as a new task. A parent that cancelled the child gets no report.
- Terminal: powerline outlines and half circles (U+E0B1 to U+E0B7) fill their whole cell, so they meet the segments next to them.
- Device panel: a Homebrew Android SDK (`android-commandlinetools`) works without `ANDROID_HOME`, also when the `adb` on `PATH` has no emulator.

---

# T3 Code

T3 Code is an "agent harness control surface". It enables control of the agents on your machine with a best-in-class mobile app ([iOS](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824), [Android](https://play.google.com/store/apps/details?id=com.t3tools.t3code)), [web app](https://app.t3.codes) and [Electron-based desktop app](https://t3.codes).

Works with your subscriptions on Claude Code, Codex, Cursor, Grok Build, OpenCode, Google Antigravity, and fx. If they're set up on your computer, T3 Code can control them.

## "Wait, what are you selling me?"

Nothing. We built T3 Code because we wanted the best possible development experience with agents. We were inspired by existing solutions like the Codex desktop app, Conductor, Claude Desktop and Cursor Glass, but none met our bar.

We wanted something performant, remote-ready, and truly open. If we ever go the wrong direction, we want you to have everything you need to fork and build the editor that you want.

## Installation

> [!WARNING]
> T3 Code currently supports Codex, Claude, Cursor, Grok Build, OpenCode, Antigravity, and fx. Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
> - Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`
> - Antigravity: enable it in Settings, then use **Install Antigravity** and **Sign in with Google**. No CLI is required.
> - fx: install [fx](https://fx.sh) and run `fx login` on the machine running the T3 Code server ([setup guide](./docs/user/providers-fx.md))

### Command line

```bash
curl -fsSL https://t3.codes/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://t3.codes/install.ps1 | iex
```

Then run `t3` to start the server and open the local web app. `t3 service install` keeps it running in the background, `t3 update` moves to a newer release, and `t3 --help` has the full reference.

To try it once without installing, run `npx t3@latest` instead.

### Desktop app

Install the latest version of the desktop app from [GitHub Releases](https://github.com/pingdotgg/t3code/releases), or from your favorite package registry:

#### Windows (`winget`)

```bash
winget install T3Tools.T3Code
```

#### Windows (`scoop`)

```bash
scoop install extras/t3code
```

#### macOS (Homebrew)

```bash
brew install --cask t3-code
```

#### Debian, Ubuntu (`.deb`)

Download the `.deb` from [GitHub Releases](https://github.com/pingdotgg/t3code/releases), then:

```bash
sudo apt install ./T3-Code-*.deb
```

#### Arch Linux (AUR)

Stable:

```bash
yay -S t3code-bin
```

Nightly:

```bash
yay -S t3code-nightly-bin
```

The AUR packaging is maintained in this repository under [`packaging/aur`](./packaging/aur).

#### Nix (nixpkgs)

```bash
nix profile add github:NixOS/nixpkgs/nixos-unstable#t3code
```

The package is maintained in [nixpkgs](https://github.com/NixOS/nixpkgs/tree/nixos-unstable/pkgs/by-name/t3/t3code)
and includes the desktop app (`t3code-desktop`) and the `t3` command.
See [Nix installation](./docs/user/install.md#nix-nixpkgs) for NixOS configuration and updates.

## Some notes

We are very very early in this project. Expect bugs.

We are (mostly) not accepting contributions yet. Small fixes may be considered. Big features will not be.

## Documentation

Full docs live in [docs/](./docs). There's no docs site yet.

- [FAQ](./docs/user/faq.md)
- [Install and first run](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Project settings](./docs/user/project-settings.md)
- [Appearance preferences](./docs/user/appearance.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Connect Claude Code, Codex, ChatGPT and other agents over MCP](./docs/user/outside-agents.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)
- [Run T3 Code as a background service](./docs/user/background-service.md)

Building from source? Start at [docs/internals/overview.md](./docs/internals/overview.md).

## If you REALLY want to contribute still.... read this first

### Install `vp`

T3 Code uses Vite+ so you'll need to install the global `vp` command-line tool.

#### macOS / Linux

```bash
curl -fsSL https://vite.plus | bash
```

#### Windows

```bash
irm https://vite.plus/ps1 | iex
```

Checkout their getting started guide for more information: https://viteplus.dev/guide/

### Install dependencies

```bash
vp i
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before reporting a bug or opening a PR.

Have a feature request? Start an [Ideas discussion](https://github.com/pingdotgg/t3code/discussions/categories/ideas).

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
