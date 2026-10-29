/**
 * Fork: the guest routes for a visitor with a `t3.thread` grant (K-706). The guest route accepts
 * either the guest cookie, unchanged, or a verified Access JWT whose visitor holds a grant on the
 * card of the thread: `view` reads it, `send` also sends as the guest does.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";

import { GuestShareService } from "../../guest/GuestShareService.ts";
import { threadResourceId } from "./kitshnGrantRules.ts";
import * as KitshnGrants from "./KitshnGrants.ts";

/** A per-request session token and the effect that completes when the grant ends, or null. */
export const kitshnGuestAccess = Effect.fn("kitshnGuestAccess")(function* (
  request: HttpServerRequest.HttpServerRequest,
  shareId: string,
) {
  const grants = yield* Effect.serviceOption(KitshnGrants.KitshnGrants);
  if (Option.isNone(grants)) return null;
  const visitor = yield* grants.value.visitor(request);
  if (visitor === null) return null;
  const guestShares = yield* GuestShareService;
  const levelOf = (threadId: string) =>
    grants.value.level("t3.thread", threadResourceId(threadId), visitor);
  const granted = yield* guestShares.grantSession(shareId, levelOf);
  if (granted === null) return null;
  return {
    token: granted.token,
    lost: grants.value.awaitLoss(
      levelOf(granted.threadId).pipe(Effect.map((level) => level !== null)),
    ),
  };
});
