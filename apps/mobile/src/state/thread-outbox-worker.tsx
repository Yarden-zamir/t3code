import { createSingletonHost } from "../lib/singletonHost";
import { useComposerAttachmentUploadWorker } from "./composer-attachment-uploads";
import { useThreadOutboxDrain } from "./use-thread-outbox-drain";

/** Fork: true in the first mounted root, so a queued message is never sent twice. */
export const useIsThreadOutboxHost = createSingletonHost("thread-outbox-host");

// The drain hook subscribes to the outbox, all thread shells, projects, and
// connection statuses. Hosting it in a null-rendering leaf keeps those
// updates from re-rendering the root layout on each enqueue, shell change, or reconnect.
export function ThreadOutboxDrainWorker() {
  useThreadOutboxDrain();
  useComposerAttachmentUploadWorker();
  return null;
}

export function ThreadOutboxWorker() {
  return useIsThreadOutboxHost() ? <ThreadOutboxDrainWorker /> : null;
}
