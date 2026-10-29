import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import * as Effect from "effect/Effect";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";

import type { CloudflareAccessConfig } from "../config.ts";

export const CLOUDFLARE_ACCESS_JWT_HEADER = "cf-access-jwt-assertion";

/**
 * Who passed Cloudflare Access. `owner` is an allowed subject of the login (an email or a
 * service token common name). `service-token` is any other service token, for example the
 * machine token of another machine on the machine map (MM-1305). Its caller decides what it gets.
 */
export type CloudflareAccessIdentity =
  | { readonly kind: "owner"; readonly subject: string }
  | { readonly kind: "service-token"; readonly commonName: string };

/** The identity claims of a verified Access JWT: an email, or the common name of a service token. */
export interface CloudflareAccessClaims {
  readonly email: string | undefined;
  readonly commonName: string | undefined;
}

/**
 * Fork: verifies the `Cf-Access-Jwt-Assertion` JWT (signature, issuer, audience and expiry) and
 * yields its claims, or `undefined` for a missing or bad JWT. This trusts the JWT only because the
 * server listens on loopback behind the tunnel. Revisit before the server is exposed directly.
 */
export const makeCloudflareAccessClaimsVerifier = (
  config: CloudflareAccessConfig,
  // createRemoteJWKSet caches the keys and refetches once on an unknown kid.
  getKey: JWTVerifyGetKey = createRemoteJWKSet(
    new URL(`https://${config.teamDomain}/cdn-cgi/access/certs`),
  ),
) => {
  return (
    request: HttpServerRequest.HttpServerRequest,
  ): Effect.Effect<CloudflareAccessClaims | undefined> => {
    const token = request.headers[CLOUDFLARE_ACCESS_JWT_HEADER];
    if (typeof token !== "string" || token.length === 0) {
      // @effect-diagnostics-next-line effectSucceedWithVoid:off - This optional result requires undefined, not the wider void type.
      return Effect.succeed(undefined);
    }
    return Effect.tryPromise(() =>
      jwtVerify(token, getKey, {
        issuer: `https://${config.teamDomain}`,
        audience: config.aud,
        algorithms: ["RS256"],
        requiredClaims: ["exp"],
        clockTolerance: 5,
      }),
    ).pipe(
      Effect.map(({ payload }): CloudflareAccessClaims => ({
        email:
          typeof payload.email === "string" && payload.email.length > 0 ? payload.email : undefined,
        commonName:
          typeof payload.common_name === "string" && payload.common_name.length > 0
            ? payload.common_name
            : undefined,
      })),
      Effect.catch((cause) =>
        Effect.logWarning("Rejected Cloudflare Access JWT.", { cause: String(cause) }).pipe(
          Effect.as(undefined),
        ),
      ),
    );
  };
};

/**
 * Fork: Cloudflare Access login. The check yields the verified identity, or `undefined` for a
 * subject that is not allowed. Every unexpected state fails closed.
 */
export const makeCloudflareAccessVerifier = (
  config: CloudflareAccessConfig,
  getKey?: JWTVerifyGetKey,
) => {
  const subjects = new Set(config.subjects);
  const verifyClaims = makeCloudflareAccessClaimsVerifier(config, getKey);
  return (
    request: HttpServerRequest.HttpServerRequest,
  ): Effect.Effect<CloudflareAccessIdentity | undefined> =>
    verifyClaims(request).pipe(
      Effect.flatMap((claims) => {
        if (claims === undefined) {
          // @effect-diagnostics-next-line effectSucceedWithVoid:off - This optional result requires undefined, not the wider void type.
          return Effect.succeed(undefined);
        }
        const { email, commonName } = claims;
        const owner = [email, commonName].find(
          (candidate) => candidate !== undefined && subjects.has(candidate),
        );
        if (owner !== undefined) {
          return Effect.succeed<CloudflareAccessIdentity>({ kind: "owner", subject: owner });
        }
        if (commonName !== undefined) {
          return Effect.succeed<CloudflareAccessIdentity>({ kind: "service-token", commonName });
        }
        return Effect.logWarning("Cloudflare Access JWT subject is not in the allowed list.").pipe(
          Effect.as(undefined),
        );
      }),
    );
};
