import { useAtomValue } from "@effect/atom-react";
import type { MessageId, RunId, ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { createSingletonHost } from "../../lib/singletonHost";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentThreadDetails } from "../../state/threads";
import { useVoicePreferences } from "../../state/voice-preferences";
import { readAloud } from "./readAloud";
import { replyToSpeak } from "./replyToSpeak";

interface ReadNextReply {
  readonly threadRef: ScopedThreadRef;
  /** The sent message whose run reply is read. */
  readonly userMessageId: MessageId;
  /**
   * False until the server created the thread. A thread subscription treats a missing thread
   * as deleted and stops for good, so the watch starts only after the thread exists.
   */
  readonly armed: boolean;
}

/** Fork: threads whose next reply is read once, such as a thread the assistant panel started. */
const readNextReplyAtom = Atom.make<ReadonlyArray<ReadNextReply>>([]).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:read-aloud:next-reply"),
);

const sameThread = (left: ScopedThreadRef, right: ScopedThreadRef) =>
  left.environmentId === right.environmentId && left.threadId === right.threadId;

export function readNextReply(request: Omit<ReadNextReply, "armed">): void {
  appAtomRegistry.update(readNextReplyAtom, (current) => [
    ...current.filter((entry) => !sameThread(entry.threadRef, request.threadRef)),
    { ...request, armed: false },
  ]);
}

/** Starts the watch of a requested thread once the server created it. */
export function armNextReply(threadRef: ScopedThreadRef): void {
  appAtomRegistry.update(readNextReplyAtom, (current) =>
    current.some((entry) => sameThread(entry.threadRef, threadRef) && !entry.armed)
      ? current.map((entry) =>
          sameThread(entry.threadRef, threadRef) ? { ...entry, armed: true } : entry,
        )
      : current,
  );
}

/** Drops a pending request, or the one that was just read. */
export function cancelNextReply(threadRef: ScopedThreadRef): void {
  appAtomRegistry.update(readNextReplyAtom, (current) =>
    current.filter((entry) => !sameThread(entry.threadRef, threadRef)),
  );
}

/** True while a thread still waits for its one reply to be read. */
export function useWaitsForNextReply(threadRef: ScopedThreadRef | null): boolean {
  const pending = useAtomValue(readNextReplyAtom);
  return threadRef !== null && pending.some((entry) => sameThread(entry.threadRef, threadRef));
}

const useIsReadAloudHost = createSingletonHost("read-aloud-host");

/**
 * Reads new replies aloud for the threads that ask for it. Each thread keeps its subscription
 * open only while it is listed. Mounted in the app root and in the assistant panel; one runs.
 * Limit: Android pauses JS timers in the background, so reading needs the app or the panel on
 * screen. Revisit if users ask for replies read with the screen off: that needs a native player
 * driven by the agent push notification.
 */
export function ReadAloudWorker() {
  return useIsReadAloudHost() ? <ReadAloudThreads /> : null;
}

function ReadAloudThreads() {
  const { readAloudThreads } = useVoicePreferences();
  const nextReplies = useAtomValue(readNextReplyAtom);
  return (
    <>
      {readAloudThreads.map((threadRef) => (
        <ThreadReplyReader
          key={`always:${threadRef.environmentId}:${threadRef.threadId}`}
          threadRef={threadRef}
          userMessageId={null}
        />
      ))}
      {nextReplies
        .filter(
          (entry) =>
            entry.armed && !readAloudThreads.some((ref) => sameThread(ref, entry.threadRef)),
        )
        .map((entry) => (
          <ThreadReplyReader
            key={`next:${entry.threadRef.environmentId}:${entry.threadRef.threadId}`}
            threadRef={entry.threadRef}
            userMessageId={entry.userMessageId}
          />
        ))}
    </>
  );
}

/** `userMessageId` null: every reply from now on. Otherwise: the reply to that message, then stop. */
function ThreadReplyReader(props: {
  readonly threadRef: ScopedThreadRef;
  readonly userMessageId: MessageId | null;
}) {
  const thread = useAtomValue(environmentThreadDetails.threadAtom(props.threadRef));
  const { readAloudRate } = useVoicePreferences();
  const [mountedAt] = useState(() => Date.now());
  const handledRunIds = useRef(new Set<RunId>());
  const readNewReply = useEffectEvent((current: typeof thread) => {
    if (!current) return;
    const result = replyToSpeak({
      projection: current.projection,
      after:
        props.userMessageId === null
          ? { sinceMs: mountedAt }
          : { userMessageId: props.userMessageId },
      handledRunIds: handledRunIds.current,
    });
    for (const runId of result.settledRunIds) handledRunIds.current.add(runId);
    if (result.reply) {
      readAloud({ id: result.reply.messageId, markdown: result.reply.text, rate: readAloudRate });
    }
    if (props.userMessageId !== null && result.settledRunIds.length > 0) {
      cancelNextReply(props.threadRef);
    }
  });
  useEffect(() => {
    readNewReply(thread);
  }, [thread]);
  return null;
}
