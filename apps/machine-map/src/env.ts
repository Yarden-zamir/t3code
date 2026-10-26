import type { MachineMapObject } from "./MachineMapObject.ts";

/** Bindings, vars and secrets of the Worker. See `wrangler.jsonc` and the README. */
export interface Env {
  readonly MAP: DurableObjectNamespace<MachineMapObject>;
  readonly TEAM_DOMAIN: string;
  readonly OWNER_EMAILS: string;
  readonly ACCOUNT_ID: string;
  /** MM-213: machine tunnels get the hostname `t3-<slug>.<MACHINE_DOMAIN>` in this DNS zone. */
  readonly MACHINE_DOMAIN?: string;
  readonly MACHINE_ZONE_ID?: string;
  /**
   * MM-213: Access subjects that a joined machine allows next to the owner emails, comma
   * separated, for example the client id of the desktop service token.
   */
  readonly MACHINE_ACCESS_SUBJECTS?: string;
  /**
   * MM-1205. The first start needs it to find the Access apps of the portal (MM-1216). Without it
   * later, "Add machine" takes an existing machine token (MM-210).
   */
  readonly CF_API_TOKEN?: string;
  /** MM-1201: AES-GCM key for secrets that wait for their machine. */
  readonly SECRET_KEY?: string;
  /** MM-1807: a P-256 private key as JSON Web Key. Without it, push is off. */
  readonly VAPID_JWK?: string;
  /** Local development only. See `access.ts`. */
  readonly DEV_FAKE_ACCESS?: string;
}
