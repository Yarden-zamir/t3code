/**
 * Fork: machine map. Changes that only the local desktop app makes (MM-919).
 */
import {
  AuthSettingsWriteScope,
  EnvironmentAuthorizationError,
  MachineMapRequestError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { isLocalDesktopSubject } from "./machineAccess.ts";

/**
 * MM-919: only the local desktop app changes `clientAccess` or the `machineMap` setting on this
 * machine. Switching the map off, or pointing it at another portal, would end `enforce` as well.
 * The desktop app is the way back in when `enforce` locks every browser out, so each such change
 * is logged; the portal then reports the local change and sends a push message.
 */
export const guardOwnerOnlyPatch = (
  patch: { readonly clientAccess?: string; readonly machineMap?: unknown },
  subject: string,
): Effect.Effect<void, EnvironmentAuthorizationError> => {
  if (patch.clientAccess === undefined && patch.machineMap === undefined) return Effect.void;
  if (!isLocalDesktopSubject(subject)) {
    return Effect.fail(
      new EnvironmentAuthorizationError({
        message:
          "Only the local desktop app or the machine map portal changes clientAccess and the machine map setting.",
        requiredScope: AuthSettingsWriteScope,
      }),
    );
  }
  return Effect.logWarning("The local desktop app changed an owner-only setting.", {
    ...(patch.clientAccess === undefined ? {} : { clientAccess: patch.clientAccess }),
    ...(patch.machineMap === undefined ? {} : { machineMap: true }),
  });
};

/** MM-919: joining and leaving change the `machineMap` setting, so only the desktop app may. */
export const requireLocalDesktop = (client: { readonly desktop: boolean }) =>
  client.desktop
    ? Effect.void
    : Effect.fail(
        new MachineMapRequestError({
          reason: "desktop-only",
          detail: "Only the desktop app of this machine joins or leaves the map.",
        }),
      );
