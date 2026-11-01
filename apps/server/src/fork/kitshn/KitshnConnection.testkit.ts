/** Fork: a kitshn daemon connection for tests: a fixed `register` answer and scripted requests. */
import type { Answer } from "@kitshn/local";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as KitshnConnection from "./KitshnConnection.ts";

export const registerAnswer = (
  overrides: Partial<KitshnConnection.RegisterAnswer> = {},
): KitshnConnection.RegisterAnswer => ({
  id: "1",
  type: "register",
  protocol: 2,
  machine: { id: "self", name: "Mac" },
  capabilities: ["check", "exec", "attest", "ping"],
  identityHeaders: ["cf-access-jwt-assertion", "cf-connecting-ip"],
  problems: [],
  saved: { desired: {}, settings: {}, reach: [], served: [] },
  linkSocket: null,
  syncedAt: 0,
  pingMs: 15_000,
  graceMs: 45_000,
  ...overrides,
});

type CheckResult = Extract<Answer, { readonly type: "check" }>["results"][number];
export type CheckAnswer = CheckResult extends infer R
  ? R extends CheckResult
    ? Omit<R, "key">
    : never
  : never;

/** The daemon's `check`: one answer for each set of identity headers. */
export const answerCheck =
  (answerFor: (headers: Readonly<Record<string, string>>) => CheckAnswer) =>
  (input: KitshnConnection.LocalRequestInput): Effect.Effect<Answer> =>
    input.type === "check"
      ? Effect.succeed({
          id: "check",
          type: "check",
          results: input.requests.map(({ key, headers }) => ({ key, ...answerFor(headers) })),
        })
      : Effect.die(`The test daemon does not answer ${input.type}.`);

/** The real connection service with a live fake daemon attached. */
export const layerKitshnConnection = (
  request: (input: KitshnConnection.LocalRequestInput) => Effect.Effect<Answer>,
  answer: KitshnConnection.RegisterAnswer = registerAnswer(),
) =>
  Layer.effect(
    KitshnConnection.KitshnConnection,
    Effect.gen(function* () {
      const connection = yield* KitshnConnection.make;
      yield* connection.attach({ answer, request, notify: () => Effect.void });
      return connection;
    }),
  );
