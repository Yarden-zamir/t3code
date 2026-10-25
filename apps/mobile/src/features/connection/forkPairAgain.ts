/**
 * Fork: a direct connection whose pairing expired or was revoked cannot reconnect with "Retry
 * now", because the saved session stays refused. It offers "Pair again" instead, which opens
 * Add environment. An app token environment pairs again by itself (connection/forkAppTokenRepair.ts),
 * and its repair message replaces this one.
 */
import { useNavigation } from "@react-navigation/native";
import { useCallback } from "react";

import { openSettings } from "../settings/settings-navigation";

/** Opens Add environment, where a new pairing link or invite pairs the environment again. */
export function usePairAgain(): () => void {
  const navigation = useNavigation();
  return useCallback(
    () => openSettings(navigation, "SettingsEnvironmentNew"),
    [navigation],
  );
}
