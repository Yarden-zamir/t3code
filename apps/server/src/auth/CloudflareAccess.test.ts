import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";

import {
  CLOUDFLARE_ACCESS_JWT_HEADER,
  makeCloudflareAccessClaimsVerifier,
} from "./CloudflareAccess.ts";

const config = {
  teamDomain: "team.cloudflareaccess.com",
  aud: "aud-tag",
  subjects: [],
};

const makeKeys = Effect.promise(async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "key-1", alg: "RS256" };
  return { privateKey, getKey: createLocalJWKSet({ keys: [jwk] }) };
});

type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

const sign = (
  privateKey: PrivateKey,
  claims: Record<string, unknown>,
  overrides?: { readonly issuer?: string; readonly audience?: string; readonly exp?: string },
) =>
  Effect.promise(() =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "key-1" })
      .setIssuer(overrides?.issuer ?? "https://team.cloudflareaccess.com")
      .setAudience(overrides?.audience ?? "aud-tag")
      .setIssuedAt()
      .setExpirationTime(overrides?.exp ?? "5m")
      .sign(privateKey),
  );

const requestWith = (token: string | undefined) =>
  HttpServerRequest.fromWeb(
    new Request("http://127.0.0.1/api/auth/session", {
      headers: token === undefined ? {} : { [CLOUDFLARE_ACCESS_JWT_HEADER]: token },
    }),
  );

it.effect("reads the email or the service token name of a verified Access JWT", () =>
  Effect.gen(function* () {
    const { privateKey, getKey } = yield* makeKeys;
    const verify = makeCloudflareAccessClaimsVerifier(config, getKey);
    const user = yield* sign(privateKey, { email: "dev@example.com" });
    const serviceToken = yield* sign(privateKey, { common_name: "client.access" });
    expect(yield* verify(requestWith(user))).toEqual({
      email: "dev@example.com",
      commonName: undefined,
    });
    expect(yield* verify(requestWith(serviceToken))).toEqual({
      email: undefined,
      commonName: "client.access",
    });
  }),
);

it.effect("rejects a missing, foreign or expired Access JWT", () =>
  Effect.gen(function* () {
    const { privateKey, getKey } = yield* makeKeys;
    const other = yield* makeKeys;
    const verify = makeCloudflareAccessClaimsVerifier(config, getKey);
    const claims = { email: "dev@example.com" };
    const rejected = [
      undefined,
      "not-a-jwt",
      yield* sign(other.privateKey, claims),
      yield* sign(privateKey, claims, { issuer: "https://other.cloudflareaccess.com" }),
      yield* sign(privateKey, claims, { audience: "other-aud" }),
      yield* sign(privateKey, claims, { exp: "-1m" }),
    ];
    for (const token of rejected) {
      expect(yield* verify(requestWith(token))).toBeUndefined();
    }
  }),
);
