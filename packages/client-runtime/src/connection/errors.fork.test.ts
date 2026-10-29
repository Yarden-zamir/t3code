import { EnvironmentAuthInvalidError } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { mapRemoteEnvironmentError, PAIRING_REVOKED_MESSAGE } from "./errors.ts";

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
