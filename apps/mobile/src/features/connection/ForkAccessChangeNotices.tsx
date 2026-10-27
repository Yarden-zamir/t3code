import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useEffect } from "react";

import * as Dialog from "../../components/ui/Dialog";
import { useEnvironments } from "../../state/environments";
import { machineMapState } from "../../state/forkMachineMap";
import { serverEnvironment } from "../../state/server";
import { environmentSession } from "../../state/session";
import {
  accessChangeEnvironments,
  accessChangeTracker,
  setAccessChangeNoticePresenter,
  showAccessChangeNotices,
} from "./forkAccessChangeTracker";

setAccessChangeNoticePresenter((notice) =>
  Dialog.alert(notice.title, notice.description, [{ text: "OK" }]),
);

/** Only while notices are on: the map subscription sends the whole state on each change. */
function EnvironmentLinkWatcher(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const result = useAtomValue(machineMapState({ environmentId, input: {} }));
  const state = Option.getOrNull(AsyncResult.value(result));

  useEffect(() => {
    if (state === null) return;
    showAccessChangeNotices(accessChangeTracker.observeLinks(environmentId, state));
  }, [environmentId, state]);

  useEffect(() => () => accessChangeTracker.forgetLinks(environmentId), [environmentId]);

  return null;
}

function EnvironmentAccessWatcher(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}) {
  const { environmentId, label } = props;
  const session = useAtomValue(environmentSession.sessionStateAtom(environmentId));
  // Unknown settings count as the default, off.
  const enabled =
    useAtomValue(serverEnvironment.settingsValueAtom(environmentId))?.accessChangeNotices === true;

  useEffect(() => {
    accessChangeEnvironments.set(environmentId, { label, enabled });
  }, [enabled, environmentId, label]);

  // The session state is loaded anyway, so the tracker sees every value, also with notices off.
  useEffect(() => {
    if (session._tag !== "Success" || session.waiting) return;
    const notice = accessChangeTracker.observeSession(environmentId, label, session.value);
    if (notice !== null && enabled) showAccessChangeNotices([notice]);
  }, [enabled, environmentId, label, session]);

  return enabled ? <EnvironmentLinkWatcher environmentId={environmentId} /> : null;
}

/** Fork: `accessChangeNotices`. A popup when the machine map changes access, without a reload. */
export function ForkAccessChangeNotices() {
  const { environments } = useEnvironments();
  return environments.map(({ environmentId, label }) => (
    <EnvironmentAccessWatcher key={environmentId} environmentId={environmentId} label={label} />
  ));
}
