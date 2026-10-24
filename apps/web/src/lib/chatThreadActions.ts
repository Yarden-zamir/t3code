import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ScopedProjectRef,
} from "@t3tools/contracts";
import type { ComposerThreadDraftState, DraftThreadEnvMode } from "../composerDraftStore";
import { getClientSettings } from "../hooks/useSettings";

type ComposerModelSelectionState = Pick<
  ComposerThreadDraftState,
  "activeProvider" | "modelSelectionByProvider" | "modelSelectionExplicit"
>;

interface ThreadContextLike {
  environmentId: EnvironmentId;
  projectId: ProjectId;
}

interface NewThreadHandler {
  (
    projectRef: ScopedProjectRef,
    options?: {
      branch?: string | null;
      worktreePath?: string | null;
      envMode?: DraftThreadEnvMode;
      startFromOrigin?: boolean;
    },
  ): Promise<unknown>;
}

export interface ChatThreadActionContext {
  readonly activeDraftThread: ThreadContextLike | null;
  readonly activeThread: ThreadContextLike | undefined;
  readonly defaultProjectRef: ScopedProjectRef | null;
  readonly handleNewThread: NewThreadHandler;
  /**
   * Fork: opens a terminal draft (`forkTerminalThreads.ts`). `opensAsThread` makes the draft a
   * terminal thread at once, like its enlarge button.
   */
  readonly handleNewTerminalThread: (
    projectRef: ScopedProjectRef,
    options?: { readonly opensAsThread: boolean },
  ) => Promise<unknown>;
}

/** Fork: a normal chat thread or a terminal thread (`forkTerminalThreads.ts`). */
export type NewThreadKind = "chat" | "terminal";

/** Fork: starts a thread of `kind` in a project, the one place both kinds branch. */
export function startNewThreadInProject(
  context: Pick<ChatThreadActionContext, "handleNewThread" | "handleNewTerminalThread">,
  projectRef: ScopedProjectRef,
  kind: NewThreadKind,
  terminalOptions?: { readonly opensAsThread: boolean },
): Promise<unknown> {
  return kind === "terminal"
    ? context.handleNewTerminalThread(projectRef, terminalOptions)
    : context.handleNewThread(projectRef);
}

export function resolveNewDraftStartFromOrigin(input: {
  envMode: DraftThreadEnvMode;
  newWorktreesStartFromOrigin: boolean;
}): boolean {
  return input.envMode === "worktree" && input.newWorktreesStartFromOrigin;
}

export function resolveNewThreadModelSelectionOverride(input: {
  readonly projectDefaultSelection: ModelSelection | null;
  readonly carrySelection: ModelSelection | null;
  readonly carrySourceDraftId: string | null;
  readonly destinationDraftId: string;
}): ModelSelection | null {
  return (
    input.projectDefaultSelection ??
    (input.carrySourceDraftId === input.destinationDraftId ? null : input.carrySelection)
  );
}

export function hasExplicitComposerModelSelection(
  draft: ComposerModelSelectionState | null | undefined,
): boolean {
  const activeProvider = draft?.activeProvider;
  return (
    draft?.modelSelectionExplicit === true &&
    activeProvider !== null &&
    activeProvider !== undefined &&
    draft.modelSelectionByProvider[activeProvider] !== undefined
  );
}

export function resolveThreadActionProjectRef(
  context: ChatThreadActionContext,
): ScopedProjectRef | null {
  if (context.activeThread) {
    return scopeProjectRef(context.activeThread.environmentId, context.activeThread.projectId);
  }
  if (context.activeDraftThread) {
    return scopeProjectRef(
      context.activeDraftThread.environmentId,
      context.activeDraftThread.projectId,
    );
  }
  return context.defaultProjectRef;
}

export async function startNewThreadFromContext(
  context: ChatThreadActionContext,
  kind: NewThreadKind = "chat",
): Promise<boolean> {
  const projectRef = resolveThreadActionProjectRef(context);
  if (!projectRef) {
    return false;
  }

  // Fork: only this "in current project" path reads the setting. The project picker calls
  // `startNewThreadInProject` directly, so its terminal stays a draft until the first command.
  await startNewThreadInProject(context, projectRef, kind, {
    opensAsThread: getClientSettings().currentProjectTerminalOpensThread,
  });
  return true;
}
