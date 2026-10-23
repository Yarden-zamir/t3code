import { ARROW_LINKS_ACTION } from "@t3tools/client-runtime/fork/arrowLinks";
import { DEFAULT_MACHINE_MAP_PORTAL_URL, type EnvironmentId } from "@t3tools/contracts";
import { ExternalLinkIcon } from "lucide-react";

import { useEnvironments } from "~/state/environments";
import { Button } from "../ui/button";

/** Fork: MM-1921. Links come from the arrows, so Connections points to the portal of the map. */
export function ArrowLinksPortalLink({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const { environments } = useEnvironments();
  const portalUrl =
    environments.find((environment) => environment.environmentId === environmentId)?.serverConfig
      ?.settings.machineMap.portalUrl ?? DEFAULT_MACHINE_MAP_PORTAL_URL;
  return (
    <Button
      size="xs"
      variant="outline"
      render={<a href={portalUrl} target="_blank" rel="noreferrer" />}
    >
      <ExternalLinkIcon className="size-3" />
      {ARROW_LINKS_ACTION}
    </Button>
  );
}
