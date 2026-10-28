import { useAtomValue } from "@effect/atom-react";
import { worktreeRecreateRunId } from "@t3tools/client-runtime/fork/worktreeRecreate";
import {
  FORK_LOST_WORKTREE_FAILURE_CODE,
  type OrchestrationV2TurnItem,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { GitBranchPlusIcon } from "lucide-react";
import { useState } from "react";

import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";

type ErrorItem = Pick<
  Extract<OrchestrationV2TurnItem, { readonly type: "error" }>,
  "runId" | "failure"
>;

/** Fork: the way out of "Couldn't restore thread workspace". Other rows render nothing. */
export function ForkRecreateWorktreeButton(props: {
  readonly threadRef: ScopedThreadRef;
  readonly error: ErrorItem;
}) {
  return props.error.failure.code === FORK_LOST_WORKTREE_FAILURE_CODE ? (
    <RecreateWorktreeButton {...props} />
  ) : null;
}

function RecreateWorktreeButton(props: {
  readonly threadRef: ScopedThreadRef;
  readonly error: ErrorItem;
}) {
  const runId = useAtomValue(environmentThreadDetails.threadAtom(props.threadRef), (thread) =>
    thread ? worktreeRecreateRunId(thread.projection.runs, props.error) : null,
  );
  const allowed = useAtomValue(
    threadEnvironment.recreateWorktree.permissionAtom(props.threadRef.environmentId),
  );
  const recreate = useAtomCommand(threadEnvironment.recreateWorktree, "recreate worktree");
  const [busy, setBusy] = useState(false);
  if (runId === null || !allowed) return null;
  return (
    <div className="ms-7 pb-1">
      <Button
        type="button"
        size="xs"
        variant="outline"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void recreate({
            environmentId: props.threadRef.environmentId,
            input: { threadId: props.threadRef.threadId, runId },
          }).finally(() => setBusy(false));
        }}
      >
        <GitBranchPlusIcon aria-hidden />
        Recreate on a new branch
      </Button>
    </div>
  );
}
