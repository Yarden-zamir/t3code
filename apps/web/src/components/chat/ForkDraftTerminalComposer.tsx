import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_RUNTIME_MODE,
  DEFAULT_TERMINAL_ID,
  type EnvironmentId,
  type ResolvedKeybindingsConfig,
  type ServerProvider,
  TERMINAL_THREAD_INSTANCE_ID,
  TERMINAL_THREAD_MODEL_SELECTION,
  terminalThreadTitle,
} from "@t3tools/contracts";
import { resolveProjectScripts, setupProjectScript } from "@t3tools/shared/projectScripts";
import { terminalThreadLaunch } from "@t3tools/shared/terminalThreadLaunch";
import { useNavigate } from "@tanstack/react-router";
import {
  BotIcon,
  FolderGit2Icon,
  FolderGitIcon,
  FolderIcon,
  Maximize2Icon,
  SquareTerminalIcon,
} from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import {
  composerDraftHasUserContent,
  type DraftId,
  type DraftThreadState,
  finalizePromotedDraftThreadByRef,
  markPromotedDraftThreadByRef,
  restoreFailedBackgroundDraftThread,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { newThreadId } from "../../lib/utils";
import { setDraftTerminalMode, setDraftTerminalShell } from "../../forkDraftTerminalStore";
import { resolveDraftTerminalWorkspace } from "../../forkDraftTerminalWorkspace";
import { terminalThreadOpenInput } from "../../forkTerminalThreadOpen";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useProject } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useKnownTerminalSessions } from "../../state/terminalSessions";
import { terminalEnvironment } from "../../state/terminal";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { vcsEnvironment } from "../../state/vcs";
import { waitForAtomValue } from "../../state/waitForAtomValue";
import { terminalShellOptions } from "../../lib/forkTerminalProviders";
import { basenameOfPath } from "../../pierre-icons";
import { recallCheckoutIsRepo } from "../ChatView.logic";
import { ForkShellTerminal } from "../ForkShellTerminal";
import { focusLevel } from "../focusLevels/focusLevels";
import { Button } from "../ui/button";
import { Select, SelectGroup, SelectGroupLabel, SelectItem, SelectPopup } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControl, ComposerSelectControl } from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";
import { ComposerSurface } from "./ComposerSurface";
import { WorktreeSetupCard } from "./WorktreeSetupCard";

// The shells with the hook that reports exit codes and output to agents (`shellIntegration.ts`).
// Limit: bash older than 4.4 has the name but no hook; revisit if the server reports it.
const REPORTING_SHELLS = new Set(["bash", "zsh"]);
/** A command that runs this long is a program (an editor, a dev server), not a typo. */
const LONG_RUNNING_COMMAND_MS = 1_000;
// The thread shell normally arrives in well under a second. Limit: when it arrives later, the
// thread route finds no thread and goes home. Revisit if slow connections show that.
const THREAD_SHELL_WAIT_MS = 5_000;
// A draft that unmounts and mounts again at once (a remount, a StrictMode probe) stays as it is.
const LEAVE_CHECK_DELAY_MS = 500;

// The new screen paints its terminal within a few frames. Limit: a slower surface shows the end of
// the animation without text; revisit if that is visible in practice.
const SURFACE_PAINT_WAIT_MS = 400;
const SURFACE_POLL_MS = 16;

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => Promise<void>) => { readonly finished: Promise<void> };
};

/**
 * Grows the terminal of the draft into the screen of its thread (`fork-theme.css`, the shared
 * `view-transition-name` of `ForkShellTerminal`), where the browser can and motion is welcome.
 */
async function expandIntoThread(update: () => Promise<void>): Promise<void> {
  const transitionDocument = document as ViewTransitionDocument;
  if (
    !transitionDocument.startViewTransition ||
    document.visibilityState !== "visible" ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    await update();
    return;
  }
  const root = document.documentElement;
  root.dataset.forkTerminalExpand = "true";
  try {
    await transitionDocument.startViewTransition(async () => {
      await update();
      const deadline = performance.now() + SURFACE_PAINT_WAIT_MS;
      while (
        performance.now() < deadline &&
        document.querySelector('[data-terminal-owner="terminal-thread"] canvas') === null
      ) {
        await new Promise((resolve) => window.setTimeout(resolve, SURFACE_POLL_MS));
      }
    }).finished;
  } catch {
    // A skipped transition still ran its update.
  } finally {
    delete root.dataset.forkTerminalExpand;
  }
}

/**
 * Fork: switches a draft between an agent and a terminal. Two halves, so the current mode reads
 * at a glance. A prompt typed in Agent mode stays in the draft while the terminal runs.
 */
export function ForkTerminalModeToggle(props: {
  readonly active: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <div
      role="group"
      aria-label="Agent or terminal"
      // The footer counts it in its width (`restingComposerControlsMeasurement.ts`).
      data-fork-leading-control="true"
      className="flex shrink-0 items-center"
    >
      <ComposerControl
        size="xs"
        aria-pressed={!props.active}
        title="Ask an agent"
        onClick={props.active ? props.onToggle : undefined}
      >
        <BotIcon />
        <span className="@max-[400px]/composer-surface:hidden">Agent</span>
      </ComposerControl>
      <ComposerControl
        size="xs"
        aria-pressed={props.active}
        title="Open a terminal instead of an agent"
        onClick={props.active ? undefined : props.onToggle}
      >
        <SquareTerminalIcon />
        <span className="@max-[400px]/composer-surface:hidden">Terminal</span>
      </ComposerControl>
    </div>
  );
}

function ShellPicker(props: {
  readonly value: string | null;
  readonly shells: ReadonlyArray<{
    readonly slug: string;
    readonly name: string;
    /** The path of the shell (`terminalShells.ts` on the server). */
    readonly subProvider?: string | undefined;
    readonly isDefault?: boolean | undefined;
  }>;
  readonly onChange: (shell: string) => void;
  readonly onClose: () => void;
}) {
  const menuProps = useComposerMenuProps();
  const selected = props.value ?? props.shells[0]?.slug ?? null;
  if (props.shells.length === 0) return null;
  return (
    <Select
      modal={false}
      value={selected}
      onValueChange={(value: string | null) => {
        if (value !== null) props.onChange(value);
      }}
      items={props.shells.map((shell) => ({ value: shell.slug, label: shell.name }))}
      onOpenChange={(open) => {
        // The composer menus give focus back to the prompt, which Terminal mode does not show.
        if (!open) props.onClose();
      }}
    >
      <ComposerSelectControl aria-label="Shell">
        {props.shells.find((shell) => shell.slug === selected)?.name ?? selected}
      </ComposerSelectControl>
      <SelectPopup alignItemWithTrigger={false} {...menuProps} finalFocus={false}>
        <SelectGroup>
          <SelectGroupLabel>Shell</SelectGroupLabel>
          {props.shells.map((shell) => (
            <SelectItem key={shell.slug} value={shell.slug}>
              <span className="flex min-w-0 flex-col">
                <span>
                  {shell.name}
                  {shell.isDefault ? (
                    <span className="ms-2 text-muted-foreground text-xs">default</span>
                  ) : null}
                  {REPORTING_SHELLS.has(shell.slug) ? null : (
                    <span className="ms-2 text-muted-foreground text-xs">
                      types only, no results
                    </span>
                  )}
                </span>
                {shell.subProvider ? (
                  <span className="truncate text-muted-foreground text-xs">
                    {shell.subProvider}
                  </span>
                ) : null}
              </span>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectPopup>
    </Select>
  );
}

type WorktreeCreation =
  | { readonly phase: "idle" }
  | { readonly phase: "creating" }
  | {
      readonly phase: "failed";
      readonly workspaceRoot: string;
      readonly baseBranch: string;
      readonly message: string;
    };

/**
 * A draft in New worktree mode has no folder for its shell yet. Creating the worktree is an
 * explicit step, so switching the workspace back and forth leaves no worktrees behind. The server
 * prepares it as for a chat thread: fetch, branch, setup script, progress. Then the draft points
 * at the worktree, like a draft that picked an existing worktree. An async setup script keeps
 * running in a terminal of the draft's thread id, which the thread gets when the draft becomes one.
 */
function NewWorktreePanel(props: {
  readonly draftId: DraftId;
  readonly draft: DraftThreadState;
  readonly workspaceRoot: string;
  readonly baseBranch: string | null;
  readonly startFromOrigin: boolean;
}) {
  const { draft, draftId, baseBranch } = props;
  const environmentId = draft.environmentId;
  const prepareWorktree = useAtomCommand(vcsEnvironment.prepareDraftWorktree, {
    reportFailure: false,
  });
  const cancelSetup = useAtomCommand(vcsEnvironment.cancelWorktreeSetup, { reportFailure: false });
  const canCreate = useAtomValue(vcsEnvironment.prepareDraftWorktree.permissionAtom(environmentId));
  const project = useProject(scopeProjectRef(environmentId, draft.projectId));
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  const setupScript =
    project && settings ? setupProjectScript(resolveProjectScripts(settings, project)) : null;
  const [creation, setCreation] = useState<WorktreeCreation>({ phase: "idle" });
  const failure =
    creation.phase === "failed" &&
    creation.workspaceRoot === props.workspaceRoot &&
    creation.baseBranch === baseBranch
      ? creation.message
      : null;
  const setup = useEnvironmentQuery(
    creation.phase === "idle"
      ? null
      : vcsEnvironment.worktreeSetup({ environmentId, input: { threadId: draft.threadId } }),
  ).data;
  // The tracker keeps a finished setup for a while, so an earlier attempt can still be there.
  // A failed one shows only with the error of this attempt.
  const setupCard =
    setup && (creation.phase === "creating" ? setup.phase === "running" : setup.error === failure)
      ? setup
      : null;

  const create = async (base: string) => {
    setCreation({ phase: "creating" });
    const result = await prepareWorktree({
      environmentId,
      input: {
        projectId: draft.projectId,
        threadId: draft.threadId,
        baseRef: base,
        startFromOrigin: props.startFromOrigin,
      },
    });
    if (result._tag === "Failure") {
      // A cancel from the progress card interrupts the preparation.
      if (isAtomCommandInterrupted(result)) {
        setCreation({ phase: "idle" });
        return;
      }
      const error = squashAtomCommandFailure(result);
      setCreation({
        phase: "failed",
        workspaceRoot: props.workspaceRoot,
        baseBranch: base,
        message: error instanceof Error ? error.message : "The worktree could not be created.",
      });
      return;
    }
    setCreation({ phase: "idle" });
    // A draft that moved to another workspace or project meanwhile keeps that choice. A draft
    // that the user left still points at the worktree, like a chat draft that picked one.
    const store = useComposerDraftStore.getState();
    const current = store.getDraftSession(draftId);
    if (
      current?.environmentId !== environmentId ||
      current.projectId !== draft.projectId ||
      current.envMode !== "worktree" ||
      current.worktreePath !== null
    ) {
      return;
    }
    store.setDraftThreadContext(draftId, {
      worktreePath: result.value.worktreePath,
      branch: result.value.branch,
      envMode: "worktree",
    });
  };
  const cancel = async () => {
    const result = await cancelSetup({ environmentId, input: { threadId: draft.threadId } });
    return result._tag === "Success" && result.value.cancelled;
  };

  const disabledReason = !canCreate
    ? "This connection cannot create worktrees."
    : baseBranch === null
      ? "Select a base branch below."
      : null;
  return (
    <div className="m-auto flex max-h-full w-full max-w-sm flex-col items-center gap-3 scrollbar-gutter-both overflow-y-auto px-4 py-2 text-center text-sm">
      <FolderGit2Icon className="size-5 text-muted-foreground" />
      <p>This terminal runs in a new worktree.</p>
      {baseBranch !== null ? (
        <p className="text-muted-foreground text-xs">
          From <span className="font-mono">{baseBranch}</span>
          {props.startFromOrigin ? " on origin, fetched first." : "."}
          {setupScript ? ` Then the setup script “${setupScript.name}” runs.` : null}
        </p>
      ) : null}
      {setupCard !== null ? (
        <div className="w-full text-start">
          <WorktreeSetupCard
            snapshot={setupCard}
            onCancel={() => void cancel()}
            onWorkLocally={
              setupCard.phase === "running"
                ? () =>
                    void cancel().then((cancelled) => {
                      if (!cancelled) return;
                      useComposerDraftStore.getState().setDraftThreadContext(draftId, {
                        envMode: "local",
                        startFromOrigin: false,
                      });
                    })
                : null
            }
            // A draft has no terminal drawer. The thread that the draft becomes shows the terminal.
            onOpenTerminal={null}
          />
        </div>
      ) : null}
      {creation.phase === "creating" && setupCard !== null ? null : (
        <Button
          size="sm"
          disabled={disabledReason !== null || creation.phase === "creating"}
          onClick={() => {
            if (baseBranch !== null) void create(baseBranch);
          }}
        >
          {creation.phase === "creating" ? <Spinner /> : null}
          {creation.phase === "creating" ? "Creating the worktree…" : "Create worktree"}
        </Button>
      )}
      {disabledReason !== null ? (
        <p className="text-muted-foreground text-xs">{disabledReason}</p>
      ) : null}
      {failure !== null && setupCard === null ? (
        <p className="text-destructive text-xs">{failure}</p>
      ) : null}
    </div>
  );
}

/**
 * Fork: the composer of a draft in Terminal mode (`forkDraftTerminalStore.ts`). The prompt box
 * holds a live shell under the thread id that the draft reserves. The first command that ends,
 * or that runs for a second (an interactive or long program), makes the draft a terminal thread
 * with the same shell. A draft that the user leaves before that is discarded with its shell.
 */
export function ForkDraftTerminalComposer(props: {
  readonly draftId: DraftId;
  readonly draft: DraftThreadState;
  readonly workspaceRoot: string;
  readonly shell: string | null;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly keybindings: ResolvedKeybindingsConfig;
}) {
  const { draft, draftId } = props;
  const environmentId: EnvironmentId = draft.environmentId;
  const threadRef = scopeThreadRef(environmentId, draft.threadId);
  // Git status matters only for a New worktree draft, because a project without Git has none.
  const gitStatus = useEnvironmentQuery(
    draft.envMode === "worktree" && draft.worktreePath === null
      ? vcsEnvironment.status({ environmentId, input: { cwd: props.workspaceRoot } })
      : null,
  );
  // The same default as ChatView: a checkout that has not reported yet counts as Git.
  const isGitRepo =
    gitStatus.data?.isRepo ?? recallCheckoutIsRepo(environmentId, props.workspaceRoot) ?? true;
  const workspace = resolveDraftTerminalWorkspace(draft, isGitRepo);
  const worktreePath = workspace.kind === "folder" ? workspace.worktreePath : null;
  const branch = workspace.kind === "folder" ? workspace.branch : null;
  const shells = terminalShellOptions(props.providers);
  // The shell starts once the server's shell list is known. Starting with the default and then
  // naming the shell would restart the terminal while it attaches.
  const shellsKnown = props.providers.some(
    (provider) => provider.instanceId === TERMINAL_THREAD_INSTANCE_ID,
  );
  // The terminal and the thread it becomes name the same shell, because a different shell (or
  // none, which means the default) restarts a running terminal. A remembered shell that the
  // server no longer offers falls back to its default shell.
  const shell =
    shells.find((option) => option.slug === props.shell)?.slug ?? shells[0]?.slug ?? undefined;
  const navigate = useNavigate();
  const createThread = useOrchestrationCommand(threadEnvironment.create);
  const openTerminal = useAtomCommand(terminalEnvironment.open);
  // A draft that has no shell yet has nothing to clear.
  const clearTerminal = useAtomCommand(terminalEnvironment.clear, { reportFailure: false });
  const launch = terminalThreadLaunch({ workspaceRoot: props.workspaceRoot, worktreePath });

  // Attaching to a running shell never restarts it, so a new shell or folder restarts it here.
  // A draft that waits for its new worktree opens no shell. The output of the earlier shell is
  // only its prompt, because a command makes the thread. So the draft clears it, and the thread
  // does not get it with a "new shell" line.
  const launchKey =
    workspace.kind === "folder" ? JSON.stringify([launch.cwd, launch.worktreePath, shell]) : null;
  const mountedLaunchKey = useRef(launchKey);
  useEffect(() => {
    if (launchKey === null || mountedLaunchKey.current === launchKey) return;
    mountedLaunchKey.current = launchKey;
    const target = { threadId: draft.threadId, terminalId: DEFAULT_TERMINAL_ID };
    void clearTerminal({ environmentId, input: target }).then(() =>
      openTerminal({
        environmentId,
        input: terminalThreadOpenInput({
          threadId: draft.threadId,
          workspaceRoot: props.workspaceRoot,
          worktreePath,
          shell,
        }),
      }),
    );
  });

  const summary = useKnownTerminalSessions({ environmentId, threadId: draft.threadId })?.find(
    (known) => known.target.terminalId === DEFAULT_TERMINAL_ID,
  )?.state.summary;

  // The thread took the draft's reserved id. A prompt typed in Agent mode stays in the draft
  // under a new id, so New thread in this project brings it back; an empty draft goes away.
  const releaseDraft = () => {
    const current = useComposerDraftStore.getState();
    if (composerDraftHasUserContent(current.getComposerDraft(draftId))) {
      restoreFailedBackgroundDraftThread(draftId, draft, newThreadId());
    } else {
      finalizePromotedDraftThreadByRef(threadRef);
    }
    setDraftTerminalMode(draftId, environmentId, false);
  };
  const [shellEnded, setShellEnded] = useState(false);
  const promotion = useRef<"idle" | "promoting" | "promoted">("idle");
  const mounted = useRef(true);
  const promote = useEffectEvent(async () => {
    // A program of an earlier shell can still report after a switch to New worktree.
    if (promotion.current !== "idle" || workspace.kind !== "folder") return;
    promotion.current = "promoting";
    const created = await createThread({
      environmentId,
      input: {
        threadId: draft.threadId,
        projectId: draft.projectId,
        title: terminalThreadTitle({ command: summary?.command, shell }),
        modelSelection: {
          instanceId: TERMINAL_THREAD_INSTANCE_ID,
          model: shell ?? TERMINAL_THREAD_MODEL_SELECTION.model,
        },
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: "default",
        branch,
        worktreePath,
        createdAt: new Date().toISOString(),
      },
    });
    if (created._tag === "Failure") {
      // The next command tries again.
      promotion.current = "idle";
      if (isAtomCommandInterrupted(created)) return;
      const error = squashAtomCommandFailure(created);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not open the terminal thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
      return;
    }
    promotion.current = "promoted";
    markPromotedDraftThreadByRef(threadRef);
    await waitForAtomValue({
      registry: appAtomRegistry,
      atom: environmentThreadShells.threadShellAtom(threadRef),
      predicate: (thread) => thread !== null,
      timeoutMs: THREAD_SHELL_WAIT_MS,
    });
    // A user who left while the thread was created stays where they went.
    if (!mounted.current) {
      releaseDraft();
      return;
    }
    await expandIntoThread(async () => {
      await navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId: draft.threadId },
        replace: true,
      });
    });
    releaseDraft();
  });

  // A shell counts as integrated once it printed a mark: an old bash gets the hook file but no
  // hook, and stays `starting`. An integrated shell reports its commands. Without marks, an Enter
  // after typed text is the only sign of a command; a running program is not, because prompt
  // helpers (a git status daemon) also run programs.
  const integrated = summary?.shell === "prompt" || summary?.shell === "running";
  const finishedAt = summary?.attention?.kind === "finished" ? summary.attention.at : null;
  const running = summary?.shell === "running";
  useEffect(() => {
    if (finishedAt !== null) {
      void promote();
      return;
    }
    if (!running) return;
    const timer = window.setTimeout(() => void promote(), LONG_RUNNING_COMMAND_MS);
    return () => window.clearTimeout(timer);
  }, [finishedAt, running]);
  const typedText = useRef(false);
  const onInput = (data: string) => {
    if (integrated) return;
    if (data.includes("\r")) {
      if (typedText.current) void promote();
      typedText.current = false;
      return;
    }
    // A key sequence (an arrow, a function key) starts with ESC and types no text.
    if (!data.startsWith("\u001b") && [...data].some((char) => char >= " ")) {
      typedText.current = true;
    }
  };

  // Leaving the draft puts it back in Agent mode, like an empty chat draft. The shell itself is
  // never closed here: another tab or client can show the same draft, so the server closes a
  // draft terminal once no client at all is attached (`AbandonedTerminalDrafts.ts`).
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // A remount on the same draft (a project that reloads, StrictMode) is no leave.
      window.setTimeout(() => {
        if (promotion.current !== "idle") return;
        if (window.location.pathname.endsWith(`/${draftId}`)) return;
        setDraftTerminalMode(draftId, environmentId, false);
      }, LEAVE_CHECK_DELAY_MS);
    };
  }, [draftId, environmentId]);

  return (
    <ComposerSurface.Main>
      <div className="flex h-[min(22rem,45vh)] min-h-40 overflow-hidden rounded-t-3xl p-2 pb-0 bg-(--terminal-background)">
        {workspace.kind === "new-worktree" ? (
          <NewWorktreePanel
            draftId={draftId}
            draft={draft}
            workspaceRoot={props.workspaceRoot}
            baseBranch={workspace.baseBranch}
            startFromOrigin={workspace.startFromOrigin}
          />
        ) : shellsKnown ? (
          <ForkShellTerminal
            threadRef={threadRef}
            workspaceRoot={props.workspaceRoot}
            worktreePath={worktreePath}
            shell={shell}
            draft
            focusRequestId={0}
            keybindings={props.keybindings}
            onInput={onInput}
            endedMessage="The shell exited before a command ran."
            onEndedChange={setShellEnded}
          />
        ) : (
          <p className="m-auto text-muted-foreground text-sm">Loading the shells of the server…</p>
        )}
      </div>
      <div
        data-chat-composer-footer="true"
        className="flex min-w-0 items-center gap-1 px-3 pt-2 pb-3 sm:px-4 sm:pb-4"
      >
        <ForkTerminalModeToggle
          active
          onToggle={() => {
            setDraftTerminalMode(draftId, environmentId, false);
            // The prompt mounts in the next frames; it gets focus like a new draft's prompt.
            requestAnimationFrame(() => requestAnimationFrame(() => focusLevel("composer")));
          }}
        />
        <ShellPicker
          value={shell ?? null}
          shells={shells}
          onChange={(shell) => setDraftTerminalShell(draftId, environmentId, shell)}
          onClose={() =>
            document
              .querySelector<HTMLTextAreaElement>(
                '[data-terminal-owner="terminal-thread"] textarea',
              )
              ?.focus()
          }
        />
        {workspace.kind === "folder" ? (
          <>
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="inline-flex min-w-0 items-center gap-1 truncate text-muted-foreground/70 text-xs" />
                }
              >
                {worktreePath ? (
                  <FolderGitIcon className="size-3 shrink-0" />
                ) : (
                  <FolderIcon className="size-3 shrink-0" />
                )}
                <span className="truncate">{basenameOfPath(launch.cwd)}</span>
              </TooltipTrigger>
              <TooltipPopup>The shell runs in {launch.cwd}</TooltipPopup>
            </Tooltip>
            <span className="ms-auto truncate text-muted-foreground/70 text-xs">
              {shellEnded
                ? "Start a new shell, or pick another one"
                : "Run a command to start the thread"}
            </span>
            <ComposerControl
              aria-label="Open as a thread"
              title={
                shellEnded ? "A thread needs a running shell" : "Open as a terminal thread now"
              }
              // A dead shell would make a thread without a terminal.
              disabled={shellEnded}
              onClick={() => void promote()}
            >
              <Maximize2Icon />
            </ComposerControl>
          </>
        ) : null}
      </div>
    </ComposerSurface.Main>
  );
}
