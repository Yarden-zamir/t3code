/**
 * The fork parts of `ConnectionsSettings.tsx`: the Cloudflare Access refusal message, the kitshn
 * mark of a saved environment and the sibling sign-in rows. The upstream file imports this module
 * once and keeps one line per hook.
 */
import {
  CLOUDFLARE_ACCESS_MESSAGE,
  type ConnectionCatalogEntry,
  connectionRoutes,
  requestHeaderOrigin,
} from "@t3tools/client-runtime/connection";
import { useEffect, useState } from "react";

import { type SiblingIssue, useSiblingIssues } from "~/connection/siblingEnvironments";
import { Button } from "../ui/button";
import { SettingsRow } from "./settingsLayout";

export { ForkSettingsSlot } from "./ForkSettingsSlot";

/** The distinct origins of an environment's direct (bearer) routes. */
function environmentOrigins(entry: ConnectionCatalogEntry): ReadonlyArray<string> {
  const origins = connectionRoutes(entry).flatMap((route) =>
    route.profile._tag === "Some" && route.profile.value._tag === "BearerConnectionProfile"
      ? (requestHeaderOrigin(route.profile.value.httpBaseUrl) ?? [])
      : [],
  );
  return [...new Set(origins)];
}

/** Asks the desktop app whether the last response from `url` was a Cloudflare Access login. */
async function isCloudflareAccessChallenged(url: string): Promise<boolean> {
  const query = window.desktopBridge?.isCloudflareAccessChallenged;
  if (query === undefined) return false;
  return query(url).catch(() => false);
}

/**
 * True while an origin of `entry` answered with a Cloudflare Access login, for example after kitshn
 * refused the device token. Re-checks when the connection error changes.
 */
export function useAccessChallenged(
  entry: ConnectionCatalogEntry,
  connectionError: string | null,
): boolean {
  const [challenged, setChallenged] = useState(false);
  const originsKey = environmentOrigins(entry).join(" ");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the desktop main process, outside React.
  useEffect(() => {
    if (connectionError === null || originsKey === "") return;
    let cancelled = false;
    void Promise.all(originsKey.split(" ").map(isCloudflareAccessChallenged)).then((results) => {
      if (!cancelled) setChallenged(results.some(Boolean));
    });
    return () => {
      cancelled = true;
    };
  }, [connectionError, originsKey]);
  return connectionError !== null && originsKey !== "" && challenged;
}

/** The line that the row subtitle adds while Cloudflare Access asks for a sign-in. */
export const accessChallengeSubtitle = (show: boolean) =>
  show ? `\n${CLOUDFLARE_ACCESS_MESSAGE}` : "";

export function AccessChallengeMessage({ show }: { readonly show: boolean }) {
  return show ? <p className="mt-1 text-xs text-destructive">{CLOUDFLARE_ACCESS_MESSAGE}</p> : null;
}

// Siblings that kitshn links and that could not pair yet. Most often the browser has no
// Cloudflare Access cookie for them: opening one signs in, and the page tries
// again when it gets focus.
const SIBLING_ISSUE_TEXT: Record<SiblingIssue, { title: string; description: string }> = {
  "sign-in": {
    title: "Sign in at",
    description: "Open it once to sign in with Cloudflare Access, then come back to this tab.",
  },
};

export function SiblingSignInRows() {
  const issues = useSiblingIssues();
  return [...issues].map(([origin, issue]) => (
    <SettingsRow
      key={origin}
      title={`${SIBLING_ISSUE_TEXT[issue].title} ${origin}`}
      description={SIBLING_ISSUE_TEXT[issue].description}
      control={
        <Button
          size="xs"
          variant="outline"
          render={<a href={origin} target="_blank" rel="noreferrer" />}
        >
          Open
        </Button>
      }
    />
  ));
}
