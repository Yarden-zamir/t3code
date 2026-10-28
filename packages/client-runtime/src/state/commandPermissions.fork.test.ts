import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { RpcSession } from "../rpc/session.ts";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  EnvironmentId,
  WS_METHODS,
  type AuthSessionState,
  type PeerLinkSummary,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { createCommandPermissions } from "./commandPermissions.ts";
import { AVAILABLE_CONNECTION_STATE } from "../connection/model.ts";
import { createPeerLinkEnvironmentAtoms } from "./peerLinks.ts";

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, string>>(AsyncResult.initial()),
);
const env = EnvironmentId.make("target");
const other = EnvironmentId.make("other");
const grant = (allowed: boolean): AuthSessionState => ({
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
  scopes: allowed ? [AuthOrchestrationOperateScope] : [],
  permissions: allowed ? [AuthOrchestrationOperateScope] : [],
});
const runtime = Atom.runtime(
  Layer.succeed(EnvironmentRegistry, {
    run: (_id: EnvironmentId, effect: Effect.Effect<unknown>) => effect,
  } as unknown as EnvironmentRegistry["Service"]),
);
const setup = Effect.gen(function* () {
  const registry = AtomRegistry.make();
  registry.mount(sessions(env));
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  return registry;
});

describe("command permissions", () => {
  it.effect.each([WS_METHODS.forkChangelogStartSync, WS_METHODS.threadRecreateWorktree])(
    "requires the destination source control grant for %s",
    (method) =>
      Effect.scoped(
        Effect.gen(function* () {
          const registry = yield* setup;
          const start = createCommandPermissions(runtime, method);
          registry.set(sessions(env), AsyncResult.success(grant(true)));
          expect(registry.get(start.permissionAtom(env))).toBe(false);
          registry.set(
            sessions(env),
            AsyncResult.success({
              ...grant(false),
              scopes: [AuthSourceControlWriteScope],
              permissions: [AuthSourceControlWriteScope],
            }),
          );
          expect(registry.get(start.permissionAtom(env))).toBe(true);
          yield* start.authorize(registry, env);
        }),
      ),
  );

  it.effect("requires the destination source control grant to prepare a draft worktree", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const prepare = createCommandPermissions(runtime, WS_METHODS.vcsPrepareDraftWorktree);
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(prepare.permissionAtom(env))).toBe(false);
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(false),
            scopes: [AuthSourceControlWriteScope],
            permissions: [AuthSourceControlWriteScope],
          }),
        );
        expect(registry.get(prepare.permissionAtom(env))).toBe(true);
        yield* prepare.authorize(registry, env);
      }),
    ),
  );
});

it.effect(
  "refreshes linked environments after permitted writes and blocks a read-only session",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const peer: PeerLinkSummary = {
          environmentId: EnvironmentId.make("peer"),
          label: "Box",
          urls: ["https://box.example.test"],
          access: "auto",
          linkedAt: DateTime.makeUnsafe("2026-10-01T12:00:00Z"),
          expiresAt: DateTime.makeUnsafe("2026-10-31T12:00:00Z"),
          lastReachedAt: null,
          lastError: null,
          status: "reachable",
        };
        let links: ReadonlyArray<PeerLinkSummary> = [];
        const client = {
          [WS_METHODS.peerLinksList]: () => Effect.sync(() => ({ links })),
          [WS_METHODS.peerLinksLink]: vi.fn(() =>
            Effect.sync(() => {
              links = [peer];
              return peer;
            }),
          ),
          [WS_METHODS.peerLinksUnlink]: vi.fn(() =>
            Effect.sync(() => {
              links = [];
              return { removed: true };
            }),
          ),
        };
        const supervisor = {
          target: { environmentId: env },
          session: yield* SubscriptionRef.make(Option.some({ client } as unknown as RpcSession)),
          state: yield* SubscriptionRef.make({
            ...AVAILABLE_CONNECTION_STATE,
            phase: "connected" as const,
          }),
        } as EnvironmentSupervisor["Service"];
        const peerRuntime = Atom.runtime(
          Layer.succeed(EnvironmentRegistry, {
            run: (id, effect) => {
              expect(id).toBe(env);
              return Effect.provideService(effect, EnvironmentSupervisor, supervisor);
            },
            followStream: (id, stream) => {
              expect(id).toBe(env);
              return Stream.provideService(stream, EnvironmentSupervisor, supervisor);
            },
          } as EnvironmentRegistry["Service"]),
        );
        const peerLinks = createPeerLinkEnvironmentAtoms(peerRuntime);
        const list = peerLinks.list({ environmentId: env, input: {} });
        registry.mount(list);
        const readLinks = AtomRegistry.getResult(registry, list, { suspendOnWaiting: true });
        const setAccess = (writable: boolean) =>
          registry.set(
            sessions(env),
            AsyncResult.success({
              ...grant(false),
              scopes: [AuthAccessReadScope, ...(writable ? [AuthAccessWriteScope] : [])],
              permissions: [AuthAccessReadScope, ...(writable ? [AuthAccessWriteScope] : [])],
            }),
          );
        registry.mount(sessions(other));
        registry.set(
          sessions(other),
          AsyncResult.success({
            ...grant(false),
            scopes: [AuthAccessWriteScope],
            permissions: [AuthAccessWriteScope],
          }),
        );
        setAccess(false);
        expect(yield* readLinks).toEqual({ links: [] });
        const linkInput = { url: peer.urls[0]!, pairingCode: "test-code", access: peer.access };
        const link = Effect.promise(() =>
          peerLinks.link.run(registry, { environmentId: env, input: linkInput }),
        );
        const unlink = Effect.promise(() =>
          peerLinks.unlink.run(registry, {
            environmentId: env,
            input: { environmentId: peer.environmentId },
          }),
        );
        expect(registry.get(peerLinks.link.permissionAtom(env))).toBe(false);
        const deniedLink = yield* link;
        expect(deniedLink._tag).toBe("Failure");
        if (deniedLink._tag === "Failure") {
          expect(Cause.squash(deniedLink.cause)).toMatchObject({
            _tag: "EnvironmentAuthorizationError",
            requiredPermission: AuthAccessWriteScope,
          });
        }
        expect(client[WS_METHODS.peerLinksLink]).not.toHaveBeenCalled();
        setAccess(true);
        expect(registry.get(peerLinks.link.permissionAtom(env))).toBe(true);
        expect((yield* link)._tag).toBe("Success");
        expect(client[WS_METHODS.peerLinksLink]).toHaveBeenCalledExactlyOnceWith(linkInput);
        expect(yield* readLinks).toEqual({ links: [peer] });

        setAccess(false);
        expect(registry.get(peerLinks.unlink.permissionAtom(env))).toBe(false);
        const deniedUnlink = yield* unlink;
        expect(deniedUnlink._tag).toBe("Failure");
        if (deniedUnlink._tag === "Failure") {
          expect(Cause.squash(deniedUnlink.cause)).toMatchObject({
            _tag: "EnvironmentAuthorizationError",
            requiredPermission: AuthAccessWriteScope,
          });
        }
        expect(client[WS_METHODS.peerLinksUnlink]).not.toHaveBeenCalled();
        expect(yield* readLinks).toEqual({ links: [peer] });
        setAccess(true);
        expect(registry.get(peerLinks.unlink.permissionAtom(env))).toBe(true);
        expect((yield* unlink)._tag).toBe("Success");
        expect(client[WS_METHODS.peerLinksUnlink]).toHaveBeenCalledExactlyOnceWith({
          environmentId: peer.environmentId,
        });
        expect(yield* readLinks).toEqual({ links: [] });
      }),
    ),
);
