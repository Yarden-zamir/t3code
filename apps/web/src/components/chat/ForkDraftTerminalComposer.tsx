import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  DEFAULT_RUNTIME_MODE,
  DEFAULT_TERMINAL_ID,
  type EnvironmentId,
  type ResolvedKeybindingsConfig,
  type ServerProvider,
  TERMINAL_THREAD_INSTANCE_ID,
  TERMINAL_THREAD_MODEL_SELECTION,
} from "@t3tools/contracts";
import { terminalThreadLaunch } from "@t3tools/shared/terminalThreadLaunch";
import { useNavigate } from "@tanstack/react-router";
import { FolderGitIcon, FolderIcon, Maximize2Icon, SquareTerminalIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef } from "react";

import {
  type DraftId,
  type DraftThreadState,
  finalizePromotedDraftThreadByRef,
  markPromotedDraftThreadByRef,
} from "../../composerDraftStore";
import {
  isDraftInTerminalMode,
  setDraftTerminalMode,
  setDraftTerminalShell,
} from "../../forkDraftTerminalStore";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useKnownTerminalSessions } from "../../state/terminalSessions";
import { terminalEnvironment } from "../../state/terminal";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { waitForAtomValue } from "../../state/waitForAtomValue";
import { terminalShellOptions } from "../../lib/forkTerminalProviders";
import { basenameOfPath } from "../../pierre-icons";
import { ForkShellTerminal } from "../ForkShellTerminal";
import { Select, SelectGroup, SelectGroupLabel, SelectItem, SelectPopup } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControl, ComposerSelectControl } from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";
import { ComposerSurface } from "./ComposerSurface";

/** A command that runs this long is a program (an editor, a dev server), not a typo. */
const LONG_RUNNING_COMMAND_MS = 1_000;
// The thread shell normally arrives in well under a second. Limit: when it arrives later, the
// thread route finds no thread and goes home. Revisit if slow connections show that.
const THREAD_SHELL_WAIT_MS = 5_000;
// A draft terminal that unmounts and mounts again at once (a remount, a StrictMode probe) keeps
// its shell. Only a draft that stays gone is discarded.
const DISCARD_DELAY_MS = 500;
const TITLE_MAX_CHARS = 80;

const pendingDiscards = new Map<string, number>();
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

/** Fork: switches a draft between Agent mode and Terminal mode. */
export function ForkTerminalModeToggle(props: {
  readonly active: boolean;
  readonly onToggle: () => void;
  /** Why the toggle is off, such as a prompt that Terminal mode would hide. */
  readonly disabledReason?: string | null;
}) {
  const disabledReason = props.disabledReason ?? null;
  return (
    <ComposerControl
      aria-pressed={props.active}
      aria-label={props.active ? "Use an agent" : "Use a terminal"}
      title={
        disabledReason ??
        (props.active ? "Back to an agent" : "Start a terminal instead of an agent")
      }
      disabled={disabledReason !== null}
      onClick={props.onToggle}
    >
      <SquareTerminalIcon />
      <span className="@max-[400px]/composer-surface:hidden">Terminal</span>
    </ComposerControl>
  );
}

function ShellPicker(props: {
  readonly value: string | null;
  readonly shells: ReadonlyArray<{ readonly slug: string; readonly name: string }>;
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
              {shell.name}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectPopup>
    </Select>
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
  // A new worktree does not exist yet, so the shell of a draft that would create one runs in the
  // project root. Limit: such a terminal thread stays in the root; revisit with worktree setup
  // for terminal drafts.
  const worktreePath = draft.envMode === "worktree" ? null : draft.worktreePath;
  const branch = draft.envMode === "worktree" ? null : draft.branch;
  const shells = terminalShellOptions(props.providers);
  // The terminal and the thread it becomes name the same shell, because a different shell (or
  // none, which means the default) restarts a running terminal. A remembered shell that the
  // server no longer offers falls back to its default shell.
  const shell =
    shells.find((option) => option.slug === props.shell)?.slug ?? shells[0]?.slug ?? undefined;
  const navigate = useNavigate();
  const createThread = useOrchestrationCommand(threadEnvironment.create);
  const openTerminal = useAtomCommand(terminalEnvironment.open);
  const closeTerminal = useAtomCommand(terminalEnvironment.close, { reportFailure: false });
  const launch = terminalThreadLaunch({ workspaceRoot: props.workspaceRoot, worktreePath });

  // Attaching to a running shell never restarts it, so a new shell or project restarts it here.
  const launchKey = JSON.stringify([launch.cwd, launch.worktreePath, shell]);
  const mountedLaunchKey = useRef(launchKey);
  useEffect(() => {
    if (mountedLaunchKey.current === launchKey) return;
    mountedLaunchKey.current = launchKey;
    void openTerminal({
      environmentId,
      input: {
        threadId: draft.threadId,
        terminalId: DEFAULT_TERMINAL_ID,
        cwd: launch.cwd,
        worktreePath: launch.worktreePath,
        env: { ...launch.env },
        ...(shell ? { shell } : {}),
      },
    });
  });

  const summary = useKnownTerminalSessions({ environmentId, threadId: draft.threadId })?.find(
    (known) => known.target.terminalId === DEFAULT_TERMINAL_ID,
  )?.state.summary;

  const promotion = useRef<"idle" | "promoting" | "promoted">("idle");
  const mounted = useRef(true);
  const promote = useEffectEvent(async () => {
    if (promotion.current !== "idle") return;
    promotion.current = "promoting";
    const command = summary?.command?.trim();
    const created = await createThread({
      environmentId,
      input: {
        threadId: draft.threadId,
        projectId: draft.projectId,
        title: command ? command.slice(0, TITLE_MAX_CHARS) : "Terminal",
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
      finalizePromotedDraftThreadByRef(threadRef);
      setDraftTerminalMode(draftId, environmentId, false);
      return;
    }
    await expandIntoThread(async () => {
      await navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId: draft.threadId },
        replace: true,
      });
    });
    finalizePromotedDraftThreadByRef(threadRef);
    setDraftTerminalMode(draftId, environmentId, false);
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
    typedText.current ||= !data.startsWith("\u001b") && [...data].some((char) => char >= " ");
  };

  // Leaving the draft before its first command discards the shell and its output.
  const threadKey = `${environmentId}:${draft.threadId}`;
  useEffect(() => {
    mounted.current = true;
    const pending = pendingDiscards.get(threadKey);
    if (pending !== undefined) {
      window.clearTimeout(pending);
      pendingDiscards.delete(threadKey);
    }
    return () => {
      mounted.current = false;
      pendingDiscards.set(
        threadKey,
        window.setTimeout(() => {
          pendingDiscards.delete(threadKey);
          // A thread in creation or created keeps the shell; only an untouched draft loses it.
          if (promotion.current !== "idle") return;
          // Still on this draft in Terminal mode: the composer only unmounted for a moment (a
          // project that reloads), and it attaches to the same shell when it mounts again.
          if (isDraftInTerminalMode(draftId) && window.location.pathname.endsWith(`/${draftId}`)) {
            return;
          }
          // The draft goes back to Agent mode, like an empty chat draft that the user left.
          setDraftTerminalMode(draftId, environmentId, false);
          void closeTerminal({
            environmentId,
            input: {
              threadId: draft.threadId,
              terminalId: DEFAULT_TERMINAL_ID,
              deleteHistory: true,
            },
          });
        }, DISCARD_DELAY_MS),
      );
    };
  }, [closeTerminal, draft.threadId, draftId, environmentId, threadKey]);

  return (
    <ComposerSurface.Main>
      <div className="flex h-[min(22rem,45vh)] min-h-40 overflow-hidden rounded-t-3xl p-2 pb-0 bg-(--terminal-background)">
        <ForkShellTerminal
          threadRef={threadRef}
          workspaceRoot={props.workspaceRoot}
          worktreePath={worktreePath}
          shell={shell}
          focusRequestId={0}
          keybindings={props.keybindings}
          onInput={onInput}
          endedMessage="The shell exited before a command ran."
        />
      </div>
      <div
        data-chat-composer-footer="true"
        className="flex min-w-0 items-center gap-1 px-3 pt-2 pb-3 sm:px-4 sm:pb-4"
      >
        <ForkTerminalModeToggle
          active
          onToggle={() => setDraftTerminalMode(draftId, environmentId, false)}
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
          Run a command to start the thread
        </span>
        <ComposerControl
          aria-label="Open as a thread"
          title="Open as a terminal thread now"
          onClick={() => void promote()}
        >
          <Maximize2Icon />
        </ComposerControl>
      </div>
    </ComposerSurface.Main>
  );
}
