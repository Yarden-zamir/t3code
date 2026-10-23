import { ARROW_LINKS_ACTION } from "@t3tools/client-runtime/fork/arrowLinks";
import { DEFAULT_MACHINE_MAP_PORTAL_URL } from "@t3tools/contracts";
import { Linking, Pressable } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";

/** Fork: MM-1921. Links come from the arrows, so Connections points to the portal of the map. */
export function ArrowLinksPortalLink(props: { readonly portalUrl: string | undefined }) {
  const url = props.portalUrl ?? DEFAULT_MACHINE_MAP_PORTAL_URL;
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityHint="Opens the machine map portal"
      onPress={() => void Linking.openURL(url).catch(() => undefined)}
      className="min-h-11 flex-row items-center gap-1 px-4 active:opacity-60"
    >
      <Text textRole="footnote" className="font-t3-medium text-primary-text">
        {ARROW_LINKS_ACTION}
      </Text>
      <SymbolView
        name="arrow.up.right"
        size={12}
        tintColorClassName={"accent-primary-text"}
        type="monochrome"
        weight="semibold"
      />
    </Pressable>
  );
}
