import { useAtomValue } from "@effect/atom-react";
import {
  type AccessChangeNotice,
  createAccessChangeTracker,
} from "@t3tools/client-runtime/fork/accessChange";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { useEnvironments } from "../state/environments";
import { useMachineMapState } from "../state/machineMap";
import { serverEnvironment } from "../state/server";
import { environmentSession } from "../state/session";
import { toastManager } from "./ui/toast";

/** One tracker for the app session, so a remount does not count as the first value. */
const tracker = createAccessChangeTracker();

function showNotice(notice: AccessChangeNotice) {
  toastManager.add({ type: "info", title: notice.title, description: notice.description });
}

/** `accessChangeNotices` of an environment. Unknown settings count as the default, on. */
const noticesEnabled = (settings: { readonly accessChangeNotices: boolean } | null) =>
  settings?.accessChangeNotices !== false;

/** Fork: MM-1401. The desktop app removed a machine because its arrow is gone. */
export function noticeAccessEnded(environmentId: EnvironmentId, label: string) {
  const notice = tracker.observeEnded(environmentId, label);
  if (notice === null) return;
  if (noticesEnabled(appAtomRegistry.get(serverEnvironment.settingsValueAtom(environmentId)))) {
    showNotice(notice);
  }
}

function EnvironmentAccessWatcher(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}) {
  const { environmentId, label } = props;
  const session = useAtomValue(environmentSession.sessionStateAtom(environmentId));
  const desired = useMachineMapState(environmentId).state?.desired ?? null;
  const enabled = noticesEnabled(useAtomValue(serverEnvironment.settingsValueAtom(environmentId)));

  // The tracker sees every value, also with notices off, so turning them on starts from now.
  useEffect(() => {
    if (session._tag !== "Success" || session.waiting) return;
    const notice = tracker.observeSession(environmentId, label, session.value);
    if (notice !== null && enabled) showNotice(notice);
  }, [enabled, environmentId, label, session]);

  useEffect(() => {
    if (desired === null) return;
    for (const notice of tracker.observeLinks(environmentId, desired, Date.now())) {
      if (enabled) showNotice(notice);
    }
  }, [desired, enabled, environmentId]);

  return null;
}

/** Fork: `accessChangeNotices`. A toast when the machine map changes access, without a reload. */
export function ForkAccessChangeNotices() {
  const { environments } = useEnvironments();
  return environments.map(({ environmentId, label }) => (
    <EnvironmentAccessWatcher key={environmentId} environmentId={environmentId} label={label} />
  ));
}
