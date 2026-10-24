import {
  CommonActions,
  StackActions,
  useNavigation,
  usePreventRemove,
  type StaticScreenProps,
} from "@react-navigation/native";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  resolveTerminalShell,
  TERMINAL_REPORTING_SHELLS,
  terminalShellOptions,
  terminalThreadCreateInput,
  type TerminalThreadWorkspace,
} from "@t3tools/client-runtime/state/fork-terminal-thread-creation";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_TERMINAL_ID,
  type EnvironmentId,
  type ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { terminalThreadLaunch } from "@t3tools/shared/terminalThreadLaunch";
import { useEffect, useRef, useState } from "react";
import { Platform, ScrollView, View } from "react-native";
import { ScreenStack } from "react-native-screens";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/ui/AndroidScreenHeader";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListSection } from "../../components/ui/ListSection";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { uuidv4 } from "../../lib/uuid";
import { nativeHeaderScrollEdgeEffects } from "../../native/StackHeader";
import { NativeHeader, NativeScreen } from "../../native/ThemedScreenStack";
import { useEnvironmentServerConfig, useProject, useThreadShell } from "../../state/entities";
import { useBranches } from "../../state/queries";
import { useEnvironmentQuery } from "../../state/query";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { vcsEnvironment } from "../../state/vcs";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import {
  existingTerminalWorktrees,
  newWorktreeBaseBranch,
  terminalFolderChoiceOfDraft,
  terminalThreadFolder,
  type TerminalFolderChoice,
} from "./forkNewTerminalThread";
import { isDraftThreadRoute } from "./thread-route-state";
import { stagePendingTerminalLaunch } from "../terminal/terminalLaunchContext";
import { WorktreeSetupCard } from "./worktree-setup-card";

const HEADER_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);
const TITLE = "New terminal thread";

export type NewTerminalThreadTarget = {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  /** The workspace of the new-thread draft. The sheet opens on it. */
  readonly workspace: TerminalThreadWorkspace;
  /** The Start from origin choice of the draft, which follows the project setting. */
  readonly startFromOrigin: boolean;
};

type Creation =
  | { readonly phase: "idle" }
  | { readonly phase: "preparing" }
  | { readonly phase: "creating" }
  /** The thread exists; the sheet waits for its shell to arrive, then opens it. */
  | { readonly phase: "opening" }
  | { readonly phase: "failed"; readonly message: string };

const failureMessage = (
  result: Parameters<typeof squashAtomCommandFailure>[0],
  fallback: string,
) => {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : fallback;
};

/**
 * Fork: starts a terminal thread from mobile. Web starts one as a draft with a live shell; a phone
 * has no draft terminal, so this sheet takes the shell and the folder first and creates the thread
 * at once, like the enlarge button of the web draft. A new worktree is prepared on the server as
 * on web, under the thread id that the sheet reserves, so its setup script runs in that thread.
 */
export function ForkNewTerminalThreadSheet({ route }: StaticScreenProps<NewTerminalThreadTarget>) {
  const { layout } = useAdaptiveWorkspaceLayout();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { environmentId, projectId, workspace } = route.params;
  const project = useProject(scopeProjectRef(environmentId, projectId));
  const workspaceRoot = project?.workspaceRoot ?? null;
  const shells = terminalShellOptions(useEnvironmentServerConfig(environmentId)?.providers ?? []);
  const [wantedShell, setWantedShell] = useState<string | null>(null);
  const shell = resolveTerminalShell(shells, wantedShell);
  // Limit: the existing worktrees come from the first page of branches. Revisit when a project
  // has more branches than that page and its worktrees go missing here.
  const refsResult = useBranches({ environmentId, cwd: workspaceRoot }).data;
  const refs = refsResult?.refs ?? [];
  const worktrees = workspaceRoot === null ? [] : existingTerminalWorktrees(refs, workspaceRoot);
  const [folder, setFolder] = useState<TerminalFolderChoice>(() =>
    terminalFolderChoiceOfDraft(workspace),
  );
  // The worktree of the draft stays a choice, also when the first page of branches misses it.
  const worktreeRows =
    folder.kind === "worktree" &&
    !worktrees.some((worktree) => worktree.worktreePath === folder.worktreePath)
      ? [
          { worktreePath: folder.worktreePath, branch: folder.branch ?? folder.worktreePath },
          ...worktrees,
        ]
      : worktrees;
  const isGitRepo = refsResult?.isRepo === true;
  const baseBranch = newWorktreeBaseBranch(workspace, refs);
  const [startFromOrigin, setStartFromOrigin] = useState(route.params.startFromOrigin);
  const [threadId] = useState(() => ThreadId.make(uuidv4()));
  const [creation, setCreation] = useState<Creation>({ phase: "idle" });
  // A worktree that is ready stays the folder of the next try, when the thread failed to start.
  const [preparedWorktree, setPreparedWorktree] = useState<{
    readonly worktreePath: string;
    readonly branch: string | null;
  } | null>(null);

  const prepareWorktree = useAtomCommand(vcsEnvironment.prepareDraftWorktree, {
    reportFailure: false,
  });
  const cancelSetup = useAtomCommand(vcsEnvironment.cancelWorktreeSetup, { reportFailure: false });
  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const setup = useEnvironmentQuery(
    folder.kind === "new-worktree" && creation.phase !== "idle"
      ? vcsEnvironment.worktreeSetup({ environmentId, input: { threadId } })
      : null,
  ).data;
  const failure = creation.phase === "failed" ? creation.message : null;
  // The tracker keeps a finished setup for a while. A failed one shows with the error of this try.
  const setupCard =
    setup && (creation.phase === "preparing" ? setup.phase === "running" : setup.error === failure)
      ? setup
      : null;

  const busy = creation.phase === "preparing" || creation.phase === "creating";
  // The worktree and the thread are on their way; Cancel on the setup progress stops a worktree.
  usePreventRemove(busy, () => undefined);
  // The choices stay disabled while the terminal opens. A disabled row is dimmed, so a row that
  // turns enabled changes its native view tree, and on Android that change in the same frame as
  // the navigation away crashes Fabric ("The specified child already has a parent").
  const locked = busy || creation.phase === "opening";

  const createdThread = useThreadShell(
    creation.phase === "opening" ? scopeThreadRef(environmentId, threadId) : null,
  );
  const opened = useRef(false);
  useEffect(() => {
    if (creation.phase !== "opening" || createdThread === null || opened.current) return;
    opened.current = true;
    // The terminal screen opens directly, with the launch that the Thread route redirect would
    // stage (`ThreadRouteScreen`). Going through the Thread route adds a second stack change while
    // the sheet closes, and two stack changes in a row crash Android's native view tree ("The
    // specified child already has a parent").
    if (workspaceRoot !== null) {
      const launch = terminalThreadLaunch({
        workspaceRoot,
        worktreePath: createdThread.worktreePath ?? null,
      });
      stagePendingTerminalLaunch({
        target: { environmentId, threadId, terminalId: DEFAULT_TERMINAL_ID },
        launch: { cwd: launch.cwd, worktreePath: launch.worktreePath, env: { ...launch.env } },
      });
    }
    const terminal = {
      name: "ThreadTerminal" as const,
      params: {
        environmentId: String(environmentId),
        threadId: String(threadId),
        terminalId: DEFAULT_TERMINAL_ID,
      },
    };
    const state = navigation.getState();
    const below = state ? state.routes[state.index - 1] : undefined;
    // The thread takes the place of the new-thread draft, as a sent draft does, so Back goes to
    // the list. The prompt of the draft stays for the next new thread in the project. One reset
    // replaces the draft and closes the sheet in a single stack change.
    if (state !== undefined && below !== undefined && isDraftThreadRoute(below)) {
      const routes = [...state.routes.slice(0, state.index - 1), terminal];
      navigation.dispatch(CommonActions.reset({ ...state, routes, index: routes.length - 1 }));
    } else {
      navigation.dispatch(StackActions.replace(terminal.name, terminal.params));
    }
  }, [createdThread, creation.phase, environmentId, navigation, threadId, workspaceRoot]);

  const start = async () => {
    if (locked || project === null) return;
    let target: { readonly worktreePath: string | null; readonly branch: string | null };
    if (folder.kind === "new-worktree" && preparedWorktree !== null) {
      target = preparedWorktree;
    } else if (folder.kind === "new-worktree") {
      if (baseBranch === null) return;
      setCreation({ phase: "preparing" });
      const prepared = await prepareWorktree({
        environmentId,
        input: { projectId, threadId, baseRef: baseBranch, startFromOrigin },
      });
      if (prepared._tag === "Failure") {
        // A cancel from the setup progress interrupts the preparation.
        setCreation(
          isAtomCommandInterrupted(prepared)
            ? { phase: "idle" }
            : {
                phase: "failed",
                message: failureMessage(prepared, "The worktree could not be created."),
              },
        );
        return;
      }
      target = prepared.value;
      setPreparedWorktree(prepared.value);
    } else {
      target = terminalThreadFolder(folder, refs);
    }
    setCreation({ phase: "creating" });
    const created = await createThread({
      environmentId,
      input: terminalThreadCreateInput({
        threadId,
        projectId,
        shell,
        branch: target.branch,
        worktreePath: target.worktreePath,
        // oxlint-disable-next-line react/purity -- This runs in a press handler, not during render.
        createdAt: new Date().toISOString(),
      }),
    });
    if (created._tag === "Failure") {
      setCreation(
        isAtomCommandInterrupted(created)
          ? { phase: "idle" }
          : {
              phase: "failed",
              message: failureMessage(created, "The terminal thread could not be created."),
            },
      );
      return;
    }
    setCreation({ phase: "opening" });
  };
  const cancel = async () => {
    const result = await cancelSetup({ environmentId, input: { threadId } });
    return result._tag === "Success" && result.value.cancelled;
  };

  const choose = (choice: TerminalFolderChoice) => {
    if (locked) return;
    setFolder(choice);
    if (creation.phase === "failed") setCreation({ phase: "idle" });
  };
  const startBlockedReason =
    project === null
      ? "The project is not available on this connection."
      : shells.length === 0
        ? "Loading the shells of the server…"
        : folder.kind === "new-worktree" && baseBranch === null
          ? "The project has no branch to start a worktree from."
          : null;

  const content = (
    <ScrollView
      nestedScrollEnabled
      className="flex-1"
      keyboardShouldPersistTaps="handled"
      contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
      contentContainerClassName="gap-6 px-5 pt-2"
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
    >
      <ListSection title="Shell">
        {shells.map((option, index) => (
          <ListChoiceRow
            key={option.slug}
            label={option.name}
            description={shellDescription(option)}
            selected={option.slug === shell}
            separated={index > 0}
            disabled={locked}
            onPress={() => setWantedShell(option.slug)}
          />
        ))}
        {shells.length === 0 ? (
          <Text className="px-4 py-3.5 text-sm text-foreground-muted">
            Loading the shells of the server…
          </Text>
        ) : null}
      </ListSection>

      <ListSection
        title="Folder"
        footer={
          folder.kind === "new-worktree" && baseBranch !== null
            ? `The worktree starts from ${startFromOrigin ? `origin/${baseBranch}` : baseBranch}. To start from another branch, choose it as the base branch of the new thread first.`
            : undefined
        }
      >
        <ListChoiceRow
          label="Project folder"
          description={workspaceRoot ?? undefined}
          selected={folder.kind === "project"}
          disabled={locked}
          onPress={() => choose({ kind: "project" })}
        />
        {worktreeRows.map((worktree) => (
          <ListChoiceRow
            key={worktree.worktreePath}
            label={worktree.branch}
            description={worktree.worktreePath}
            selected={folder.kind === "worktree" && folder.worktreePath === worktree.worktreePath}
            separated
            disabled={locked}
            onPress={() =>
              choose({
                kind: "worktree",
                worktreePath: worktree.worktreePath,
                branch: worktree.branch,
              })
            }
          />
        ))}
        {isGitRepo || folder.kind === "new-worktree" ? (
          <ListChoiceRow
            label="New worktree"
            description={baseBranch === null ? undefined : `From ${baseBranch}`}
            selected={folder.kind === "new-worktree"}
            separated
            disabled={locked}
            onPress={() => choose({ kind: "new-worktree" })}
          />
        ) : null}
        {folder.kind === "new-worktree" && refsResult?.hasPrimaryRemote === true ? (
          <View className="border-t border-border-subtle">
            <ListToggleRow
              label="Start from origin"
              description="Fetch origin first, and start from its base branch"
              disabled={locked}
              value={startFromOrigin}
              onValueChange={setStartFromOrigin}
            />
          </View>
        ) : null}
      </ListSection>

      {setupCard !== null ? (
        <WorktreeSetupCard
          snapshot={setupCard}
          turnStarted={false}
          turnStartedAt={null}
          working={false}
          onCancel={() => void cancel()}
          onWorkLocally={
            setupCard.phase === "running"
              ? () =>
                  void cancel().then((cancelled) => {
                    if (cancelled) setFolder({ kind: "project" });
                  })
              : null
          }
        />
      ) : null}
      {failure !== null && setupCard === null ? (
        <Text className="px-2 text-sm text-danger">{failure}</Text>
      ) : null}

      <View className="gap-2">
        <Button
          label={
            creation.phase === "preparing"
              ? "Creating the worktree…"
              : creation.phase === "creating" || creation.phase === "opening"
                ? "Opening the terminal…"
                : "Open terminal"
          }
          icon="terminal"
          tone="primary"
          fullWidth
          loading={locked}
          disabled={startBlockedReason !== null}
          onPress={() => void start()}
        />
        {startBlockedReason !== null && project !== null && shells.length > 0 ? (
          <Text className="px-2 text-center text-xs text-foreground-muted">
            {startBlockedReason}
          </Text>
        ) : null}
      </View>
    </ScrollView>
  );
  if (Platform.OS === "ios") {
    return (
      <View collapsable={false} className="flex-1 bg-sheet">
        <ScreenStack style={{ flex: 1 }}>
          <NativeScreen
            activityState={2}
            enabled
            isNativeStack
            screenId="fork-new-terminal-thread-sheet-native"
            scrollEdgeEffects={HEADER_SCROLL_EDGE_EFFECTS}
            className="flex-1 bg-sheet"
          >
            {content}
            <NativeHeader
              backgroundColor="rgba(0,0,0,0)"
              tintColorClassName="accent-foreground"
              hideBackButton
              hideShadow={false}
              title={TITLE}
              titleColorClassName="accent-foreground"
              titleFontSize={18}
              titleFontWeight="800"
              translucent
            />
          </NativeScreen>
        </ScreenStack>
      </View>
    );
  }
  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {/* A full screen card on Android (`Stack.tsx`), so the header pads for the status bar. */}
      <AndroidScreenHeader title={TITLE} onBack={() => navigation.goBack()} />
      <ScreenContent insetHorizontal={layout.usesSplitView}>{content}</ScreenContent>
    </View>
  );
}

function shellDescription(shell: {
  readonly slug: string;
  readonly isDefault?: boolean | undefined;
  readonly subProvider?: string | undefined;
  readonly unavailableReason?: string | undefined;
}): string | undefined {
  const notes = [
    shell.isDefault ? "Default" : null,
    shell.unavailableReason !== undefined
      ? `Not found: ${shell.unavailableReason}`
      : TERMINAL_REPORTING_SHELLS.has(shell.slug)
        ? null
        : "Types only, no results",
    // The path of the shell (`terminalShells.ts` on the server).
    shell.subProvider ?? null,
  ].filter((note) => note !== null);
  return notes.length === 0 ? undefined : notes.join(" · ");
}
