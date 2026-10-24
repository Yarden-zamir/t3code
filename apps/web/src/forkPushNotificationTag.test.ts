import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { pushThreadNotificationTag } from "@t3tools/shared/webPush";
import { expect, it } from "vite-plus/test";

import { threadNotificationTag } from "./threadNotifications";

it("tags a thread push like the page notification of the same thread", () => {
  const environmentId = EnvironmentId.make("6f1c2b8e-3a4d-4c5e-9f60-7a8b9c0d1e2f");
  const threadId = ThreadId.make("thread-0d9e8f7a-6b5c-4d3e-2f1a-0b9c8d7e6f5a");
  expect(pushThreadNotificationTag(environmentId, threadId)).toBe(
    threadNotificationTag(environmentId, threadId),
  );
});
