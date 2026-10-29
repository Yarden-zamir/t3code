/**
 * Fork: MM-1921 on kitshn (K-1609): links to other machines come only from the kitshn reach, so
 * Connections shows them read-only on web, desktop and mobile, with a link to the kitshn map.
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

export const ARROW_LINKS_ACTION = "Change access on the map";

export const ARROW_LINKS_EMPTY =
  "Agents here work on another machine through a kitshn link. The owner shares that machine's T3 app and T3 agents cards with this machine on the kitshn map.";

/** The kitshn map of the zone of a T3 host (`https://t3-<machine>.<zone>`), or null. */
export const kitshnMapUrl = (origin: string): string | null => {
  const host = URL.parse(origin)?.hostname ?? "";
  const dot = host.indexOf(".");
  return host.startsWith("t3-") && dot > 0 ? `https://kit.${host.slice(dot + 1)}` : null;
};

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
