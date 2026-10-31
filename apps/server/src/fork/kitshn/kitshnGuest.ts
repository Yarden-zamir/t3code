/**
 * Fork: the guest routes for a kitshn visitor with a `t3.thread` level (K-721). The guest route
 * accepts either the guest cookie, unchanged, or a kitshn visitor whose levels hold the card of the
 * thread: `view` reads it, `send` also sends as the guest does.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";

import { GuestShareService } from "../../guest/GuestShareService.ts";
import { levelFor, threadResourceId } from "./kitshnGrantRules.ts";
import * as KitshnGrants from "./KitshnGrants.ts";

/** A per-request session token and the effect that completes when the level ends, or null. */
export const kitshnGuestAccess = Effect.fn("kitshnGuestAccess")(function* (
  request: HttpServerRequest.HttpServerRequest,
  shareId: string,
) {
  const grants = yield* Effect.serviceOption(KitshnGrants.KitshnGrants);
  if (Option.isNone(grants)) return null;
  const result = yield* grants.value.visitor(request);
  if (result._tag !== "visitor") return null;
  const { visitor } = result;
  const guestShares = yield* GuestShareService;
  const granted = yield* guestShares.grantSession(shareId, (threadId) =>
    Effect.succeed(levelFor("t3.thread", threadResourceId(threadId), visitor.levels)),
  );
  if (granted === null) return null;
  const card = threadResourceId(granted.threadId);
  return {
    token: granted.token,
    lost: grants.value.awaitLoss(
      visitor,
      (latest) => levelFor("t3.thread", card, latest.levels) !== null,
    ),
  };
});
