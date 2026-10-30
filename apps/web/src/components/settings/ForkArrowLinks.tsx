import { ARROW_LINKS_ACTION, kitshnMapUrl } from "@t3tools/client-runtime/fork/arrowLinks";
import { ExternalLinkIcon } from "lucide-react";

import { Button } from "../ui/button";

/** Fork: MM-1921 on kitshn. Links come from the reach, so Connections points to the kitshn map. */
export function ArrowLinksPortalLink() {
  // The map of the zone of this page's T3 host; a page outside a zone has no map to open.
  const mapUrl = kitshnMapUrl(window.location.origin);
  if (mapUrl === null) return null;
  return (
    <Button
      size="xs"
      variant="outline"
      render={<a href={mapUrl} target="_blank" rel="noreferrer" />}
    >
      <ExternalLinkIcon className="size-3" />
      {ARROW_LINKS_ACTION}
    </Button>
  );
}
