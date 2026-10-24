import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { type MachineMapConnectionStatus, MachineMapRequestError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { joinMachineMap, leaveMachineMap, useMachineMapState } from "../../state/machineMap";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";

const STATUS_BADGES: Record<
  MachineMapConnectionStatus,
  { readonly label: string; readonly variant: "outline" | "warning" | "success" }
> = {
  off: { label: "Off", variant: "outline" },
  "not-joined": { label: "Not joined", variant: "outline" },
  connecting: { label: "Connecting", variant: "warning" },
  online: { label: "Online", variant: "success" },
};

const isMachineMapRequestError = Schema.is(MachineMapRequestError);

function failureMessage(result: Parameters<typeof squashAtomCommandFailure>[0]): string {
  const error = squashAtomCommandFailure(result);
  if (isMachineMapRequestError(error)) return error.detail;
  return error instanceof Error ? error.message : "The request failed.";
}

/** The machine map connection of the selected environment: status, join, and leave. */
export function MachineMapSettingsRows() {
  const { environment } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const { state, error } = useMachineMapState(environmentId);
  const canJoin = useAtomValue(joinMachineMap.permissionAtom(environmentId));
  const canLeave = useAtomValue(leaveMachineMap.permissionAtom(environmentId));
  const join = useAtomCommand(joinMachineMap, { reportFailure: false });
  const leave = useAtomCommand(leaveMachineMap, { reportFailure: false });
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);

  if (environmentId === null) return null;
  if (state === null) {
    return (
      <SettingsRow
        {...searchableSetting("machine-map")}
        description={
          error === null
            ? "Loading the machine map..."
            : `This environment does not show the machine map. ${error}`
        }
      />
    );
  }

  const status = STATUS_BADGES[state.connection.status];
  const selfName = state.desired?.self.name ?? null;
  const trimmedCode = code.trim();

  const submitJoin = async () => {
    if (trimmedCode.length === 0 || busy) return;
    setBusy(true);
    setRequestError(null);
    const result = await join({ environmentId, input: { code: trimmedCode } });
    setBusy(false);
    if (result._tag === "Failure") setRequestError(failureMessage(result));
    else setCode("");
  };

  const submitLeave = async () => {
    if (busy) return;
    // Fail closed: no mounted confirm host means no leave.
    const confirmed = await requestConfirmDialog(
      "Leave the machine map?\nThis machine forgets its machine token, and other machines lose their access to it.",
      { variant: "destructive" },
    );
    if (confirmed !== true) return;
    setBusy(true);
    setRequestError(null);
    const result = await leave({ environmentId, input: {} });
    setBusy(false);
    if (result._tag === "Failure") setRequestError(failureMessage(result));
  };

  return (
    <>
      <SettingsRow
        {...searchableSetting("machine-map")}
        description={
          selfName === null
            ? "One portal controls what each machine can do on the other machines."
            : `This machine is ${selfName} on the map.`
        }
        status={
          state.connection.lastError === null
            ? `Since ${formatRelativeTimeLabel(state.connection.since)}`
            : `Last error: ${state.connection.lastError}`
        }
        control={
          <div className="flex items-center gap-2">
            <Badge variant={status.variant}>{status.label}</Badge>
            <Button
              size="sm"
              variant="outline"
              render={<a href={state.portalUrl} target="_blank" rel="noreferrer" />}
            >
              Open portal
            </Button>
          </div>
        }
      />
      {state.joined ? (
        <SettingsRow
          title="Leave the map"
          description="Forget the machine token and turn the machine map off."
          control={
            <Button
              size="sm"
              variant="destructive-outline"
              disabled={!canLeave || busy}
              onClick={() => void submitLeave()}
            >
              Leave
            </Button>
          }
        />
      ) : (
        <SettingsRow
          title="Join the map"
          description="In the portal, Add machine shows a one-time join code."
          control={
            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void submitJoin();
              }}
            >
              <Input
                size="sm"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder="Join code"
                aria-label="Join code"
                autoComplete="off"
                disabled={!canJoin || busy}
              />
              <Button size="sm" type="submit" disabled={!canJoin || busy || trimmedCode === ""}>
                Join
              </Button>
            </form>
          }
        />
      )}
      {requestError === null ? null : (
        <SettingsRow title="Request failed" description={requestError} />
      )}
    </>
  );
}
