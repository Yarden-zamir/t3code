import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ThreadId, type ProjectScript } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { selectThreadTerminalUiState } from "../../terminalUiStateStore";

const terminal = vi.hoisted(() => ({
  launches: [] as Array<{ readonly terminalId: string | undefined }>,
  writes: [] as Array<{ readonly terminalId: string; readonly data: string }>,
}));

vi.mock(import("../terminal/useThreadTerminalActions"), () => ({
  useThreadTerminalActions: (() => ({
    launchTerminal: (input: { readonly terminalId?: string }) => {
      terminal.launches.push({ terminalId: input.terminalId });
      return {
        terminalId: input.terminalId ?? "new-terminal",
        result: Promise.resolve({ _tag: "Success", value: undefined }),
      };
    },
    writeToTerminal: (terminalId: string, data: string) => {
      terminal.writes.push({ terminalId, data });
      return Promise.resolve({ _tag: "Success", value: undefined });
    },
  })) as never,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
}));

import { useChatTerminalActions } from "./useChatTerminalActions";

const environmentId = EnvironmentId.make("environment-1");
const threadId = ThreadId.make("thread-1");

function setup() {
  terminal.launches = [];
  terminal.writes = [];
}

function script(overrides: Partial<ProjectScript>): ProjectScript {
  return {
    id: "dev",
    name: "Dev",
    command: "pnpm dev",
    icon: "play",
    runOnWorktreeCreate: false,
    ...overrides,
  };
}

function Harness(props: {
  readonly onReady: (actions: ReturnType<typeof useChatTerminalActions>) => void;
  readonly setTerminalFocusRequestId: () => void;
}) {
  const actions = useChatTerminalActions({
    environmentId,
    composerRef: { current: null },
    terminalUiState: {
      ...selectThreadTerminalUiState({}, null),
      terminalIds: ["default"],
      activeTerminalId: "default",
    },
    activeThread: { worktreePath: null } as unknown as EnvironmentThreadShell,
    activeThreadId: threadId,
    activeThreadRef: { environmentId, threadId },
    activeProject: {
      id: ProjectId.make("project-1"),
      workspaceRoot: "/repo",
    } as unknown as Parameters<typeof useChatTerminalActions>[0]["activeProject"],
    activeRightPanelSurface: null,
    runningTerminalIds: [],
    activeServerOrderedTerminalIds: [],
    activeTerminalLabelsById: new Map(),
    panelTerminalIds: new Set(),
    canReuseTerminal: true,
    gitCwd: null,
    setTerminalFocusRequestId: props.setTerminalFocusRequestId,
    setTerminalUiLaunchContext: () => {},
    setThreadError: () => {},
  });
  props.onReady(actions);
  return null;
}

async function runScript(projectScript: ProjectScript) {
  const setTerminalFocusRequestId = vi.fn();
  const harness: { actions?: ReturnType<typeof useChatTerminalActions> } = {};
  await using _screen = await render(
    <Harness
      onReady={(actions) => {
        harness.actions = actions;
      }}
      setTerminalFocusRequestId={setTerminalFocusRequestId}
    />,
  );
  if (!harness.actions) throw new Error("The harness did not render.");
  await harness.actions.runProjectScriptStable(projectScript);
  return { setTerminalFocusRequestId };
}

it("runs a background script in a new terminal without taking focus", async () => {
  setup();
  const { setTerminalFocusRequestId } = await runScript(script({ runInBackground: true }));

  expect(terminal.launches).toEqual([{ terminalId: undefined }]);
  expect(terminal.writes.map((write) => write.terminalId)).toEqual(["new-terminal"]);
  expect(setTerminalFocusRequestId).not.toHaveBeenCalled();
});

it("runs a visible script in the idle active terminal and focuses it", async () => {
  setup();
  const { setTerminalFocusRequestId } = await runScript(script({}));

  expect(terminal.launches).toEqual([{ terminalId: "default" }]);
  expect(terminal.writes.map((write) => write.terminalId)).toEqual(["default"]);
  expect(setTerminalFocusRequestId).toHaveBeenCalledOnce();
});
