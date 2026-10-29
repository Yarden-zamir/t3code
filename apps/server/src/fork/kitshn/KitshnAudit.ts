/**
 * Fork: the audit of calls on other machines (K-1610). This machine reports each `machine_exec`
 * run and each forwarded T3 tool call to kitshn, never their arguments or output. kitshn drops a
 * report for a machine that this machine does not reach, and takes at most 120 a minute.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";

import type { LinkAudit } from "./kitshnProviderProtocol.ts";
import * as KitshnProvider from "./KitshnProvider.ts";

/**
 * Known limit: only the calling machine reports, and the queue keeps the newest 100 reports while
 * kitshn is out of reach, so a misbehaving source can skip its own reports. Revisit when machines
 * that the owner does not own can join, with reports of the target machine as well.
 */
const QUEUE_LIMIT = 100;
const RETRY_AFTER = Duration.seconds(30);
const NAME_LIMIT = 100;

/** K-1610: the name of an exec run is the first word of its command, cut to 100 characters. */
export const execName = (command: string) => {
  const chars = [...command.trim()];
  const end = chars.findIndex((char) => char.trim() === "");
  const first = (end === -1 ? chars : chars.slice(0, end)).join("");
  return (first === "" ? "command" : first).slice(0, NAME_LIMIT);
};

export class KitshnAudit extends Context.Service<
  KitshnAudit,
  {
    /** Queues one report; it never fails and never waits for kitshn. */
    readonly report: (audit: Omit<LinkAudit, "at">) => Effect.Effect<void>;
  }
>()("t3/fork/kitshn/KitshnAudit") {}

const make = Effect.gen(function* () {
  const provider = yield* KitshnProvider.KitshnProvider;
  const queue = yield* Queue.sliding<LinkAudit>(QUEUE_LIMIT);

  // One report at a time. A failed send means kitshn is out of reach: the report waits and the
  // worker tries again later; the sliding queue drops the oldest reports past the limit.
  yield* Queue.take(queue).pipe(
    Effect.flatMap((audit) =>
      provider
        .request({ type: "audit", provider: "t3", audit })
        .pipe(
          Effect.catch(() =>
            Queue.offer(queue, audit).pipe(Effect.andThen(Effect.sleep(RETRY_AFTER))),
          ),
        ),
    ),
    Effect.forever,
    Effect.forkScoped,
  );

  return KitshnAudit.of({
    report: Effect.fn("KitshnAudit.report")(function* (audit) {
      const at = yield* Clock.currentTimeMillis;
      yield* Queue.offer(queue, { ...audit, at });
    }),
  });
});

export const layer = Layer.effect(KitshnAudit, make);
