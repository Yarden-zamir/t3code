/**
 * Fork: the live `kitshn provider` connection (K-704, protocol 2), shared by the services that talk
 * to the daemon. `KitshnProvider` owns the child and attaches each registered connection here;
 * `KitshnGrants` and `MachineExec` read it without a dependency on the provider and its services.
 */
import type { Answer, IdRequest, Request } from "@kitshn/local";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

export type RegisterAnswer = Extract<Answer, { readonly type: "register" }>;
/** A line of the daemon without an id: an event (K-703). */
export type DaemonEvent = Exclude<Answer, { readonly id: unknown }>;
export const isDaemonEvent = (answer: Answer): answer is DaemonEvent => !("id" in answer);

/** The requests that T3 sends and that wait for an answer of the same id. */
export type LocalRequest = Extract<
  IdRequest,
  {
    readonly type:
      | "ask"
      | "job-cancel"
      | "samples"
      | "desired-set"
      | "check"
      | "exec"
      | "exec-input"
      | "exec-close"
      | "attest-result";
  }
>;
export type LocalRequestInput = LocalRequest extends infer R
  ? R extends LocalRequest
    ? Omit<R, "id">
    : never
  : never;
/** The lines that T3 sends without an id; they get no answer. */
export type Notice = Extract<Request, { readonly type: "pong" | "exec-credit" }>;

/** The answer of a request, by the type of the request. */
export type AnswerOf<T extends LocalRequestInput["type"]> = Extract<
  Answer,
  { readonly type: T extends "ask" ? "ask" : T }
>;

/** Why a local request to kitshn did not get an answer. */
export class KitshnRequestError extends Schema.TaggedError<KitshnRequestError>()(
  "KitshnRequestError",
  { message: Schema.String },
) {}

export interface LiveConnection {
  readonly answer: RegisterAnswer;
  readonly request: (input: LocalRequestInput) => Effect.Effect<Answer, KitshnRequestError>;
  readonly notify: (notice: Notice) => Effect.Effect<void>;
}

const NOT_CONNECTED =
  "This server has no connection to kitshn. It needs kitshn 2 on this machine, joined to kitshn, with its daemon running.";

export class KitshnConnection extends Context.Service<
  KitshnConnection,
  {
    /** The registered connection now, then each change; null while none is open. */
    readonly live: Stream.Stream<LiveConnection | null>;
    readonly current: Effect.Effect<LiveConnection | null>;
    /**
     * Counts `grants-changed` events and new connections at the moment they arrive, so an answer
     * to a request sent before the latest count is known to be old.
     */
    readonly grantsEpoch: Effect.Effect<number>;
    /** The daemon's events from now on, so a caller subscribes before it sends its request. */
    readonly subscribe: Effect.Effect<PubSub.Subscription<DaemonEvent>, never, Scope.Scope>;
    /** One request over the live connection. An `error` answer fails with its text. */
    readonly request: <I extends LocalRequestInput>(
      input: I,
    ) => Effect.Effect<AnswerOf<I["type"]>, KitshnRequestError>;
    readonly notify: (notice: Notice) => Effect.Effect<void, KitshnRequestError>;
    /** `KitshnProvider` only: the connection that registered, or null when it closed. */
    readonly attach: (live: LiveConnection | null) => Effect.Effect<void>;
    readonly publish: (event: DaemonEvent) => Effect.Effect<void>;
  }
>()("t3/fork/kitshn/KitshnConnection") {}

export const make = Effect.gen(function* () {
  const live = yield* SubscriptionRef.make<LiveConnection | null>(null);
  const events = yield* PubSub.unbounded<DaemonEvent>();
  let grantsEpoch = 0;

  const requireLive = SubscriptionRef.get(live).pipe(
    Effect.filterOrFail(
      (connection): connection is LiveConnection => connection !== null,
      () => new KitshnRequestError({ message: NOT_CONNECTED }),
    ),
  );

  const request = Effect.fn("KitshnConnection.request")(function* <I extends LocalRequestInput>(
    input: I,
  ) {
    const connection = yield* requireLive;
    const answer = yield* connection.request(input);
    if (answer.type === "error") {
      return yield* new KitshnRequestError({ message: answer.error });
    }
    if (answer.type !== input.type) {
      return yield* new KitshnRequestError({
        message: `kitshn answered ${input.type} with ${answer.type}.`,
      });
    }
    return answer as AnswerOf<I["type"]>;
  });

  return KitshnConnection.of({
    live: SubscriptionRef.changes(live),
    current: SubscriptionRef.get(live),
    grantsEpoch: Effect.sync(() => grantsEpoch),
    subscribe: PubSub.subscribe(events),
    request,
    notify: Effect.fn("KitshnConnection.notify")(function* (notice) {
      const connection = yield* requireLive;
      yield* connection.notify(notice);
    }),
    attach: Effect.fn("KitshnConnection.attach")(function* (next) {
      grantsEpoch++;
      yield* SubscriptionRef.set(live, next);
    }),
    publish: Effect.fnUntraced(function* (event) {
      // Untraced: one span per daemon event would be noise.
      if (event.type === "grants-changed") grantsEpoch++;
      yield* PubSub.publish(events, event);
    }),
  });
});

export const layer = Layer.effect(KitshnConnection, make);
