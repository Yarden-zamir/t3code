import { type ServerProvider, TERMINAL_THREAD_INSTANCE_ID } from "@t3tools/contracts";

/**
 * Fork: how an agent uses terminal threads. It rides on the `terminal` entry of
 * `orchestrator_capabilities`, which is enabled only while the server setting `terminalThreads`
 * is on, so agent sessions do not pay for this text while the feature is off.
 */
const TERMINAL_THREAD_USAGE =
  "A terminal thread is a thread whose view is a live shell that the user can see and use, such as a dev server, a REPL or a CLI agent. Do not use it in place of your own shell tool. Start one with t3_thread_launch, or schedule_task with bindToCurrentThread:false, and modelSelection {instanceId:'terminal', model:<a model id here, which names the shell>}. The model 'terminal' means the default shell. A message is pasted into the shell as one command line followed by Enter, and needs full access mode. At a bash or zsh prompt the run answers with the exit code and the output of the command, and ends after 10 minutes even when a program still runs. A message sent while a program runs is typed into that program, so you can answer its prompt. The shell keeps cd and export for the next message. A webhook task and delegate_task cannot use it, because their text would be typed into a shell. A call from another machine needs an arrow with exec.";

export function forkProviderUsage(provider: ServerProvider): { readonly usage?: string } {
  return provider.instanceId === TERMINAL_THREAD_INSTANCE_ID && provider.enabled
    ? { usage: TERMINAL_THREAD_USAGE }
    : {};
}
