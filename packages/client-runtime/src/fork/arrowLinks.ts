/**
 * Fork: machine map. MM-1921: links to other machines come only from the portal arrows, so
 * Connections shows them read-only on web, desktop and mobile, with a link to the portal.
 */
import { ARROW_LINK_NO_EXPIRY, type PeerLinkSummary } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { PeerLinkHealth } from "../state/peerLinks.ts";

/**
 * A fork server refuses manual links, so a fork client never offers Link or Forget. Known limit:
 * a fork client that connects to an upstream server cannot link there either. Revisit if fork
 * clients connect to upstream servers.
 */
export const MANUAL_PEER_LINKS = false;

export const ARROW_LINKS_ACTION = "Set arrows in the portal";

export const ARROW_LINKS_EMPTY =
  "Agents here work on another machine through an arrow with agent tools from this machine. Set arrows in the portal.";

const endFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** A permanent arrow reports `ARROW_LINK_NO_EXPIRY`, so only a temporary arrow has an end. */
const arrowEnd = (link: PeerLinkSummary): string | null =>
  DateTime.formatIso(link.expiresAt) === ARROW_LINK_NO_EXPIRY
    ? null
    : endFormat.format(DateTime.toDateUtc(link.expiresAt));

/** The status line of an arrow link. Renewal happens in the portal, never with a new pairing. */
export function arrowLinkStatus(link: PeerLinkSummary, health: PeerLinkHealth): string {
  switch (health.kind) {
    case "expired":
      return "The arrow ended. Renew it in the portal.";
    case "unreachable":
      return health.detail ?? "Not answering right now.";
    case "failing":
      return health.detail;
    case "reachable": {
      const end = arrowEnd(link);
      return end === null ? "Reachable" : `Reachable until ${end}. Renew it in the portal.`;
    }
  }
}
