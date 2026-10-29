/**
 * Fork: the decisions of the app token repair (forkAppTokenRepair.ts), kept free of effects so
 * that tests can cover them. An app token client is a phone that a portal invite enrolled
 * (MM-913); it reaches each machine with its own Cloudflare Access service token.
 */
import {
  type CloudflareAccessServiceToken,
  cloudflareAccessServiceToken,
  type OriginRequestHeaders,
} from "@t3tools/client-runtime/connection";
import type { DeviceMachineList } from "@t3tools/client-runtime/fork/deviceInvite";
import type { ClientMachine, EnvironmentId } from "@t3tools/contracts";

/**
 * A session that the machine refused: the level of the client changed, its arrow expired, the
 * pause ended, `clientAccess` changed, or the 7-day sweep ended an idle session (MM-912, MM-921,
 * MM-1305). Only a new pairing helps. The pause itself is not a refusal: it keeps the session.
 */
export function isRefusedSession(state: {
  readonly phase: string;
  readonly lastFailure?: { readonly reason: string } | null;
}): boolean {
  return state.phase === "blocked" && state.lastFailure?.reason === "authentication";
}

/** The pause before the next repair of one environment, like the sibling backoff of MM-922. */
export function repairDelayMs(failures: number): number {
  const first = 30_000;
  const max = 10 * 60_000;
  return Math.min(max, first * 2 ** Math.max(0, failures - 1));
}

/** The origins that hold the service token with this client id: the app token origins. */
export function appTokenOrigins(
  rules: ReadonlyArray<OriginRequestHeaders>,
  tokenClientId: string,
): ReadonlySet<string> {
  return new Set(
    rules
      .filter((rule) => cloudflareAccessServiceToken(rule.headers)?.clientId === tokenClientId)
      .map((rule) => rule.origin),
  );
}

/** A saved environment that reaches a machine origin with the app token. */
export interface AppTokenEnvironment {
  readonly environmentId: EnvironmentId;
  readonly origin: string;
  readonly enabled: boolean;
}

export interface MachineSyncPlan {
  /** Machines that the portal lists and that no saved environment reaches: pair with them. */
  readonly pair: ReadonlyArray<ClientMachine>;
  /** Environments of machines that kitshn no longer lists for this phone. */
  readonly disable: ReadonlyArray<EnvironmentId>;
  /** Environments that the repair disabled before and that the portal lists again. */
  readonly enable: ReadonlyArray<EnvironmentId>;
}

/**
 * Compares the machines of kitshn's `GET /device/machines` (K-1601) with the saved environments. The
 * repair disables an environment instead of removing it: a removal also deletes the saved token
 * of its origin, and the app could not pair again. It enables only what it disabled itself.
 */
export function planMachineSync(input: {
  readonly machines: ReadonlyArray<ClientMachine>;
  readonly saved: ReadonlyArray<AppTokenEnvironment>;
  readonly disabledByRepair: ReadonlySet<EnvironmentId>;
}): MachineSyncPlan {
  const listed = new Set(input.machines.map((machine) => machine.origin));
  // An empty list says nothing about access, for example before cards have addresses.
  if (listed.size === 0) return { pair: [], disable: [], enable: [] };
  const savedOrigins = new Set(input.saved.map((environment) => environment.origin));
  return {
    pair: input.machines.filter((machine) => !savedOrigins.has(machine.origin)),
    disable: input.saved
      .filter((environment) => environment.enabled && !listed.has(environment.origin))
      .map((environment) => environment.environmentId),
    enable: input.saved
      .filter(
        (environment) =>
          !environment.enabled &&
          listed.has(environment.origin) &&
          input.disabledByRepair.has(environment.environmentId),
      )
      .map((environment) => environment.environmentId),
  };
}

// The action comes first, because the lists cut a long reason after a few words.
export const TOKEN_REFUSED_MESSAGE =
  "Add this phone on the kitshn map again: kitshn refused its device token.";

export const REPAIRING_MESSAGE = "Pairing again with the app token of this phone...";

export const NO_ACCESS_MESSAGE =
  "No access to this machine now. Share its T3 app card with this phone on the kitshn map.";

export const EMPTY_LIST_MESSAGE =
  "kitshn lists no machines for this phone yet. The saved machines stay as they are.";

/**
 * K-1601: the saved service tokens to read kitshn's machine list with, newest first, each once.
 * A rule saved later is newer, and the token saved for kitshn's own origin comes first. So a
 * phone that holds an old portal token reads its list with the token of its device invite.
 */
export function deviceTokensNewestFirst(
  rules: ReadonlyArray<OriginRequestHeaders>,
  kitshnOrigin: string | null,
): ReadonlyArray<{ readonly origin: string; readonly token: CloudflareAccessServiceToken }> {
  const newestFirst = [...rules]
    .reverse()
    .sort(
      (left, right) => Number(right.origin === kitshnOrigin) - Number(left.origin === kitshnOrigin),
    );
  const seen = new Set<string>();
  return newestFirst.flatMap((rule) => {
    const token = cloudflareAccessServiceToken(rule.headers);
    if (token === null || seen.has(token.clientId)) return [];
    seen.add(token.clientId);
    return [{ origin: rule.origin, token }];
  });
}

export type DeviceListAnswer =
  | {
      readonly _tag: "machines";
      readonly machinesUrl: string;
      readonly token: CloudflareAccessServiceToken;
      readonly machines: ReadonlyArray<ClientMachine>;
    }
  | { readonly _tag: "refused" }
  | { readonly _tag: "none" };

/**
 * Reads the machine list with each candidate token in turn and keeps the first list with
 * machines. An empty list falls through, because kitshn answers an old portal token with one.
 */
export async function firstDeviceList(
  candidates: ReadonlyArray<{
    readonly origin: string;
    readonly token: CloudflareAccessServiceToken;
  }>,
  machinesUrlOf: (origin: string) => string | null,
  read: (machinesUrl: string, token: CloudflareAccessServiceToken) => Promise<DeviceMachineList>,
): Promise<DeviceListAnswer> {
  let refused = 0;
  let empty: DeviceListAnswer | null = null;
  for (const { origin, token } of candidates) {
    const machinesUrl = machinesUrlOf(origin);
    if (machinesUrl === null) continue;
    const list = await read(machinesUrl, token);
    if (list._tag === "refused") refused++;
    if (list._tag !== "machines") continue;
    const answer: DeviceListAnswer = {
      _tag: "machines",
      machinesUrl,
      token,
      machines: list.machines,
    };
    if (list.machines.length > 0) return answer;
    empty ??= answer;
  }
  if (empty !== null) return empty;
  return candidates.length > 0 && refused === candidates.length
    ? { _tag: "refused" }
    : { _tag: "none" };
}
