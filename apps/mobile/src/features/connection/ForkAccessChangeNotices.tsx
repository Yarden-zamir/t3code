import { useAtomValue } from "@effect/atom-react";
import { createEnvironmentRpcSubscriptionAtomFamily } from "@t3tools/client-runtime/state/runtime";
import type { AccessChangeNotice } from "@t3tools/client-runtime/fork/accessChange";
import { type EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useEffect } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { environmentSession } from "../../state/session";
import * as Dialog from "../../components/ui/Dialog";
import {
  accessChangeEnvironments,
  accessChangeTracker,
  setAccessChangeNoticeHandler,
} from "./forkAccessChangeTracker";

function showAccessChangeNotice(notice: AccessChangeNotice) {
  Dialog.alert(notice.title, notice.description, [{ text: "OK" }]);
}

setAccessChangeNoticeHandler(showAccessChangeNotice);

const machineMapState = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "mobile:fork-access-change:machine-map-state",
  tag: WS_METHODS.machineMapSubscribe,
});

function EnvironmentAccessWatcher(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}) {
  const { environmentId, label } = props;
  const session = useAtomValue(environmentSession.sessionStateAtom(environmentId));
  const mapState = useAtomValue(machineMapState({ environmentId, input: {} }));
  const desired = Option.getOrNull(AsyncResult.value(mapState))?.desired ?? null;
  // Unknown settings count as the default, on.
  const enabled =
    useAtomValue(serverEnvironment.settingsValueAtom(environmentId))?.accessChangeNotices !== false;

  useEffect(() => {
    accessChangeEnvironments.set(environmentId, { label, enabled });
  }, [enabled, environmentId, label]);

  // The tracker sees every value, also with notices off, so turning them on starts from now.
  useEffect(() => {
    if (session._tag !== "Success" || session.waiting) return;
    const notice = accessChangeTracker.observeSession(environmentId, label, session.value);
    if (notice !== null && enabled) showAccessChangeNotice(notice);
  }, [enabled, environmentId, label, session]);

  useEffect(() => {
    if (desired === null) return;
    for (const notice of accessChangeTracker.observeLinks(environmentId, desired, Date.now())) {
      if (enabled) showAccessChangeNotice(notice);
    }
  }, [desired, enabled, environmentId]);

  return null;
}

/** Fork: `accessChangeNotices`. A popup when the machine map changes access, without a reload. */
export function ForkAccessChangeNotices() {
  const { environments } = useEnvironments();
  return environments.map(({ environmentId, label }) => (
    <EnvironmentAccessWatcher key={environmentId} environmentId={environmentId} label={label} />
  ));
}
