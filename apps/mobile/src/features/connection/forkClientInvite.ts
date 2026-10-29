import { useEffect } from "react";

import { parseDeviceInvite } from "@t3tools/client-runtime/fork/deviceInvite";

export const forkClientInviteAddress = (value: string | undefined) =>
  value && parseDeviceInvite(value) ? value : null;

/** An invite link only fills Address. The owner must still tap Add environment to redeem it. */
export function useForkClientInvite(
  value: string | undefined,
  setAddress: (value: string) => void,
) {
  useEffect(() => {
    const address = forkClientInviteAddress(value);
    if (address) setAddress(address);
  }, [value, setAddress]);
}
