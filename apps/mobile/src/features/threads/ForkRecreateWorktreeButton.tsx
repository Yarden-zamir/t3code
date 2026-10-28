import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { worktreeRecreateRunId } from "@t3tools/client-runtime/fork/worktreeRecreate";
import {
  type EnvironmentId,
  FORK_LOST_WORKTREE_FAILURE_CODE,
  type OrchestrationV2TurnItem,
  type ThreadId,
} from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { useState } from "react";
import { View } from "react-native";

import { Button } from "../../components/ui/Button";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

type ErrorItem = Pick<
  Extract<OrchestrationV2TurnItem, { readonly type: "error" }>,
  "runId" | "failure"
>;

interface Props {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly error: ErrorItem;
}

/** Fork: the way out of "Couldn't restore thread workspace". Other rows render nothing. */
export function ForkRecreateWorktreeButton(props: Props) {
  return props.error.failure.code === FORK_LOST_WORKTREE_FAILURE_CODE ? (
    <RecreateWorktreeButton {...props} />
  ) : null;
}

function RecreateWorktreeButton(props: Props) {
  const runId = useAtomValue(
    environmentThreadDetails.threadAtom(scopeThreadRef(props.environmentId, props.threadId)),
    (thread) => (thread ? worktreeRecreateRunId(thread.projection.runs, props.error) : null),
  );
  const allowed = useAtomValue(
    threadEnvironment.recreateWorktree.permissionAtom(props.environmentId),
  );
  const recreate = useAtomCommand(threadEnvironment.recreateWorktree, "recreate worktree");
  const [busy, setBusy] = useState(false);
  if (runId === null || !allowed) return null;
  return (
    <View className="ml-7 mt-2">
      <Button
        label="Recreate on a new branch"
        tone="secondary"
        disabled={busy}
        onPress={() => {
          setBusy(true);
          void Haptics.selectionAsync();
          void recreate({
            environmentId: props.environmentId,
            input: { threadId: props.threadId, runId },
          }).finally(() => setBusy(false));
        }}
        icon="arrow.triangle.branch"
      />
    </View>
  );
}
