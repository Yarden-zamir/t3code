# Terminal history

Each terminal keeps up to 5,000 lines and 8 MiB of scrollback on its environment
server. Settings > Terminal > Terminal history changes both limits, after a server
restart. T3 Code removes the oldest output when either limit is reached. A long
line can be shortened at the start. New terminal output is not truncated.

These limits apply when you reconnect and when T3 Code restores saved terminal
history. A client can show less scrollback than the server keeps.

When a terminal gets wider or narrower, a shell prompt that wraps onto more than one line
can draw over the last line of output. This happens when a draft becomes a terminal thread and
when the right panel opens or closes. The server history still holds the line. A shorter
prompt avoids it.

On web and desktop, use Shift+PageUp and Shift+PageDown to read scrollback
without leaving terminal input. Ctrl+Shift+Home and Ctrl+Shift+End jump to the
start and latest output; use Cmd instead of Ctrl on macOS. Full-screen terminal
programs keep these navigation keys.

To copy all retained output, choose Select all in the terminal's context menu,
then copy. Cmd+A on macOS and Ctrl+Shift+A elsewhere select the same output.
Ctrl+A still moves to the beginning of shell input on Windows and Linux.
Jump to latest in the context menu returns to the current output.

## fish

T3 Code starts fish with `no-query-term`, avoiding startup waits for terminal
replies. This disables optional fish features that depend on those replies.
T3 Code's exported `fish_features` also hides any universal flags you set with
`set -U fish_features`.

To preserve those flags or enable queries with `query-term`, include them in
`fish_features` in the environment that launches T3 Code. A shell export applies
when you launch T3 Code from that shell; it does not configure a desktop app
launched from the Dock or Finder. Enabling queries can restore the startup wait.

# Terminal threads

A terminal thread is a thread whose screen is a terminal. Use it for an editor, a
CLI agent or a dev server that you want next to your other threads.

Turn on Settings > Terminal > Terminal threads on the server. Then start one like a normal
thread: the terminal button next to New thread in the sidebar (not in the legacy sidebar), `mod+alt+t`
(`chat.newTerminal`), or New terminal thread in the command palette. These follow the
same rules as the New thread button, including the project chooser and Shift. The command
`chat.newTerminalLocal` (`mod+alt+shift+n`) starts in the focused project at once.

A new terminal starts as a new thread in Terminal mode: the composer box holds a live
shell, and the Terminal button in the composer is on. The footer shows the folder of the shell. Pick the shell (zsh, bash and
so on, or a custom shell) in place of the model. The first command that ends, or that runs for a second (an
editor, a dev server), makes it a terminal thread with the same shell, named after the
command, or after the shell when the shell does not report its commands. The enlarge button next to the hint makes it a terminal thread at once, named after its first command. To skip the draft for New terminal thread in the current project (Shift, `chat.newTerminalLocal` or its command palette entry), turn on Settings > Terminal > Open terminal in current project as a thread. Until then:

- The Terminal button switches back to an agent, and closes the shell.
- A prompt that you typed before switching to Terminal stays in the draft. When the terminal
  becomes a thread, the prompt waits in the project's next new thread.
- Leaving the new thread discards the shell, like an empty new thread.
- The workspace and branch controls under the box work like for a new thread. The shell runs
  in the project folder or in the chosen worktree, and restarts when you change it.
- With New worktree, click Create worktree first. The worktree is set up as for a new
  thread: it fetches origin first when that option is on, and runs the project's setup
  script. The shell starts in the worktree when the setup script starts. A setup script
  that is not async must end first. If that setup script fails, the worktree is removed.
  An async setup script that fails keeps the worktree, and the setup progress shows the failure.
- While the worktree is set up, Cancel stops it, and Work locally runs the shell in the
  project folder instead.

The screen is the header of a normal thread above the terminal. `mod+j` opens the drawer
for more terminals of the thread. The Move to a terminal thread button of the drawer, in a
chat thread or a terminal thread, makes its terminal a new terminal thread. The shell goes on
running there with its output. That shell has no shell integration, so the thread shows
Done or Failed only when the shell exits, and a message to it is only typed. On Linux and Windows, Ctrl+W, Ctrl+D, Ctrl+N and Ctrl+J
in the main terminal go to the shell, so open the drawer from the header there.

The right panel (`mod+alt+b`) and the thread details (`mod+shift+b`; on Linux and Windows
with the focus outside the terminal) work like in a chat thread: changes and diff, files, pull requests, browser,
devices, machines, and the git actions of the branch. A link that you click in a terminal
opens in the browser of the panel when it is available, like in a chat thread. A terminal
thread has no prompt, so the panel has no "send to chat", no "Add to chat" and no comments on a
diff or a file, and the thread details have no project scripts.

## Messages

A message to a terminal thread, from a scheduled task, an agent or the MCP tools, is typed
into its terminal. The terminal shows exactly what the message said.

- At a prompt, the message is pasted as one command line, then Enter. The run ends with the
  exit code of its last command and the output of all its commands. The message runs in the
  shell itself, so `cd` and `export` stay for the next message.
- A message that is not a complete command, for example one with an open quote, fails, and
  Ctrl+C cancels it in the shell.
- A run ends after 10 minutes. If the command still runs, the reply says so, and the command
  continues in the terminal.
- A message that arrives while a program that you started runs, for example an editor, waits
  for the prompt. If the program still runs after 10 minutes, the run fails and the message is
  not typed.
- A message that you send while a run waits or runs is typed into the program, for example to
  answer a prompt.
- The reply needs the shell integration of the thread. It works with bash 4.4 or newer
  (also Git Bash on Windows) and zsh. With another shell (fish, PowerShell, cmd or a custom
  shell), or after `exec` replaced the shell, the message is only typed, and the reply says
  that no result is captured.
- A message outside full access mode fails.
- A scheduled task with a webhook never types into a terminal thread. Its run fails, also
  when the task or the project default model points to a terminal thread.
- An agent cannot delegate a task to a terminal thread. A thread cannot switch between an agent
  and a terminal; start a new thread instead.

## Sidebar

The sidebar shows the state of a terminal thread until you visit it:

- A bell or an app notification from a program shows Input, also while a program runs and
  after it ends.
- A program that ends shows Done, or Failed when its exit code is not zero.
- A program that runs in the shell shows Working. A background job does not.
- A shell that cannot start shows Failed.

With Web Push on, a phone also gets a notification for a bell (Input needed) and for a program
that ends (Program done or Program failed).

## Shell exit

When the shell of a terminal thread exits or is killed, the thread keeps its output and
shows that the shell exited, also after a reload. Start a new shell, or press Enter, to
continue; a message to the thread also starts one. To use another shell, choose it next to
Start a new shell first. The new shell starts below the output of the one that ended, under a
"new shell" line. Archiving the thread deletes that
output. While a program runs, Archive waits until you stop it. Delete ends the program, and its
confirm says so. Settling the thread keeps its shell open. A server restart ends the programs in the
terminal, and the output stays.

## Settings

Settings > Terminal holds the settings of every terminal (font, zoom limits, key mappings,
app shortcuts, close confirmation and history) and of terminal threads. The terminal font
follows the monospace font of Appearance until you choose a separate font.

Shells lists the shells that the server found, and your custom shells. A custom shell is any
program with arguments, for example `uv` with `run python`. A program name without a folder
runs from the PATH of the terminal. Settings shows an error under a custom shell whose program the
server cannot find, and the shell pickers mark it as not found. A shell that cannot start shows its error in the terminal;
T3 Code never starts another shell in its place. When you remove or rename a custom shell,
Settings names the threads that use it. Such a thread keeps its output: choose another shell
next to Start a new shell.

## Zoom and keys

On macOS, Cmd+=, Cmd+- and Cmd+0 change the font size of every terminal, within the zoom limits
in Settings > Terminal. Linux and Windows have no zoom keys, because Ctrl+- is undo in shells. Terminal key mappings (Settings > Terminal) send fixed bytes for a key, for
example Cmd+Z as the Kitty sequence that a shell binds.
