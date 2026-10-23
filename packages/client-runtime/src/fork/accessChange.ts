/**
 * Fork: access change notices (`accessChangeNotices`). The machine map changes access in two
 * ways, and clients already learn both without a reload:
 *
 * - Session access (MM-305, MM-912, MM-917). A changed arrow or client arrow ends the sessions on
 *   the target, and the client pairs again with the new scopes. The session state then holds the
 *   new scopes.
 * - Agent links (MM-1921). The server pushes its whole map state again on each change. Its
 *   `reachable` machines with agent tools are the links of its agents, as the server works them out.
 *
 * This module only compares each new value with the last one and words the difference.
 */
import {
  AuthEnvironmentScope,
  type AuthMcpClientAccess,
  type AuthSessionState,
  MACHINE_LEVEL_LINK_ACCESS,
  type MachineMapClientState,
  sessionGrantsScope,
} from "@t3tools/contracts";

export interface AccessChangeNotice {
  readonly title: string;
  readonly description: string;
}

/** What a user notices of a scope, in the order of the notice. */
const SCOPE_ABILITIES: ReadonlyArray<readonly [AuthEnvironmentScope, string]> = [
  ["orchestration:read", "see threads"],
  ["orchestration:operate", "send messages"],
  ["terminal:operate", "use terminals"],
  ["settings:write", "change settings"],
  // The scopes that only `admin` adds to `standard` (MM-302).
  ["access:write", "manage access"],
  ["relay:write", "manage T3 Connect"],
];

const LINK_ABILITIES: Readonly<Record<AuthMcpClientAccess, string>> = {
  "read-only": "only read threads there",
  "approval-required": "start threads there, with approvals",
  "auto-accept-edits": "start threads there, with approvals for commands",
  auto: "start threads there",
  "full-access": "start and change any thread there",
};

const ARROW_HINT = "Set the arrow in the portal to get it back.";

function grantedScopes(session: AuthSessionState): ReadonlySet<AuthEnvironmentScope> {
  return new Set(
    AuthEnvironmentScope.literals.filter((scope) => sessionGrantsScope(session, scope)),
  );
}

function sameSet<A>(left: ReadonlySet<A>, right: ReadonlySet<A>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function sentence(prefix: string, abilities: ReadonlyArray<string>): string | null {
  if (abilities.length === 0) return null;
  const listed =
    abilities.length === 1
      ? abilities[0]
      : `${abilities.slice(0, -1).join(", ")} and ${abilities.at(-1)}`;
  return `${prefix} ${listed}.`;
}

/** The words for a change of granted scopes, or null when the user notices no difference. */
function describeScopeChange(
  label: string,
  before: ReadonlySet<AuthEnvironmentScope>,
  after: ReadonlySet<AuthEnvironmentScope>,
): AccessChangeNotice | null {
  if (sameSet(before, after)) return null;
  const gained = SCOPE_ABILITIES.filter(([scope]) => after.has(scope) && !before.has(scope));
  const lost = SCOPE_ABILITIES.filter(([scope]) => before.has(scope) && !after.has(scope));
  const parts = [
    sentence(
      "You can now",
      gained.map(([, ability]) => ability),
    ),
    sentence(
      "You can no longer",
      lost.map(([, ability]) => ability),
    ),
  ].filter((part) => part !== null);
  return {
    title: `Access to ${label} changed`,
    description: parts.length === 0 ? "Some permissions changed." : parts.join(" "),
  };
}

interface LinkAccess {
  readonly name: string;
  readonly access: AuthMcpClientAccess;
}

/** The link access of the agents of a server to each machine, by machine id (MM-1921). */
function linkAccessByMachine(
  reachable: MachineMapClientState["reachable"],
): ReadonlyMap<string, LinkAccess> {
  return new Map(
    reachable.flatMap((peer) =>
      peer.agentTools && peer.level !== "none"
        ? [
            [
              peer.machine.id,
              { name: peer.machine.name, access: MACHINE_LEVEL_LINK_ACCESS[peer.level] },
            ] as const,
          ]
        : [],
    ),
  );
}

function describeLinkChange(
  selfName: string,
  peerName: string,
  before: AuthMcpClientAccess | null,
  after: AuthMcpClientAccess | null,
): AccessChangeNotice | null {
  if (before === after) return null;
  return {
    title: `Access of agents on ${selfName} to ${peerName} changed`,
    description:
      after === null
        ? `They can no longer reach ${peerName}. ${ARROW_HINT}`
        : `They can now ${LINK_ABILITIES[after]}.`,
  };
}

/**
 * Remembers the last access of each environment and link in this app session. The first value
 * of each is the start, not a change, so a launch or a reload shows nothing.
 */
export function createAccessChangeTracker() {
  const scopes = new Map<string, ReadonlySet<AuthEnvironmentScope>>();
  const links = new Map<string, ReadonlyMap<string, LinkAccess>>();

  return {
    /**
     * A new session state of an environment. A refused session (`authenticated: false`) is the
     * gap between the end of a session and the next pairing, not a change, so it is skipped.
     */
    observeSession(
      environmentId: string,
      label: string,
      session: AuthSessionState,
    ): AccessChangeNotice | null {
      if (!session.authenticated) return null;
      const after = grantedScopes(session);
      const before = scopes.get(environmentId);
      scopes.set(environmentId, after);
      return before === undefined ? null : describeScopeChange(label, before, after);
    },

    /** The arrow to an environment is gone, so the app removed it (MM-1401). */
    observeEnded(environmentId: string, label: string): AccessChangeNotice | null {
      const before = scopes.get(environmentId);
      scopes.set(environmentId, new Set());
      return before === undefined || before.size === 0
        ? null
        : { title: `Access to ${label} ended`, description: ARROW_HINT };
    },

    /**
     * A new map state of the server of an environment. A state without a desired state has no
     * links to compare yet, so it is skipped.
     */
    observeLinks(
      environmentId: string,
      state: Pick<MachineMapClientState, "desired" | "reachable">,
    ): ReadonlyArray<AccessChangeNotice> {
      if (state.desired === null) return [];
      const selfName = state.desired.self.name;
      const after = linkAccessByMachine(state.reachable);
      const before = links.get(environmentId);
      links.set(environmentId, after);
      if (before === undefined) return [];
      return [...new Set([...before.keys(), ...after.keys()])].flatMap((machineId) => {
        const old = before.get(machineId);
        const next = after.get(machineId);
        const notice = describeLinkChange(
          selfName,
          next?.name ?? old?.name ?? machineId,
          old?.access ?? null,
          next?.access ?? null,
        );
        return notice === null ? [] : [notice];
      });
    },

    /** Notices are off, so the next map state is a new start, not a change. */
    forgetLinks(environmentId: string) {
      links.delete(environmentId);
    },
  };
}
