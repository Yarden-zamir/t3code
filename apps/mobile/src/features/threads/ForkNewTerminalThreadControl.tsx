import { useNavigation } from "@react-navigation/native";
import { terminalThreadWorkspace } from "@t3tools/client-runtime/state/fork-terminal-thread-creation";
import {
  AuthOrchestrationOperateScope,
  AuthTerminalOperateScope,
  type EnvironmentId,
} from "@t3tools/contracts";
import { View } from "react-native";
import { KeyboardController } from "react-native-keyboard-controller";

import { ComposerInlineControl } from "../../components/ComposerToolbar";
import { useEnvironmentServerConfig } from "../../state/entities";
import { useEnvironmentScope } from "../../state/session";
import { useNewTaskFlow } from "./new-task-flow-provider";

/**
 * Fork: this phone can start a terminal thread in the environment: the server setting
 * `terminalThreads` is on, and the grants allow a new thread and a terminal.
 */
function useTerminalThreadsAvailable(environmentId: EnvironmentId | null): boolean {
  const enabled = useEnvironmentServerConfig(environmentId)?.settings.terminalThreads === true;
  const canOperateTerminal = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const canCreateThread = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  return enabled && canOperateTerminal && canCreateThread;
}

/**
 * Fork: the Terminal control of the new-thread draft, next to its workspace and branch controls,
 * like the Agent | Terminal toggle in the web composer. It opens the New terminal thread sheet on
 * the folder that the draft chose. Every New thread button of the app leads to this draft.
 */
export function ForkNewTerminalThreadControl(props: { readonly disabled: boolean }) {
  const flow = useNewTaskFlow();
  const navigation = useNavigation();
  const project = flow.selectedProject;
  const available = useTerminalThreadsAvailable(project?.environmentId ?? null);
  if (!available || project === null) return null;
  return (
    <ComposerInlineControl
      accessibilityLabel="New terminal thread"
      accessibilityHint="Opens a shell in a new thread instead of an agent"
      disabled={props.disabled}
      icon="terminal"
      label="Terminal"
      showChevron={false}
      onPress={() => {
        void KeyboardController.dismiss({ animated: true });
        navigation.navigate("ForkNewTerminalThread", {
          environmentId: project.environmentId,
          projectId: project.id,
          workspace: terminalThreadWorkspace({
            mode: flow.canChooseWorkspace ? flow.workspaceMode : "local",
            worktreePath: flow.canChooseWorkspace ? flow.selectedWorktreePath : null,
            branch: flow.selectedBranchName,
            startFromOrigin: flow.startFromOrigin,
          }),
          startFromOrigin: flow.startFromOrigin,
        });
      }}
    />
  );
}

/** Fork: the Terminal control on its own row, for a draft without workspace controls. */
export function ForkNewTerminalThreadRow(props: { readonly disabled: boolean }) {
  return (
    <View className="flex-row items-center gap-1 px-2">
      <ForkNewTerminalThreadControl disabled={props.disabled} />
    </View>
  );
}
