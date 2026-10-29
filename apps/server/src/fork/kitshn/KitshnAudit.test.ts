import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";

import * as KitshnAudit from "./KitshnAudit.ts";
import type { LinkAudit } from "./kitshnProviderProtocol.ts";
import * as KitshnProvider from "./KitshnProvider.ts";

/** The audit service with its worker running in the test's scope. */
const auditWith = (request: KitshnProvider.KitshnProvider["Service"]["request"]) =>
  Layer.build(
    KitshnAudit.layer.pipe(Layer.provide(Layer.mock(KitshnProvider.KitshnProvider)({ request }))),
  ).pipe(Effect.map((context) => Context.get(context, KitshnAudit.KitshnAudit)));

const report = (overrides: Partial<Omit<LinkAudit, "at">> = {}): Omit<LinkAudit, "at"> => ({
  kind: "exec",
  target: "vps",
  thread: "thread-1",
  name: "git",
  cwd: "/srv/app",
  outcome: "succeeded",
  exitCode: 0,
  ...overrides,
});

it.effect("cuts a report over kitshn's limits, and later reports still go out", () =>
  Effect.gen(function* () {
    const sent = yield* Queue.unbounded<LinkAudit>();
    const audit = yield* auditWith((request) =>
      request.type === "audit"
        ? Queue.offer(sent, request.audit).pipe(Effect.as({ id: "1", type: "audit" as const }))
        : Effect.die("not an audit"),
    );
    yield* audit.report(report({ cwd: "x".repeat(600), thread: "t".repeat(300) }));
    yield* audit.report(report({ name: "ls" }));
    const first = yield* Queue.take(sent);
    expect(first.cwd).toHaveLength(500);
    expect(first.thread).toHaveLength(200);
    expect((yield* Queue.take(sent)).name).toBe("ls");
  }).pipe(Effect.scoped),
);

it.effect("a report that breaks the request drops alone, not the worker", () =>
  Effect.gen(function* () {
    const sent = yield* Queue.unbounded<string>();
    const audit = yield* auditWith((request) =>
      request.type !== "audit"
        ? Effect.die("not an audit")
        : request.audit.name === "boom"
          ? Effect.die(new Error("encode failed"))
          : Queue.offer(sent, request.audit.name).pipe(
              Effect.as({ id: "1", type: "audit" as const }),
            ),
    );
    yield* audit.report(report({ name: "boom" }));
    yield* audit.report(report({ name: "after" }));
    expect(yield* Queue.take(sent)).toBe("after");
  }).pipe(Effect.scoped),
);
