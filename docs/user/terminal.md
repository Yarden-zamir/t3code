# Terminal history

Each terminal keeps up to 5,000 lines and 8 MiB of scrollback on its environment
server. Settings > Fork > Terminal history changes both limits, after a server
restart. T3 Code removes the oldest output when either limit is reached. A long
line can be shortened at the start. New terminal output is not truncated.

These limits apply when you reconnect and when T3 Code restores saved terminal
history. A client can show less scrollback than the server keeps.

On web and desktop, use Shift+PageUp and Shift+PageDown to read scrollback
without leaving terminal input. Ctrl+Shift+Home and Ctrl+Shift+End jump to the
start and latest output; use Cmd instead of Ctrl on macOS. Full-screen terminal
programs keep these navigation keys.

To copy all retained output, choose Select all in the terminal's context menu,
then copy. Cmd+A on macOS and Ctrl+Shift+A elsewhere select the same output.
Ctrl+A still moves to the beginning of shell input on Windows and Linux.
Jump to latest in the context menu returns to the current output.

# Terminal threads

A terminal thread is a thread whose screen is a terminal. Use it for an editor, a
CLI agent or a dev server that you want next to your other threads.

Turn on Settings > Fork > Terminal threads on the server. Then start one like a normal
thread: the terminal button next to New thread in the sidebar (not in the legacy sidebar), `mod+alt+t`
(`chat.newTerminal`), or New terminal thread in the command palette. These follow the
same rules as the New thread button, including the project chooser and Shift. The command
`chat.newTerminalLocal` (`mod+alt+shift+n`) starts in the focused project at once.

A new terminal starts as a new thread in Terminal mode: the composer box holds a live
shell, and the Terminal button in the composer is on. The footer shows the folder of the shell. Pick the shell (zsh, bash and
so on) in place of the model. The first command that ends, or that runs for a second (an
editor, a dev server), makes it a terminal thread with the same shell, named after the
command. The enlarge button next to the hint makes it a terminal thread at once. Until then:

- The Terminal button switches back to an agent, and closes the shell.
- The Terminal button is off while the prompt holds text or files, which a terminal thread
  would not keep.
- Leaving the new thread discards the shell, like an empty new thread.
- The shell runs in the project folder, or in the worktree that the new thread already uses.
  A new worktree is not available in Terminal mode.

The screen is the header of a normal thread above the terminal. `mod+j` opens the drawer
for more terminals of the thread. On Linux and Windows, Ctrl+W, Ctrl+D, Ctrl+N and Ctrl+J
in the main terminal go to the shell, so open the drawer from the header there.

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
- While a command runs, a new message is typed into that command, for example to answer a
  prompt.
- The reply needs the shell integration of the thread. It works with bash 4.4 or newer and
  zsh. With another shell, or after `exec` replaced the shell, the message is only typed,
  and the reply says that no result is captured.
- A message outside full access mode fails.
- A scheduled task with a webhook never types into a terminal thread. Its run fails, also
  when the task or the project default model points to a terminal thread.

## Sidebar

The sidebar shows the state of a terminal thread until you visit it:

- A bell or an app notification from a program shows Input.
- A program that ends shows Done, or Failed when its exit code is not zero.
- A program that runs in the shell shows Working. A background job does not.

## Shell exit

When the shell of a terminal thread exits or is killed, the session closes. The screen
offers Start a new session, and a message to the thread also starts one. The new session
shows the output of the shell that ended above its prompt. Archiving the thread deletes that
output. A server restart ends the programs in the terminal.

## Zoom and keys

On macOS, Cmd+=, Cmd+- and Cmd+0 change the font size of every terminal, within the limits
in Settings > Fork. Linux and Windows have no zoom keys, because Ctrl+- is undo in shells. Terminal key mappings (Settings > Fork) send fixed bytes for a key, for
example Cmd+Z as the Kitty sequence that a shell binds.
