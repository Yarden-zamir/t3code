import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useCallback } from "react";

import {
  resolveVoicePreferences,
  type ResolvedVoicePreferences,
  type VoicePreferences,
} from "../persistence/forkVoicePreferences";
import { mobilePreferencesAtom } from "./preferences";
import { saveMobilePreferencesInBackground } from "./forkSavePreferences";

/** Fork: the assistant panel and read-aloud options, with defaults while they load. */
export function useVoicePreferences(): ResolvedVoicePreferences {
  const preferences = useAtomValue(mobilePreferencesAtom);
  return resolveVoicePreferences(
    AsyncResult.isSuccess(preferences) ? preferences.value.voice : undefined,
  );
}

/** Merges into the stored `voice` key; a plain patch would replace the whole key. */
export function useUpdateVoicePreferences(): (patch: Partial<VoicePreferences>) => void {
  return useCallback(
    (patch) =>
      saveMobilePreferencesInBackground({
        transform: (current) => ({ voice: { ...current.voice, ...patch } }),
      }),
    [],
  );
}
