import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import * as Effect from "effect/Effect";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";

export const CLOUDFLARE_ACCESS_JWT_HEADER = "cf-access-jwt-assertion";

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
  config: { readonly teamDomain: string; readonly audiences: ReadonlyArray<string> },
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
        audience: [...config.audiences],
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
