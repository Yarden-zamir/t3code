import type { ComponentProps } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  projection: null as unknown,
  workflow: null as unknown,
}));

vi.mock(import("@t3tools/client-runtime/state/thread-workflows"), async (importOriginal) => ({
  ...(await importOriginal()),
  deriveThreadQueueWorkflowState: (() => state.workflow) as never,
}));

vi.mock(import("../../state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  useThreadProjection: (() => state.projection) as never,
}));

vi.mock(import("../../state/use-atom-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomCommand: (() => async () => undefined) as never,
}));

vi.mock(import("../../assets/assetUrls"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAssetUrls: ((_environmentId: never, resources: ReadonlyArray<{ attachmentId: string }>) =>
    resources.map((resource) => `https://assets.test/${resource.attachmentId}`)) as never,
}));

import { render as renderUi } from "../../../test/render";
import { QueuedRunsControl } from "./QueuedRunsControl";

function setup() {
  state.projection = null;
  state.workflow = null;
}

const baseProps = {
  environmentId: "environment:test" as never,
  optimisticMessages: [],
  threadId: "thread:test" as never,
  editingRunId: null,
  editBlockedReason: null,
  onEditQueuedRun: () => undefined,
  onCancelEdit: () => undefined,
  onResumeLimitedThread: () => undefined,
} satisfies ComponentProps<typeof QueuedRunsControl>;

async function renderQueue(props: Partial<ComponentProps<typeof QueuedRunsControl>> = {}) {
  return renderUi(<QueuedRunsControl {...baseProps} {...props} />);
}

it("continues a usage-limited thread instead of sending a queued message now", async () => {
  setup();
  state.projection = { projection: { messages: [] } };
  state.workflow = {
    activeRun: null,
    canPromoteToSteer: false,
    canSendNow: true,
    heldByUsageLimit: true,
    canReorder: true,
    queuedRuns: [
      { run: { id: "run:held", userMessageId: "message:held" }, text: "Held", attachments: [] },
    ],
  };
  const onResumeLimitedThread = vi.fn();
  await using _screen = await renderQueue({ onResumeLimitedThread });

  await page.getByRole("button", { name: "Send now", exact: true }).click();
  expect(onResumeLimitedThread).toHaveBeenCalledOnce();
});
