import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type PreviewAutomationHost,
  type PreviewAutomationRequest,
  type PreviewAutomationStreamEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";

const makeBroker = PreviewAutomationBroker.make.pipe(Effect.provide(NodeServices.layer));

const scope = {
  environmentId: EnvironmentId.make("environment-1"),
  requestNamespace: "provider-session-1",
  thread: {
    threadId: ThreadId.make("thread-1"),
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
};

const makeHost = (overrides: Partial<PreviewAutomationHost> = {}): PreviewAutomationHost => ({
  clientId: "client-1",
  environmentId: scope.environmentId,
  ...overrides,
});

type RoutedRequest = PreviewAutomationRequest & {
  readonly connectionId: PreviewAutomationStreamEvent["connectionId"];
};

const requestsFrom = (
  events: Stream.Stream<PreviewAutomationStreamEvent>,
  onConnected: (connectionId: PreviewAutomationStreamEvent["connectionId"]) => void = () => {},
): Stream.Stream<RoutedRequest> =>
  events.pipe(
    Stream.filterMap((event) => {
      if (event.type === "connected") {
        onConnected(event.connectionId);
        return Result.failVoid;
      }
      return Result.succeed({ ...event.request, connectionId: event.connectionId });
    }),
  );

it.effect("keeps a snapshot's inner deadline and stalled capture stage", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const received = yield* Deferred.make<RoutedRequest>();
      const connected = yield* Deferred.make<void>();
      const requests = requestsFrom(yield* broker.connect(makeHost()), () =>
        Deferred.doneUnsafe(connected, Effect.void),
      );
      yield* Stream.runForEach(requests, (request) => Deferred.succeed(received, request)).pipe(
        Effect.forkScoped,
      );
      yield* Deferred.await(connected);
      const pending = yield* broker
        .invoke<void>({ scope, operation: "snapshot", input: {} })
        .pipe(Effect.flip, Effect.forkScoped);
      const request = yield* Deferred.await(received);
      yield* broker.respond({
        clientId: "client-1",
        connectionId: request.connectionId,
        requestId: request.requestId,
        ok: false,
        error: {
          _tag: "PreviewAutomationTimeoutError",
          message: "Snapshot screenshot timed out after 10000ms.",
          detail: { stage: "screenshot", timeoutMs: 10_000 },
        },
      });
      const error = yield* Fiber.join(pending);
      expect(error).toMatchObject({ timeoutMs: 10_000, captureStage: "screenshot" });
      expect(error.message).toContain("10000ms");
      expect(error.message).toContain("screenshot");
      expect(error.message).not.toContain("15000ms");
    }),
  ),
);
