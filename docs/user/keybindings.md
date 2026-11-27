# Keybindings

Customize keyboard shortcuts in **Settings → Keybindings** on web and desktop. That page lists every available command ID and default binding.

Search on that page matches action names, command IDs, conditions and shortcuts, such as
`mod+k` or `⌘K`. To see all bindings of one action, choose **Show bindings for this action**
in the menu of its row.

A button, menu item or command palette row that a shortcut can also run shows its shortcut, in
its tooltip or next to it. A menu item without a shortcut shows a faint dash. Right-click such a
control, or press Shift+F10 or the context menu key on it, and choose **Keybindings…**. A menu
stays open behind it. This also works on an item that is disabled now, and on rows of the
keyboard cheat sheet. The page opens with that action filtered and a new binding for it ready to
record.

To free a default shortcut, choose **Unassign** from its row menu (**Reset to default** restores it).

> Note: `mod` means `Cmd` on macOS and `Ctrl` on Windows and Linux.

## Common composer shortcuts

| Action                      | Default           | Notes                                                              |
| --------------------------- | ----------------- | ------------------------------------------------------------------ |
| Start / finish dictation    | `mod+shift+d`     | `Esc` discards. See [Voice input](./voice-input.md).               |
| Opposite queue/steer action | `mod+Enter`       | Uses the non-default follow-up behavior while a turn runs.         |
| Start thread in background  | `mod+Alt+Enter`   | Also `mod+Enter` in a new thread; opens a fresh draft immediately. |
| Send first queued message   | `mod+Shift+Enter` | Steers if running, or starts a turn if stopped.                    |
| Pick model                  | `mod+shift+m`     | `mod+shift+up/down` switches providers inside the picker.          |
| Pick host / environment     | `mod+shift+h`     | Bind **Composer: Cycle Host** to step without a menu.              |
| Pick effort                 | `mod+shift+e`     | Bind **Increase/Decrease Effort** to step without a menu.          |
| Pick permissions            | `mod+shift+a`     |                                                                    |
| Pick workspace mode         | `mod+shift+x`     | `mod+shift+l` reuses the previous worktree directly.               |
| Pick Git branch             | `mod+shift+g`     |                                                                    |

Configure whether `Enter` sends or requires `mod+Enter` in **Settings → Chat → Send shortcut** (`Shift+Enter` always inserts a newline).

In the model picker, use `Left`/`Shift+Tab` to move to the provider list, `Right` to return to search or move into effort levels, and `Up`/`Down`/`Enter` to select.

## Copy pull request and thread references

- `mod+shift+c`: Copies the open PR's URL (or copies a thread chip link when no PR is open).
- `mod+shift+k`: Copies the open PR's `#number`.

Remap under **Copy Link or Thread** and **Copy Number** in **Settings → Keybindings**.

## Find

- **Current thread** (`chat.find`, default `mod+f` outside terminals/previews): Searches all messages and plans in the thread (requires an up-to-date server). Use `Enter` / `Shift+Enter` to step through matches and `Esc` to close.
- **Diffs** (`mod+f` inside a diff or PR Code tab): Searches all loaded files in the diff, unfolding matching files. Not configurable. Very large uncommitted diffs only search files loaded so far.
- **Browser page** (`preview.find`, default `mod+f` in a desktop browser tab): Searches the open page. If a page handles `mod+f` itself, use the browser's **⋮** menu. Not supported in web clients or streamed browser tabs.

## Focus levels

Turn on **Settings → Keybindings → Keyboard focus levels** to move focus between the composer,
the timeline, the right panel and the sidebar with the keyboard. It is off by default.

- Escape moves one level up: from the composer to the timeline, then to the sidebar.
  An open menu, dialog, find bar or sidebar selection takes Escape first. On the Pull Requests
  page, Escape still goes back.
- In the desktop app, `mod+alt+left` and `mod+alt+right` move between the sidebar, the chat and
  the right panel.
- Outside a text field, typing a letter in the chat goes to the composer. In the sidebar, digits
  switch tabs, and other letters do nothing.
- A key that moves focus outlines the area it moves to. Turn this off in
  **Settings → Keybindings → Focus highlight**.

In the sidebar, Up and Down move between threads, and Enter opens one and focuses its timeline.
Up from the first thread reaches the sidebar tabs. Left and Right, or `1` to `9`, switch tabs.
`mod+f` focuses sidebar search, and `mod+alt+f` does so from anywhere. `mod+shift+f` opens the
sidebar Filter menu. `mod+alt+1` to `mod+alt+4` focus the sidebar, the timeline, the composer and
the right panel. In the timeline, `p` pins the focused message and `l` copies its link.

In the timeline, Up and Down move a cursor between messages. Right goes one level deeper:
blocks such as paragraphs and list items, then sentences or code lines. A sentence also
splits after a colon that a space follows. Left goes back up.
Up and Down stay at the depth that Right and Left chose. At the end of a list they continue
with the next item one level up, then go back down: 1.1, 1.2, 1.3, 2, 2.1.
After you select text or click in the timeline with the mouse, the next arrow key starts
from there, and Enter cites exactly the selected text.
Shift with Up or Down extends the selection within one list. Enter cites the selection with a note, and
`alt+enter` cites it without one. Only assistant text can be cited. `mod+down` jumps to the
latest message. PageUp and PageDown still scroll.
Inside a message, Up and Down also stop on each link, section header and button, after the text
that holds it. Enter clicks it. Right opens a closed section, and Left closes an open one. Escape
goes back to the text, and Escape on a link that has focus returns to the cursor.

These keys work with the setting off too:

- `mod+.` stops the running turn, outside terminals.
- Thread keys act on the selected sidebar thread, or on the open thread elsewhere.
  `mod+backspace` archives (sidebar and timeline only), `mod+alt+s` snoozes or wakes,
  `mod+alt+r` renames, and `mod+shift+u` marks unread.
- While an approval waits and no text field or terminal has focus, `mod+y` approves,
  `mod+shift+y` always allows for the session, and `mod+alt+y` declines.
- In the desktop app, `ctrl+tab` and `ctrl+shift+tab` switch right panel tabs.
- In a browser, `mod+,` opens settings.
- `mod+/` lists every shortcut, with the keys for the area you are in first. It also works with
  the setting off.

## Hardware keyboards on iPad and Android

- **iPad**: `Cmd+1`–`Cmd+9` open the first nine visible threads; `Cmd+K` opens the command palette (prefix with `>` for actions only); `Cmd+Shift+H` cycles host on a new thread. `Return` sends (`Shift+Return` for newline; `Cmd+Return` for opposite follow-up). Change Return behavior in **Settings → Keyboard**.
- **Android**: Same composer Return behavior using `Ctrl` instead of `Cmd`. The on-screen keyboard's Return always inserts a newline.

## Edit the configuration file

Keybindings are stored on the environment's machine at `~/.t3/userdata/keybindings.json` as a JSON array:

```json
[
  { "key": "mod+g", "command": "terminal.toggle" },
  { "key": "mod+shift+g", "command": "terminal.new", "when": "terminalFocus" }
]
```

New default bindings are added on startup without overwriting customized commands. Invalid rules are ignored; an unparseable file falls back to defaults.

### Rule shape and key syntax

Each rule requires `key` and `command`, plus an optional `when` condition. Project scripts use `script.{id}.run` (e.g. `script.test.run`).

Join modifiers and keys with `+` (`mod`, `cmd`/`meta`, `ctrl`/`control`, `alt`/`option`, `shift`).

### When conditions

Available context keys: `terminalFocus`, `terminalOpen`, `previewFocus`, `previewOpen`, `rightPanelOpen`, `modelPickerOpen`, `usagePageOpen`, `composerFocus`, `draftThreadRoute`, `turnRunning`, `composerEmpty`, `editableFocus`, `timelineFocus`, `sidebarFocus`, `rightPanelFocus`, `approvalPending`, `compactBeforeSendShown`, `isWeb`, `isDesktop`. Unknown keys evaluate to `false`. `compactBeforeSendShown` is true while the composer shows the **Compact** or **Keep** toggle.

Combine with `!`, `&&`, `||`, and parentheses:

```json
{ "key": "mod+j", "command": "terminal.toggle", "when": "terminalOpen && !terminalFocus" }
```

> Tip: `mod+1`–`mod+9` default to `isDesktop` so they don't hijack browser tabs. Remove that condition in Settings if you want thread jumps on web.

## Precedence

The last matching rule in `keybindings.json` wins, even across different commands. Place more specific rules after general ones.

## Commands with special behavior

- `thread.stop` (`mod+.`, outside terminals): Interrupts the running turn.
- `thread.regenerateTitle`: Regenerates the focused thread's title (unbound by default).
- `thread.undo` (`mod+z`): Undoes recent sidebar actions (unpin, settle, snooze, archive, discard draft) within 5 seconds, including consecutive actions of the same kind.
- `navigation.back` (`mod+[`) / `navigation.forward` (`mod+]`): Moves through visited pages.
- `chat.new` / `chat.newLocal` / `chat.newWithoutProject` (`mod+alt+n`): Start new threads using your [new-thread defaults](./thread-sidebar.md#start-a-thread) or [without a project](./thread-sidebar.md#start-without-a-project).
- `chat.newTerminal` (`mod+alt+t`) / `chat.newTerminalLocal` (`mod+alt+shift+n`): The same two commands for a [terminal thread](../fork/terminal-threads.md). The first may ask for a project; the second starts in the focused project. They do nothing until a server turns on Terminal threads.

## Reserved and platform shortcuts

- `mod+w` (desktop) closes the focused terminal, the selected range of right-panel tabs, or the active tab if there is no range. On web, browsers intercept `mod+w`. Rebind `rightPanel.close` and `terminal.close` to a shortcut such as `alt+w`.
- `mod+shift+t`: Reopens the last closed panel tab (files, diffs, PRs, browsers, devices) in order. Browser tabs reopen as fresh sessions. Rebind on web if your browser intercepts it.
- Keep `!terminalFocus` when remapping shortcuts that shouldn't intercept terminal input. `sidebar.toggle` ignores `Ctrl+B` inside terminals so `tmux` keeps its prefix (`Cmd+B` still works on macOS).

## Desktop quit shortcut

`Cmd+Q` (macOS) or `Ctrl+Q` (Windows/Linux) defaults to **Hold** mode: hold for 1.2 seconds or press twice within 500 ms. Change this in **Settings → General → Confirmations → Quit shortcut** to **Direct** or **Double press**. Quitting from the application menu always exits immediately.
