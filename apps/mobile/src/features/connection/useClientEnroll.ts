/**
 * Fork: uses a kitshn device invite (K-1601) from Add environment. The app saves the invite's
 * Cloudflare Access service token for kitshn and every machine, then pairs with each machine. A
 * failed machine does not stop the others; the app token repair pairs it later.
 */
import { requestHeaderOrigin } from "@t3tools/client-runtime/connection";
import { useAtomSet } from "@effect/atom-react";
import { StackActions, useNavigation } from "@react-navigation/native";
import * as Haptics from "expo-haptics";
import { useCallback } from "react";

import {
  type DeviceEnrollResult,
  type DeviceInvite,
  enrollWithDeviceInvite,
  exchangeDeviceInvite,
  parseDeviceInvite,
} from "@t3tools/client-runtime/fork/deviceInvite";

import {
  deviceName,
  issueMachinePairingCredential,
  kitshnTransport,
} from "../../connection/clientEnroll";
import { requestAppTokenSync } from "../../connection/forkAppTokenRepair";
import { updateMobilePreferencesAtom } from "../../state/preferences";
import { useRemoteConnections } from "../../state/use-remote-environment-registry";
import { useSaveCloudflareAccessToken } from "./CloudflareAccessFields";
import { buildPairingUrl } from "./pairing";

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function useEnrollClient() {
  const saveToken = useSaveCloudflareAccessToken();
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const { onConnectPress } = useRemoteConnections();
  return useCallback(
    (invite: DeviceInvite): Promise<DeviceEnrollResult> =>
      enrollWithDeviceInvite(invite, {
        exchange: (next) => exchangeDeviceInvite(next, deviceName(), kitshnTransport),
        origin: requestHeaderOrigin,
        saveToken: async (origin, token) => {
          const saved = await saveToken(origin, token);
          if ("error" in saved) throw new Error(saved.error);
        },
        saveClient: (client) => savePreferences({ appTokenClient: client }),
        pair: async (machine) => {
          const credential = await issueMachinePairingCredential(machine.origin);
          const outcome = await onConnectPress(buildPairingUrl(machine.origin, credential));
          if (!outcome.ok) throw new Error(outcome.error ?? "Could not pair with the machine.");
        },
      }),
    [onConnectPress, savePreferences, saveToken],
  );
}

/**
 * Returns `enrollInvite(text)`. It starts the enroll and returns true when
 * `text` is a kitshn device invite, and returns false for any other text.
 */
export function useClientEnroll(
  setSubmitting: (submitting: boolean) => void,
  setError: (error: string | null) => void,
) {
  const enrollClient = useEnrollClient();
  const navigation = useNavigation();
  const run = useCallback(
    async (invite: DeviceInvite) => {
      setSubmitting(true);
      setError(null);
      // No `finally`: the React Compiler cannot compile a try/finally.
      let result: Awaited<ReturnType<typeof enrollClient>>;
      try {
        result = await enrollClient(invite);
      } catch (cause) {
        setSubmitting(false);
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        setError(message(cause));
        return;
      }
      setSubmitting(false);
      // The saved app token stays; the repair pairs the machines that failed or come later.
      requestAppTokenSync();
      const failures = result.failed.map((entry) => `${entry.name}: ${entry.reason}`);
      if (result.paired.length > 0 && failures.length === 0) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        // Same as Add environment: return to what opened the sheet, so Home never nests in a sheet.
        if (navigation.canGoBack()) navigation.goBack();
        else navigation.dispatch(StackActions.replace("Home"));
        return;
      }
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError(
        result.paired.length === 0 && failures.length === 0
          ? `"${result.name}" has no machines yet. Share T3 app cards with it on the kitshn map; this phone then adds them by itself.`
          : [
              `Paired: ${result.paired.join(", ") || "none"}.`,
              ...failures,
              "This phone keeps the app token and tries the other machines again by itself.",
            ].join("\n"),
      );
    },
    [enrollClient, navigation, setError, setSubmitting],
  );
  return useCallback(
    (text: string): boolean => {
      const invite = parseDeviceInvite(text);
      if (invite === null) return false;
      void run(invite);
      return true;
    },
    [run],
  );
}
