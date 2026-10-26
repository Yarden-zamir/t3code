import {
  GUEST_ITEM_ROUTE,
  GuestShareId,
  GuestStreamEvent,
  MessageId,
  OrchestrationV2GetTurnItemResult,
  ProviderDriverKind,
  RunId,
  TurnItemId,
  guestToolOutputImageUrl,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { makeThreadProjectionFixture } from "../../test-fixtures";
import { GuestPage } from "./GuestPage";

const SHARE_ID = "share-1";
const encodeEvent = Schema.encodeSync(Schema.fromJsonString(Schema.toCodecJson(GuestStreamEvent)));
const encodeDetail = Schema.encodeSync(Schema.toCodecJson(OrchestrationV2GetTurnItemResult));

const fixture = makeThreadProjectionFixture();
const threadId = fixture.thread.id;
const at = DateTime.makeUnsafe("2026-10-23T10:00:00.000Z");

const screenshot = {
  id: TurnItemId.make("screenshot"),
  threadId,
  runId: RunId.make("run-1"),
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status: "completed",
  title: null,
  startedAt: at,
  completedAt: at,
  updatedAt: at,
  type: "dynamic_tool",
  toolName: "mcp__t3-code__preview_screenshot",
  input: null,
  // As the owner's stream sends it: the output loads when the row expands.
  outputOmitted: true,
} satisfies OrchestrationV2TurnItem;

const opening: ReadonlyArray<GuestStreamEvent> = [
  {
    type: "view",
    view: {
      shareId: GuestShareId.make(SHARE_ID),
      title: "Fix login",
      guestName: "Sam",
      expiresAt: "2026-10-24T10:00:00.000Z",
      messages: [],
      model: { driver: ProviderDriverKind.make("codex"), name: "GPT-5.4", shortName: "5.4" },
    },
  },
  {
    type: "thread",
    item: {
      kind: "snapshot",
      snapshotSequence: 1,
      projection: {
        ...fixture,
        runs: [
          {
            id: RunId.make("run-1"),
            threadId,
            ordinal: 1,
            providerInstanceId: fixture.thread.providerInstanceId,
            modelSelection: fixture.thread.modelSelection,
            providerThreadId: null,
            userMessageId: MessageId.make("user-run-1"),
            rootNodeId: null,
            activeAttemptId: null,
            status: "running",
            requestedAt: at,
            startedAt: at,
            completedAt: null,
            checkpointId: null,
            contextHandoffId: null,
          },
        ],
        turnItems: [screenshot],
        visibleTurnItems: [
          {
            position: 0,
            visibility: "local",
            sourceThreadId: threadId,
            sourceItemId: screenshot.id,
            item: screenshot,
          },
        ],
      },
    },
  },
];

class FakeEventSource extends EventTarget {
  static readonly CLOSED = 2;
  readyState = 1;
  constructor(readonly url: string) {
    super();
    queueMicrotask(() => {
      for (const event of opening) {
        this.dispatchEvent(new MessageEvent("message", { data: encodeEvent(event) }));
      }
    });
  }
  close() {
    this.readyState = 2;
  }
}

function visit(path: string): Disposable {
  const previous = `${window.location.pathname}${window.location.search}`;
  window.history.replaceState(window.history.state, "", path);
  return {
    [Symbol.dispose]: () => window.history.replaceState(window.history.state, "", previous),
  };
}

describe("GuestPage (fork)", () => {
  it("loads a tool's output image through the guest route", async () => {
    using _page = visit(`/guest?share=${SHARE_ID}`);
    using _fetch = vi.spyOn(window, "fetch").mockImplementation(async (input) =>
      String(input).startsWith(GUEST_ITEM_ROUTE)
        ? Response.json(
            encodeDetail({
              item: {
                ...screenshot,
                outputOmitted: false,
                output: [{ type: "image", mimeType: "image/png" }],
              },
            }),
          )
        : new Response(null, { status: 204 }),
    );
    using _stream = vi.spyOn(window, "EventSource").mockImplementation(FakeEventSource as never);
    const container = document.createElement("div");
    container.style.cssText = "height: 900px; width: 900px; display: flex; flex-direction: column;";
    await using screen = await render(<GuestPage />, { container });

    // The test server has no guest routes, so the image fails after its request. The request
    // shows that it went to the guest route, not to the owner's environment.
    const requested: Array<string> = [];
    const requests = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) requested.push(entry.name);
    });
    requests.observe({ type: "resource" });
    // The running turn shows its work collapsed; open it, then the tool's row.
    await userEvent.click(screen.getByRole("button", { expanded: false }).first());
    await userEvent.click(screen.getByLabelText("Mcp__t3-code__preview_screenshot"));
    const imageUrl = new URL(
      guestToolOutputImageUrl(SHARE_ID, "screenshot", 0),
      window.location.origin,
    ).href;
    await vi.waitFor(() => expect(requested).toContain(imageUrl));
    requests.disconnect();
  });
});
