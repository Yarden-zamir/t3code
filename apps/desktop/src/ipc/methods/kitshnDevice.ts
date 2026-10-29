import {
  DesktopKitshnDeviceRequestSchema,
  DesktopKitshnDeviceResponseSchema,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

// K-1601: only kitshn's device routes, so the renderer gets no general cross-origin fetch.
const DEVICE_PATHS: ReadonlySet<string> = new Set(["/join/device", "/device/machines"]);
const REQUEST_TIMEOUT = Duration.seconds(20);

/** Fork: sends one request to kitshn's device routes. kitshn sends no CORS headers there. */
export const kitshnDeviceRequest = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.KITSHN_DEVICE_REQUEST_CHANNEL,
  payload: DesktopKitshnDeviceRequestSchema,
  result: DesktopKitshnDeviceResponseSchema,
  handler: Effect.fn("desktop.ipc.kitshnDevice.request")(function* (request) {
    const url = URL.parse(request.url);
    if (url === null || url.protocol !== "https:" || !DEVICE_PATHS.has(url.pathname)) {
      return yield* Effect.die(new Error(`Not a kitshn device route: ${request.url}`));
    }
    const client = yield* HttpClient.HttpClient;
    const base = HttpClientRequest.make(request.method)(url).pipe(
      HttpClientRequest.setHeaders(request.headers),
    );
    const response = yield* client
      .execute(
        request.body === undefined
          ? base
          : HttpClientRequest.bodyText(base, request.body, "application/json"),
      )
      .pipe(Effect.timeout(REQUEST_TIMEOUT), Effect.orDie);
    return {
      status: response.status,
      contentType: response.headers["content-type"] ?? "",
      body: yield* response.text.pipe(Effect.orDie),
      // Access answers a refused token with a redirect to its login page.
      finalUrl: response.headers.location ?? request.url,
    };
  }),
});
