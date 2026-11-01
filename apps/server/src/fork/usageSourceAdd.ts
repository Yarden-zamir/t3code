import { UsageLimitSourceError, UsageLimitSourceId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import * as Settings from "../serverSettings.ts";
import { MAX_USAGE_SOURCE_KEY_BYTES } from "./usageSourceKey.ts";

export type AddUsageSource = (input: {
  readonly url: string;
  readonly label?: string;
  readonly managementKey: string;
}) => Effect.Effect<{ readonly id: UsageLimitSourceId }, UsageLimitSourceError>;

export function localUsageHubUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "127.0.0.1" || url.hostname === "[::1]") &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    )
      return url.href;
  } catch {
    return undefined;
  }
  return undefined;
}

export const makeUsageSourceAdd = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const settings = yield* Settings.ServerSettingsService;
  const lock = yield* Semaphore.make(1);
  return Effect.fn("UsageLimitSources.add")(function* (input: Parameters<AddUsageSource>[0]) {
    const url = localUsageHubUrl(input.url);
    if (url === undefined)
      return yield* new UsageLimitSourceError({ detail: "Use a loopback IP hub URL." });
    const managementKey = input.managementKey.trim();
    if (
      !managementKey ||
      new TextEncoder().encode(managementKey).byteLength > MAX_USAGE_SOURCE_KEY_BYTES ||
      ["\r", "\n", "\0"].some((character) => managementKey.includes(character))
    ) {
      return yield* new UsageLimitSourceError({
        detail: "The management key is empty or invalid.",
      });
    }
    const current = yield* settings.getSettings.pipe(
      Effect.mapError(() => new UsageLimitSourceError({ detail: "Could not read hub settings." })),
    );
    const existing = Object.entries(current.usageLimitSources).find(
      ([, source]) => localUsageHubUrl(source.url) === url,
    );
    if (existing) {
      const [id, source] = existing;
      if (source.enabled && source.managementKey === managementKey && source.label === input.label)
        return { id: UsageLimitSourceId.make(id) };
      return yield* new UsageLimitSourceError({
        detail: "That hub URL is already configured. Change it in Settings.",
      });
    }
    const id = UsageLimitSourceId.make(
      `cliproxy-${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`,
    );
    yield* settings
      .updateSettings({
        usageLimitSources: {
          [id]: {
            kind: "cliproxy",
            url,
            ...(input.label ? { label: input.label } : {}),
            managementKey,
            enabled: true,
          },
        },
      })
      .pipe(Effect.mapError(() => new UsageLimitSourceError({ detail: "Could not add the hub." })));
    return { id };
  }, lock.withPermits(1));
});
