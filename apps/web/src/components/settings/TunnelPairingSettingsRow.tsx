import { AuthEnvironmentMaintainScope } from "@t3tools/contracts";
import { useState } from "react";

import { isLocalEnvironmentDisabled } from "../../localEnvironment";
import {
  desktopNetworkAccessStateAtom,
  refreshDesktopNetworkAccessState,
} from "~/state/desktopNetworkAccess";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

/**
 * Fork: tunnel pairing and the trusted browser origins of the desktop server. Desktop settings, so the row shows only in the desktop app that manages its backend.
 */
export function TunnelPairingSettingsRow() {
  const desktopBridge = window.desktopBridge;
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const canMaintain = useEnvironmentScope(primaryEnvironmentId, AuthEnvironmentMaintainScope);
  const canManageLocalBackend = !isLocalEnvironmentDisabled() && canMaintain;
  const desktopNetworkAccess = useEnvironmentQuery(
    canManageLocalBackend && desktopBridge ? desktopNetworkAccessStateAtom : null,
  );
  const desktopServerExposureState = desktopNetworkAccess.data?.serverExposureState ?? null;
  const [isUpdatingTunnelPairing, setIsUpdatingTunnelPairing] = useState(false);
  // Fork: null until the user edits the field; the saved URL shows until then.
  const [tunnelPairingUrlInput, setTunnelPairingUrlInput] = useState<string | null>(null);
  const [trustedOriginsInput, setTrustedOriginsInput] = useState<string | null>(null);

  const handleTunnelPairingChange = async (input: {
    readonly enabled: boolean;
    readonly url: string | null;
    readonly trustedBrowserOrigins: string | null;
  }) => {
    if (
      !desktopBridge ||
      primaryEnvironmentId === null ||
      !readEnvironmentScope(primaryEnvironmentId, AuthEnvironmentMaintainScope)
    )
      return;
    setIsUpdatingTunnelPairing(true);
    // A promise handler, not try/finally: the React Compiler skips a component with `finally`.
    const error = await desktopBridge.setTunnelPairing(input).then(
      () => null,
      (cause: unknown) => cause ?? new Error("Failed to update tunnel pairing."),
    );
    setIsUpdatingTunnelPairing(false);
    if (error === null) {
      refreshDesktopNetworkAccessState();
      setTunnelPairingUrlInput(null);
      setTrustedOriginsInput(null);
      return;
    }
    const message = error instanceof Error ? error.message : "Failed to update tunnel pairing.";
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not update tunnel pairing",
        description: message,
      }),
    );
  };

  if (!canManageLocalBackend || !desktopBridge) return null;

  const savedTunnelPairingUrl = desktopServerExposureState?.tunnelPairingUrl ?? null;
  const tunnelPairingUrlValue = tunnelPairingUrlInput ?? savedTunnelPairingUrl ?? "";
  const savedTrustedOrigins = desktopServerExposureState?.trustedBrowserOrigins ?? null;
  const trustedOriginsValue = trustedOriginsInput ?? savedTrustedOrigins ?? "";
  const tunnelPairingTextInput = () => {
    const url = tunnelPairingUrlValue.trim();
    const origins = trustedOriginsValue.trim();
    return {
      url: url.length > 0 ? url : null,
      trustedBrowserOrigins: origins.length > 0 ? origins : null,
    };
  };
  return (
    <SettingsRow
      {...searchableSetting("tunnel-pairing")}
      description={
        <>
          <span className="block">
            The server stays on 127.0.0.1. Point a tunnel such as cloudflared at it, then pair with
            a token from <code>t3 pair</code> through the tunnel URL. T3 Code restarts when this
            changes.
          </span>
          <Input
            className="mt-2 max-w-sm"
            value={tunnelPairingUrlValue}
            onChange={(event) => setTunnelPairingUrlInput(event.target.value)}
            onBlur={() => {
              const url = tunnelPairingUrlValue.trim();
              if (url === (savedTunnelPairingUrl ?? "")) return;
              void handleTunnelPairingChange({
                enabled: desktopServerExposureState?.tunnelPairingEnabled ?? false,
                ...tunnelPairingTextInput(),
              });
            }}
            placeholder="Tunnel URL, for example https://t3.example.com"
            aria-label="Tunnel URL"
            disabled={isUpdatingTunnelPairing}
            spellCheck={false}
          />
          <Textarea
            className="mt-2 max-w-sm"
            value={trustedOriginsValue}
            onChange={(event) => setTrustedOriginsInput(event.target.value)}
            onBlur={() => {
              if (trustedOriginsValue.trim() === (savedTrustedOrigins ?? "")) return;
              void handleTunnelPairingChange({
                enabled: desktopServerExposureState?.tunnelPairingEnabled ?? false,
                ...tunnelPairingTextInput(),
              });
            }}
            placeholder="Trusted web origins, for example https://t3-vps.example.com"
            aria-label="Trusted web origins"
            disabled={isUpdatingTunnelPairing}
            spellCheck={false}
            rows={2}
          />
          <span className="mt-1 block">
            Trusted web origins: T3 Code pages on these https origins (comma or newline separated)
            may call this server with their cookies, for example behind Cloudflare Access.
          </span>
        </>
      }
      control={
        <Switch
          checked={desktopServerExposureState?.tunnelPairingEnabled ?? false}
          disabled={isUpdatingTunnelPairing || tunnelPairingUrlValue.trim().length === 0}
          onCheckedChange={(checked) => {
            void handleTunnelPairingChange({ enabled: checked, ...tunnelPairingTextInput() });
          }}
          aria-label="Allow pairing through a tunnel"
        />
      }
    />
  );
}
