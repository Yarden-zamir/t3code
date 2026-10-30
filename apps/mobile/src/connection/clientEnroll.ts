/**
 * Fork: a phone with a kitshn device invite (K-1601). The invite gives this app its own Cloudflare
 * Access service token and its machines. The app keeps the token as request headers for each
 * machine origin and for kitshn, then pairs with each machine through
 * `/api/auth/cloudflare-access/pairing-credential`.
 */
import type { DeviceTransport } from "@t3tools/client-runtime/fork/deviceInvite";
import { AuthPairingCredentialResult } from "@t3tools/contracts";
import * as Device from "expo-device";
import * as Schema from "effect/Schema";
import { Platform } from "react-native";

import { fetchWithRequestHeaders, isCloudflareAccessChallenged } from "./requestHeaders";

const decodePairingCredential = Schema.decodeUnknownSync(
  Schema.toCodecJson(AuthPairingCredentialResult),
);

const KITSHN_TIMEOUT_MS = 20_000;

/** The name of this phone on the kitshn map, for example "Pixel 8 · Android 16". */
export function deviceName(): string {
  const model = Device.modelName ?? "Phone";
  return `${model} · ${Platform.OS === "android" ? "Android" : "iOS"} ${Device.osVersion ?? ""}`.trim();
}

/** Calls kitshn directly: the phone has no CORS, and it passes its token headers itself. */
export const kitshnTransport: DeviceTransport = async (request) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), KITSHN_TIMEOUT_MS);
  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      ...(request.body === undefined ? {} : { body: request.body }),
      signal: controller.signal,
    });
    return {
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      body: await response.text(),
      finalUrl: response.url || request.url,
    };
  } finally {
    clearTimeout(timeout);
  }
};

// Right after an enroll, Access may not accept the new token yet, and the machine
// may not know the new client until the portal's desired state reaches it.
const PAIRING_RETRY_DELAYS_MS = [1_000, 3_000, 6_000];

/**
 * A one-use pairing credential from a machine. Needs the token headers saved for
 * its origin. Retries a refusal a few times, for a token that is still new.
 */
export async function issueMachinePairingCredential(origin: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetchWithRequestHeaders(
      `${origin}/api/auth/cloudflare-access/pairing-credential`,
      { method: "POST" },
    );
    // fetch follows the Access login redirect, so a refused token can end as a 200 login page.
    const refused =
      response.status === 401 || response.status === 403 || isCloudflareAccessChallenged(origin);
    if (response.ok && !refused) return decodePairingCredential(await response.json()).credential;
    const delay = PAIRING_RETRY_DELAYS_MS[attempt];
    if (refused && delay !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      continue;
    }
    const status = response.ok ? "Cloudflare Access login" : response.status;
    throw new Error(
      refused
        ? `The machine refused this phone (${status}). Cloudflare Access may not accept the new token yet, or the machine runs a version without app invites; update it, then use a new invite.`
        : `The machine refused this phone (${response.status}).`,
    );
  }
}
