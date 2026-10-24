import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useCallback } from "react";

import {
  resolveVoicePreferences,
  type ResolvedVoicePreferences,
  type VoicePreferences,
} from "../persistence/forkVoicePreferences";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "./preferences";

/** Fork: the assistant panel and read-aloud options, with defaults while they load. */
export function useVoicePreferences(): ResolvedVoicePreferences {
  const preferences = useAtomValue(mobilePreferencesAtom);
  return resolveVoicePreferences(
    AsyncResult.isSuccess(preferences) ? preferences.value.voice : undefined,
  );
}

/** Merges into the stored `voice` key; a plain patch would replace the whole key. */
export function useUpdateVoicePreferences(): (patch: Partial<VoicePreferences>) => void {
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  return useCallback(
    (patch) =>
      savePreferences({ transform: (current) => ({ voice: { ...current.voice, ...patch } }) }),
    [savePreferences],
  );
}
