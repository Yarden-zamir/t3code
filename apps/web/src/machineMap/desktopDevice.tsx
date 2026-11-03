/**
 * Fork: the desktop app on kitshn with its own device token (K-1601, K-1617), never the machine
 * token of the daemon (K-711). A pasted device invite gives the token; each `t3.app` card of the
 * token's machine list becomes a saved environment, and goes again when the list drops it.
 */
import {
  cloudflareAccessServiceToken,
  requestHeaderOrigin,
  withCloudflareAccessServiceToken,
} from "@t3tools/client-runtime/connection";
import {
  type DeviceTransport,
  enrollWithDeviceInvite,
  exchangeDeviceInvite,
  parseDeviceInvite,
  readDeviceMachines,
} from "@t3tools/client-runtime/fork/deviceInvite";
import type { CloudflareAccessServiceToken } from "@t3tools/client-runtime/connection";
import * as Schema from "effect/Schema";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { environmentCatalog } from "../connection/catalog";
import {
  connectPairing as connectPairingAtom,
  readRequestHeaders as readRequestHeadersAtom,
  saveRequestHeaders as saveRequestHeadersAtom,
} from "../connection/onboarding";
import { pairSiblingOrigin } from "../connection/siblingEnvironments";
import { useEnvironments, usePrimaryEnvironment } from "../state/environments";
import { useMachineMapState } from "../state/machineMap";
import { useAtomCommand } from "../state/use-atom-command";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { SettingsRow } from "../components/settings/settingsLayout";
import {
  deviceSyncStep,
  type DeviceSyncTrigger,
  listedOrigins,
  type PairFailure,
  pairsDue,
  planDeviceMachines,
  type SavedEnvironment,
} from "./deviceMachines.logic";

const CLIENT_KEY = "t3code:kitshn:device-client";
const MANAGED_KEY = "t3code:kitshn:device-origins";
/** How often the window checks if a sync is due. The check alone contacts nothing. */
const CHECK_MS = 30_000;
/** Per machine origin, for `pairsDue`. The join and the sync share it. */
const pairFailures = new Map<string, PairFailure>();

const DeviceClient = Schema.Struct({ machinesUrl: Schema.String, clientId: Schema.String });
const decodeClient = Schema.decodeUnknownOption(Schema.fromJsonString(DeviceClient));
const decodeOrigins = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);

function readClient(): typeof DeviceClient.Type | null {
  const raw = globalThis.localStorage.getItem(CLIENT_KEY);
  if (raw === null) return null;
  const decoded = decodeClient(raw);
  if (decoded._tag === "None") throw new Error(`${CLIENT_KEY} holds an invalid value.`);
  return decoded.value;
}

function readManaged(): Set<string> {
  const raw = globalThis.localStorage.getItem(MANAGED_KEY);
  if (raw === null) return new Set();
  const decoded = decodeOrigins(raw);
  if (decoded._tag === "None") throw new Error(`${MANAGED_KEY} holds an invalid value.`);
  return new Set(decoded.value);
}

function writeManaged(origins: ReadonlySet<string>): void {
  globalThis.localStorage.setItem(MANAGED_KEY, JSON.stringify([...origins]));
}

/** kitshn sends no CORS headers on its device routes, so the main process sends the request. */
const desktopTransport: DeviceTransport = (request) => {
  const send = window.desktopBridge?.kitshnDeviceRequest;
  return send === undefined
    ? Promise.reject(new Error("Only the desktop app joins with a device invite."))
    : send(request);
};

const desktopDeviceName = () => `T3 Code desktop · ${navigator.platform}`.slice(0, 200);

/** The request header steps that the invite and the sync share. */
function useDeviceSteps() {
  const connectPairing = useAtomCommand(connectPairingAtom, { reportFailure: false });
  const readRequestHeaders = useAtomCommand(readRequestHeadersAtom, { reportFailure: false });
  const saveRequestHeaders = useAtomCommand(saveRequestHeadersAtom, { reportFailure: false });
  const removeEnvironment = useAtomCommand(environmentCatalog.remove, { reportFailure: false });

  const tokenOf = async (origin: string) => {
    const current = await readRequestHeaders(origin);
    return current._tag === "Success" ? cloudflareAccessServiceToken(current.value) : null;
  };
  const saveToken = async (origin: string, token: CloudflareAccessServiceToken | null) => {
    const current = await readRequestHeaders(origin);
    if (current._tag === "Failure") throw new Error(`Could not read the headers of ${origin}.`);
    const saved = await saveRequestHeaders({
      origin,
      headers: withCloudflareAccessServiceToken(current.value, token),
    });
    if (saved._tag === "Failure") throw new Error(`Could not save the token for ${origin}.`);
  };
  /** Pairs now and keeps the failure for `pairsDue`; throws with the reason when it fails. */
  const pair = async (origin: string, nowMs: number) => {
    const error = await pairSiblingOrigin(origin, connectPairing, "omit");
    if (error === null) {
      pairFailures.delete(origin);
      return;
    }
    pairFailures.set(origin, { count: (pairFailures.get(origin)?.count ?? 0) + 1, atMs: nowMs });
    throw error instanceof Error ? error : new Error(String(error));
  };
  return { tokenOf, saveToken, pair, removeEnvironment };
}

/** The join of Settings > Machines; the `t3code://join-device` link runs the same. */
export function useJoinWithDeviceInvite() {
  const steps = useDeviceSteps();
  return async (text: string): Promise<{ readonly joined: boolean; readonly message: string }> => {
    const invite = parseDeviceInvite(text);
    if (invite === null) {
      return {
        joined: false,
        message: "Paste a kitshn device invite link: https://<kitshn>/join/device#code=…",
      };
    }
    const managed = readManaged();
    const result = await enrollWithDeviceInvite(invite, {
      exchange: (next) => exchangeDeviceInvite(next, desktopDeviceName(), desktopTransport),
      origin: requestHeaderOrigin,
      saveToken: steps.saveToken,
      saveClient: (client) => globalThis.localStorage.setItem(CLIENT_KEY, JSON.stringify(client)),
      pair: async (machine) => {
        managed.add(machine.origin);
        writeManaged(managed);
        await steps.pair(machine.origin, Date.now());
      },
    }).then(
      (enrolled) => enrolled,
      (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause))),
    );
    if (result instanceof Error) return { joined: false, message: result.message };
    return {
      joined: true,
      message: [
        `Joined as "${result.name}". Paired: ${result.paired.join(", ") || "none"}.`,
        ...result.failed.map((entry) => `${entry.name}: ${entry.reason}`),
        result.failed.length > 0 ? "This app tries the other machines again by itself." : "",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  };
}

/** Settings > Machines: paste a kitshn device invite for this desktop app. */
export function DeviceInviteSettingsRow() {
  const joinWithDeviceInvite = useJoinWithDeviceInvite();
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const join = async () => {
    setPending(true);
    setMessage(null);
    const result = await joinWithDeviceInvite(text);
    setPending(false);
    setMessage(result.message);
    if (result.joined) setText("");
  };

  return (
    <SettingsRow
      title="Join with a device invite"
      description={
        message ??
        'Add this desktop app on the kitshn map with "Add device", then paste the invite link here. Each T3 machine that kitshn shares with it becomes an environment.'
      }
      control={
        <div className="flex gap-2">
          <Input
            aria-label="kitshn device invite"
            value={text}
            disabled={pending}
            onChange={(event) => setText(event.target.value)}
            placeholder="https://kit…/join/device#code=…"
          />
          <Button size="sm" disabled={pending || text.trim() === ""} onClick={() => void join()}>
            Join
          </Button>
        </div>
      }
    />
  );
}

/**
 * K-1617: keeps one saved environment per `t3.app` card of the device's machine list. A refused
 * machine pairs again with a backoff, because Access can take seconds to accept a new token.
 * Each list read and pairing wakes kitshn, so they run only as `deviceSyncStep` and `pairsDue` allow.
 */
export function DesktopDeviceMachines() {
  const primaryEnvironmentId = usePrimaryEnvironment()?.environmentId ?? null;
  // kitshn's id of this machine, so its own card never becomes a second environment.
  const ownMachineId = useMachineMapState(primaryEnvironmentId).state?.machine?.id ?? null;
  const { isReady, environments } = useEnvironments();
  const steps = useDeviceSteps();
  const running = useRef(false);
  const lastSyncAtMs = useRef<number | null>(null);
  // The listed machines that kitshn shows offline, from the last list read.
  const offline = useRef<ReadonlySet<string>>(new Set());

  const saved = environments
    .filter((environment) => environment.environmentId !== primaryEnvironmentId)
    .map((environment): SavedEnvironment => ({
      environmentId: environment.environmentId,
      origin: environment.displayUrl === null ? null : requestHeaderOrigin(environment.displayUrl),
      phase: environment.connection.phase,
    }));

  // Managed machines from the last list (or a join) that are not saved, or saved and refused.
  const pairWaiting = async (nowMs: number) => {
    const managed = readManaged();
    const due = pairsDue({
      waiting: planDeviceMachines({ listed: [...managed], managed, saved }).pair,
      offline: offline.current,
      failures: pairFailures,
      nowMs,
    });
    if (due.length > 0) lastSyncAtMs.current = nowMs;
    for (const origin of due) {
      await steps.pair(origin, nowMs).catch((error: unknown) => {
        console.warn("kitshn: could not add a machine.", origin, error);
      });
    }
  };

  const syncList = async (nowMs: number) => {
    const client = readClient();
    const listOrigin = client === null ? null : requestHeaderOrigin(client.machinesUrl);
    // Until the server knows its kitshn id, its own card could look like another machine.
    if (client === null || listOrigin === null || ownMachineId === null) return;
    const token = await steps.tokenOf(listOrigin);
    if (token === null) return;
    lastSyncAtMs.current = nowMs;
    const list = await readDeviceMachines(client.machinesUrl, token, desktopTransport);
    // A refused or unreadable list removes nothing; the token may only be new.
    if (list._tag !== "machines") return;
    offline.current = new Set(
      list.machines.flatMap((machine) =>
        machine.online === false ? (requestHeaderOrigin(machine.origin) ?? []) : [],
      ),
    );
    const managed = readManaged();
    const plan = planDeviceMachines({
      listed: listedOrigins(list.machines, ownMachineId, requestHeaderOrigin),
      managed,
      saved,
    });
    for (const { origin, environmentId } of plan.remove) {
      if (environmentId !== null) {
        const removed = await steps.removeEnvironment(environmentId);
        if (removed._tag === "Failure") continue;
      }
      await steps.saveToken(origin, null);
      managed.delete(origin);
      writeManaged(managed);
    }
    for (const origin of plan.keep) {
      managed.add(origin);
      writeManaged(managed);
      const current = await steps.tokenOf(origin);
      if (current?.clientId !== token.clientId || current.clientSecret !== token.clientSecret) {
        await steps.saveToken(origin, token);
      }
    }
  };

  const runStep = async (trigger: DeviceSyncTrigger) => {
    const nowMs = Date.now();
    const step = deviceSyncStep({
      trigger,
      hidden: document.visibilityState === "hidden",
      running: running.current,
      lastSyncAtMs: lastSyncAtMs.current,
      nowMs,
    });
    if (step === "none") return;
    running.current = true;
    await syncList(nowMs)
      .then(() => pairWaiting(nowMs))
      .catch((error: unknown) => {
        console.error("kitshn: could not sync the device machines.", error);
      });
    running.current = false;
  };

  const sync = useEffectEvent((trigger: DeviceSyncTrigger) => {
    if (!isReady) return;
    void runStep(trigger).catch((error: unknown) => {
      console.error("kitshn: could not decide the device sync.", error);
    });
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- syncs with kitshn on visibility, focus and a timer, outside React.
  useEffect(() => {
    if (isReady) sync("event");
    const onVisibility = () => {
      if (document.visibilityState === "visible") sync("event");
    };
    const onFocus = () => sync("event");
    document.addEventListener("visibilitychange", onVisibility);
    globalThis.addEventListener("focus", onFocus);
    const timer = globalThis.setInterval(() => sync("tick"), CHECK_MS);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      globalThis.removeEventListener("focus", onFocus);
      globalThis.clearInterval(timer);
    };
  }, [isReady]);

  return null;
}
