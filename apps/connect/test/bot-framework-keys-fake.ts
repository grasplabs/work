/**
 * Microsoft's Bot Framework signing keys, as login.botframework.com serves
 * them: the OpenID metadata at `/v1/.well-known/openidconfiguration`, whose
 * `jwks_uri` names the key set at `/v1/.well-known/keys`, each key with the
 * channels it is endorsed for. A test sets the keys (public JWKs it made),
 * points `jwks_uri` elsewhere, makes either answer something else, and
 * reads back what was asked.
 *
 * Self-contained, with nothing from outside the function: core's tests run
 * it inside the Worker that stands in for the internet behind connect
 * (core's test/connect-providers.ts embeds its source), connect's call it
 * straight from a fetch spy.
 */
export const botFrameworkKeysFake = () => {
  const origin = "https://login.botframework.com";
  const metadataPath = "/v1/.well-known/openidconfiguration";
  const keysPath = "/v1/.well-known/keys";
  const asked: { method: string; path: string; redirect: string }[] = [];
  let keys: unknown[] = [];
  let jwksUri = `${origin}${keysPath}`;
  /** What the metadata or the key set answers instead of its own. */
  let overrides: Record<string, () => Response> = {};

  return {
    origin,
    metadataPath,
    keysPath,
    asked,
    /** Serves `next` as the key set, each a public JWK. */
    setKeys: (next: unknown[]) => {
      keys = next;
    },
    /** Names `uri` as where the key set is, in the metadata. */
    setJwksUri: (uri: string) => {
      jwksUri = uri;
    },
    /** Answers `path` with what `answer` makes, instead of its own. */
    override: (path: string, answer: () => Response) => {
      overrides[path] = answer;
    },
    reset: () => {
      asked.length = 0;
      keys = [];
      jwksUri = `${origin}${keysPath}`;
      overrides = {};
    },
    answer: (request: Request): Response => {
      const url = new URL(request.url);
      asked.push({
        method: request.method,
        path: url.pathname,
        redirect: request.redirect,
      });
      const override = overrides[url.pathname];
      if (override !== undefined) {
        return override();
      }
      if (request.method !== "GET") {
        return new Response("Method not allowed", { status: 405 });
      }
      if (url.pathname === metadataPath) {
        return Response.json({
          issuer: "https://api.botframework.com",
          authorization_endpoint: "https://invalid.botframework.com",
          jwks_uri: jwksUri,
          id_token_signing_alg_values_supported: ["RS256"],
          token_endpoint_auth_methods_supported: ["private_key_jwt"],
        });
      }
      if (url.pathname === keysPath) {
        return Response.json({ keys });
      }
      return new Response("Not found", { status: 404 });
    },
  };
};
