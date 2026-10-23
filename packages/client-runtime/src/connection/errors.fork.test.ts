import { EnvironmentAuthInvalidError } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  MACHINE_PAUSED_MESSAGE,
  mapRemoteDpopEnvironmentError,
  mapRemoteEnvironmentError,
  PAIRING_REVOKED_MESSAGE,
} from "./errors.ts";

describe("mapRemoteEnvironmentError", () => {
  it("says that a refused direct session needs a new pairing", () => {
    const error = new EnvironmentAuthInvalidError({
      code: "auth_invalid",
      reason: "invalid_credential",
      traceId: "trace-direct",
    });
    const mapped = mapRemoteEnvironmentError(error);
    expect(mapped._tag).toBe("ConnectionBlockedError");
    expect(mapped.message).toBe(PAIRING_REVOKED_MESSAGE);
  });
});

describe("machine map pause (MM-718)", () => {
  it("keeps the credential and retries, on every route", () => {
    const error = new EnvironmentAuthInvalidError({
      code: "auth_invalid",
      reason: "machine_paused",
      traceId: "trace-paused",
    });
    for (const mapped of [
      mapRemoteEnvironmentError(error),
      mapRemoteEnvironmentError(error, "relay"),
      mapRemoteDpopEnvironmentError(error),
    ]) {
      expect(mapped).toMatchObject({
        _tag: "ConnectionTransientError",
        detail: MACHINE_PAUSED_MESSAGE,
      });
    }
  });
});
