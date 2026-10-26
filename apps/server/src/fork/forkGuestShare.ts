/**
 * Fork: the guest page shows the images of tool output, such as browser screenshots. Upstream
 * guest routes serve none. `server.ts` keeps a one-line hook into this file.
 */
import {
  GUEST_SHARE_PARAM,
  GUEST_TOOL_OUTPUT_IMAGE_ROUTE,
  guestSessionCookieName,
  isProviderSendTurnSupportedImageMimeType,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { readToolOutputImage } from "../assets/AssetAccess.ts";
import { errorResponse } from "../guest/http.ts";
import { GuestShareAccessError, GuestShareService } from "../guest/GuestShareService.ts";

const unavailable = new GuestShareAccessError({ reason: "unavailable" });

/** An image of a tool's output, only for an item of the session's shared thread. */
export const guestToolOutputImage = Effect.fn("ForkGuestShare.toolOutputImage")(function* (
  session: string,
  itemId: string,
  index: number,
) {
  const guestShares = yield* GuestShareService;
  // Checks the session and reads the item from the shared thread only.
  const { item } = yield* guestShares.item(session, itemId);
  if (item === null) return yield* unavailable;
  const image = yield* readToolOutputImage({
    threadId: item.threadId,
    itemId: item.id,
    index,
  }).pipe(Effect.orElseSucceed(() => null));
  return image === null || !isProviderSendTurnSupportedImageMimeType(image.mimeType)
    ? yield* unavailable
    : image;
});

export const toolOutputImageRoute = HttpRouter.add(
  "GET",
  GUEST_TOOL_OUTPUT_IMAGE_ROUTE,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const params = new URLSearchParams(request.url.split("?", 2)[1] ?? "");
    const shareId = params.get(GUEST_SHARE_PARAM);
    const itemId = params.get("item");
    const indexParam = params.get("index");
    const index = Number(indexParam);
    if (!shareId || !itemId || !Number.isSafeInteger(index) || String(index) !== indexParam) {
      return HttpServerResponse.empty({ status: 400, headers: { "cache-control": "no-store" } });
    }
    const session = request.cookies[guestSessionCookieName(shareId)] ?? "";
    return yield* guestToolOutputImage(session, itemId, index).pipe(
      Effect.map(({ mimeType, bytes }) =>
        HttpServerResponse.uint8Array(bytes, {
          contentType: mimeType,
          headers: {
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
            "content-security-policy": "default-src 'none'; sandbox",
          },
        }),
      ),
      Effect.catchTags({ GuestShareAccessError: errorResponse }),
    );
  }),
);
