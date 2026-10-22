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

A terminal thread is a thread whose view is a terminal. Use it for an editor, a
CLI agent or a dev server that you want next to your other threads.

Turn on Settings > Fork > Terminal threads on the server. Then start one with the
terminal button next to New thread in the sidebar, with `mod+alt+t`, or with New
terminal thread in the command palette. All three ask for a project.

A message to a terminal thread is typed into its terminal, followed by Enter. This
covers messages from a scheduled task, a webhook or an agent. When the shell is idle,
the run ends with the exit code and the output of the command. When a program runs
in the terminal, the message goes to that program and the run ends at once.

The thread has no timeline and no composer. A server restart ends the programs in its
terminal unless the server runs terminal threads in tmux (Settings > Fork > Terminal
threads in tmux). Terminal key mappings (Settings > Fork) send fixed bytes for a key,
for example Cmd+Z as the Kitty sequence that a shell binds.

`mod+=`, `mod+-` and `mod+0` change the font size in a terminal thread, within the
limits in Settings > Fork.
