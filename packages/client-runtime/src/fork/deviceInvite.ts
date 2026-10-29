/**
 * Fork: kitshn device invites (K-1601, K-1617). A phone or a desktop app trades a one-time invite
 * code for its own Cloudflare Access service token, then reads its machines from kitshn. The
 * caller passes the HTTP transport: a phone uses `fetch`, the desktop app its main process.
 */
import {
  ClientEnrollResponse,
  type ClientMachine,
  DeviceMachinesResponse,
  t3AppMachines,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const INVITE_PATH = "/join/device";
const CODE_LENGTH = 32;
const HEX = "0123456789abcdef";

export interface DeviceInvite {
  /** `https://<kitshn host>/join/device`. */
  readonly exchangeUrl: string;
  readonly code: string;
}

/** The invite in `https://<kitshn host>/join/device#code=<32 hex>`, or null for any other text. */
export function parseDeviceInvite(text: string): DeviceInvite | null {
  const url = URL.parse(text.trim());
  if (url === null || url.protocol !== "https:" || url.pathname !== INVITE_PATH) return null;
  const code = new URLSearchParams(url.hash.slice(1)).get("code") ?? "";
  if (code.length !== CODE_LENGTH || [...code].some((char) => !HEX.includes(char))) return null;
  return { exchangeUrl: `${url.origin}${INVITE_PATH}`, code };
}

export interface DeviceRequest {
  readonly url: string;
  readonly method: "GET" | "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface DeviceResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
  /** The URL after redirects: Access sends a refused token to its login page. */
  readonly finalUrl: string;
}

/** Sends one request; rejects on a network error. */
export type DeviceTransport = (request: DeviceRequest) => Promise<DeviceResponse>;

/** K-1601: what each refusal of `POST /join/device` means. 423 and 502 keep the invite. */
const DEVICE_INVITE_ERRORS: Readonly<Record<number, string>> = {
  400: "This is not a kitshn invite code. Scan the invite again.",
  404: "This invite is unknown, used or cancelled. Ask the owner for a new invite.",
  410: "This invite expired. Invites last 15 minutes. Ask the owner for a new invite.",
  423: "kitshn is paused. The invite stays: try it again after Resume.",
  502: "Cloudflare did not take the new token. The invite stays: try it again.",
};

const decodeEnrollResponse = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.toCodecJson(ClientEnrollResponse)),
);
const decodeMachines = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.toCodecJson(DeviceMachinesResponse)),
);

/**
 * K-1601: uses the invite once. The answer holds the only copy of the token secret, so the caller
 * saves it before anything else. kitshn uses the code on the first request that arrives, so a
 * lost answer is never sent again: the invite is gone then.
 */
export async function exchangeDeviceInvite(
  invite: DeviceInvite,
  device: string,
  transport: DeviceTransport,
): Promise<ClientEnrollResponse> {
  let response: DeviceResponse;
  try {
    response = await transport({
      url: invite.exchangeUrl,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: invite.code, device: device.slice(0, 200) }),
    });
  } catch (cause) {
    throw new Error(
      "kitshn did not answer. The invite may be used now, so ask the owner for a new invite.",
      { cause },
    );
  }
  if (!response.contentType.includes("application/json")) {
    throw new Error(`kitshn is unreachable (${response.status}). Try again later.`);
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      DEVICE_INVITE_ERRORS[response.status] ?? `kitshn refused the invite (${response.status}).`,
    );
  }
  return decodeEnrollResponse(response.body);
}

export type DeviceMachineList =
  | { readonly _tag: "machines"; readonly machines: ReadonlyArray<ClientMachine> }
  | { readonly _tag: "refused" }
  | { readonly _tag: "unreachable" };

/** K-1601: the T3 servers that the token opens: only `t3.app` cards. */
export async function readDeviceMachines(
  machinesUrl: string,
  token: { readonly clientId: string; readonly clientSecret: string },
  transport: DeviceTransport,
): Promise<DeviceMachineList> {
  const response = await transport({
    url: machinesUrl,
    method: "GET",
    headers: {
      "CF-Access-Client-Id": token.clientId,
      "CF-Access-Client-Secret": token.clientSecret,
    },
  }).catch(() => null);
  if (response === null) return { _tag: "unreachable" };
  const finalHost = URL.parse(response.finalUrl)?.hostname ?? "";
  if (
    response.status === 401 ||
    response.status === 403 ||
    finalHost.endsWith(".cloudflareaccess.com")
  ) {
    return { _tag: "refused" };
  }
  if (response.status < 200 || response.status >= 300) return { _tag: "unreachable" };
  const decoded = decodeMachines(response.body);
  return decoded._tag === "None"
    ? { _tag: "unreachable" }
    : { _tag: "machines", machines: t3AppMachines(decoded.value).machines };
}

export interface DeviceEnrollResult {
  readonly name: string;
  readonly paired: ReadonlyArray<string>;
  readonly failed: ReadonlyArray<{ readonly name: string; readonly reason: string }>;
}

const reasonOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/**
 * K-1601: the steps of an invite, with the effects passed in. The token goes first to the origin
 * of the machine list, its home, so a later failure never loses the only copy of the secret. A
 * machine that does not pair stays saved, and the app's machine sync pairs it later.
 */
export async function enrollWithDeviceInvite(
  invite: DeviceInvite,
  deps: {
    readonly exchange: (invite: DeviceInvite) => Promise<ClientEnrollResponse>;
    /** The origin of a URL, or null for an invalid URL. */
    readonly origin: (url: string) => string | null;
    /** Saves the token for one origin; throws with the reason when it fails. */
    readonly saveToken: (
      origin: string,
      token: ClientEnrollResponse["serviceToken"],
    ) => Promise<void>;
    readonly saveClient: (client: {
      readonly machinesUrl: string;
      readonly clientId: string;
    }) => void;
    /** Pairs with one machine; throws with the reason when it fails. */
    readonly pair: (machine: ClientMachine) => Promise<void>;
  },
): Promise<DeviceEnrollResult> {
  const enrolled = await deps.exchange(invite);
  const listOrigin = deps.origin(enrolled.machinesUrl);
  if (listOrigin === null) throw new Error("kitshn sent an invalid machine list URL.");
  try {
    await deps.saveToken(listOrigin, enrolled.serviceToken);
  } catch (cause) {
    throw new Error(
      `This app could not keep its new token: ${reasonOf(cause)} Ask the owner for a new invite.`,
      { cause },
    );
  }
  deps.saveClient({ machinesUrl: enrolled.machinesUrl, clientId: enrolled.clientId });

  const paired: Array<string> = [];
  const failed: Array<{ name: string; reason: string }> = [];
  for (const machine of t3AppMachines(enrolled).machines) {
    try {
      const origin = deps.origin(machine.origin);
      if (origin === null) throw new Error("kitshn sent an invalid machine address.");
      await deps.saveToken(origin, enrolled.serviceToken);
      await deps.pair({ ...machine, origin });
      paired.push(machine.name);
    } catch (cause) {
      failed.push({ name: machine.name, reason: reasonOf(cause) });
    }
  }
  return { name: enrolled.name, paired, failed };
}
