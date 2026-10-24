import * as Speech from "expo-speech";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../../state/atom-registry";
import { markdownToSpeech, splitForSpeech } from "./speechText";

/** Fork: the id of the message that is read aloud now, or null. */
export const readingAloudIdAtom = Atom.make<string | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:read-aloud:reading-id"),
);

// Android reports about 4000 characters; iOS reports no real limit. Short parts also let
// the first words start sooner.
const MAX_PART_LENGTH = Math.min(Speech.maxSpeechInputLength, 3000);

let generation = 0;

/** Stops what plays now and reads the markdown aloud. Resolves nothing; the atom tracks the end. */
export function readAloud(input: {
  readonly id: string;
  readonly markdown: string;
  readonly rate: number;
}): void {
  const run = ++generation;
  void Speech.stop();
  const parts = splitForSpeech(markdownToSpeech(input.markdown), MAX_PART_LENGTH);
  if (parts.length === 0) {
    appAtomRegistry.set(readingAloudIdAtom, null);
    return;
  }
  appAtomRegistry.set(readingAloudIdAtom, input.id);
  const finish = () => {
    if (run === generation) appAtomRegistry.set(readingAloudIdAtom, null);
  };
  parts.forEach((part, index) => {
    Speech.speak(part, {
      rate: input.rate,
      onStopped: finish,
      onError: finish,
      ...(index === parts.length - 1 ? { onDone: finish } : {}),
    });
  });
}

export function stopReadingAloud(): void {
  generation += 1;
  appAtomRegistry.set(readingAloudIdAtom, null);
  void Speech.stop();
}
