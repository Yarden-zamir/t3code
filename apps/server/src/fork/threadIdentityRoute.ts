/**
 * Fork: `GET /api/thread-identity`. The MCP credential of a thread is the only auth, as on `/mcp`,
 * and the answer is only about the thread of that credential.
 */
import { FORK_THREAD_IDENTITY_PATH } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as ThreadIdentity from "./ThreadIdentity.ts";

const headers = { "cache-control": "no-store" };

const bearerToken = (authorization: string | undefined) => {
  if (authorization?.startsWith("Bearer ") !== true) return undefined;
  const token = authorization.slice("Bearer ".length).trim();
  return token.length > 0 ? token : undefined;
};

const makeHandler = (identity: ThreadIdentity.ThreadIdentity["Service"]) =>
  Effect.fnUntraced(function* (request: HttpServerRequest.HttpServerRequest) {
    if (request.method !== "GET") {
      return HttpServerResponse.empty({ status: 405, headers: { ...headers, allow: "GET" } });
    }
    const token = bearerToken(request.headers.authorization);
    if (token === undefined) {
      return HttpServerResponse.jsonUnsafe(
        { error: "invalid_request", message: "Send Authorization: Bearer <token>." },
        { status: 400, headers },
      );
    }
    return yield* identity.check(token).pipe(
      Effect.map((body) => HttpServerResponse.jsonUnsafe(body, { headers })),
      Effect.tapError((cause) => Effect.logWarning("thread identity check failed", { cause })),
      Effect.orElseSucceed(() =>
        HttpServerResponse.jsonUnsafe({ error: "internal_error" }, { status: 500, headers }),
      ),
    );
  });

// Request middleware owns tracing; `ThreadIdentity.check` adds its own span.
export const layer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const identity = yield* ThreadIdentity.ThreadIdentity;
    yield* router.add("*", FORK_THREAD_IDENTITY_PATH, makeHandler(identity));
  }),
).pipe(Layer.provide(ThreadIdentity.layer));
