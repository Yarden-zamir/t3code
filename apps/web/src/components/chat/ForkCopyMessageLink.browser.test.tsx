import type { LegendListRef } from "@legendapp/list/react";
import { DEFAULT_CLIENT_SETTINGS, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { createRef } from "react";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { TimelineCursor } from "../focusLevels/TimelineCursor";
import { runRegisteredFocusLevelCommand } from "../focusLevels/useFocusLevelShortcuts";
import { ForkCopyMessageLink } from "./ForkCopyMessageLink";

const state = vi.hoisted(() => ({ enabled: true }));
vi.mock(import("./ForkMessageLinkTarget"), () => ({
  useForkMessageLinks: () => state.enabled,
}));
vi.mock(import("../../hooks/useSettings"), () => ({
  useClientSettings: (() => true) as never,
  getClientSettings: () => ({ ...DEFAULT_CLIENT_SETTINGS, keyboardFocusLevels: true }),
}));

const threadRef = {
  environmentId: EnvironmentId.make("local"),
  threadId: ThreadId.make("thread:1"),
};

function setup() {
  state.enabled = true;
}

it("copies the message destination and hides the action when message links are off", async () => {
  setup();
  await using screen = await render(
    <ForkCopyMessageLink threadRef={threadRef} messageId="user:1" />,
  );
  using clipboard = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  await screen.getByRole("button", { name: "Copy message link" }).click();
  expect(clipboard).toHaveBeenCalledWith("t3-thread://v1/thread:1#user:1");
  state.enabled = false;
  await screen.rerender(<ForkCopyMessageLink threadRef={threadRef} messageId="user:1" />);
  await expect
    .element(screen.getByRole("button", { name: "Copy message link" }))
    .not.toBeInTheDocument();
});

it("copies only the chosen cursor message, including after focus moves to the palette", async () => {
  setup();
  const viewport = document.createElement("div");
  const listRef = createRef<LegendListRef>();
  // All rows are mounted; this fixture needs no virtual-list scrolling methods.
  listRef.current = { getScrollableNode: () => viewport } as unknown as LegendListRef;
  const rows = [
    { id: "work-row" },
    { id: "user-row", message: { id: "user:1" } },
    { id: "assistant-row", message: { id: "assistant:2" } },
  ];
  const element = (ref = threadRef) => (
    <>
      <div data-timeline-row-id="work-row">Tool activity</div>
      <div data-timeline-row-id="user-row">
        <p data-user-message-body>Question</p>
      </div>
      <div data-timeline-row-id="assistant-row">
        <p data-assistant-citation-source="assistant:2">Answer</p>
      </div>
      <TimelineCursor
        viewport={viewport}
        listRef={listRef}
        rows={rows}
        threadRef={ref}
        onCite={undefined}
      />
    </>
  );
  await using screen = await render(element(), { container: viewport });
  using clipboard = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  expect(runRegisteredFocusLevelCommand("timeline.copyMessageLink")).toBe(false);
  await act(() => {
    viewport.focus();
    runRegisteredFocusLevelCommand("timeline.previous");
  });
  await act(() => {
    viewport.blur();
    runRegisteredFocusLevelCommand("timeline.copyMessageLink");
  });
  expect(clipboard).toHaveBeenLastCalledWith("t3-thread://v1/thread:1#assistant:2");
  await act(() => {
    viewport.focus();
    runRegisteredFocusLevelCommand("timeline.previous");
    runRegisteredFocusLevelCommand("timeline.copyMessageLink");
  });
  expect(clipboard).toHaveBeenLastCalledWith("t3-thread://v1/thread:1#user:1");
  await act(() => {
    runRegisteredFocusLevelCommand("timeline.previous");
  });
  expect(runRegisteredFocusLevelCommand("timeline.copyMessageLink")).toBe(false);
  expect(clipboard).toHaveBeenCalledTimes(2);
  await act(() => {
    runRegisteredFocusLevelCommand("timeline.next");
  });
  state.enabled = false;
  await screen.rerender(element());
  expect(runRegisteredFocusLevelCommand("timeline.copyMessageLink")).toBe(false);
  expect(clipboard).toHaveBeenCalledTimes(2);
  state.enabled = true;
  await screen.rerender(element({ ...threadRef, threadId: ThreadId.make("thread:other") }));
  expect(runRegisteredFocusLevelCommand("timeline.copyMessageLink")).toBe(false);
  expect(clipboard).toHaveBeenCalledTimes(2);
});
