/**
 * `jwks-rsa` as core's builds have it (`alias` in wrangler.jsonc and
 * vite.config.ts): the client microsoft-keys.ts registers, which fetches
 * Microsoft's keys through the channel door's fetch.
 *
 * It finds that client on the isolate's global rather than importing it:
 * the tests pre-bundle the Teams SDK, this module with it, apart from the
 * door's own modules, and a second copy of microsoft-keys.ts there would
 * know nothing of the door's request.
 */

/** What `jwks-rsa`'s default export is to the Teams SDK. */
type JwksClient = (options: { jwksUri: string }) => unknown;

const isJwksClient = (value: unknown): value is JwksClient =>
  typeof value === "function";

const jwksClient: JwksClient = (options) => {
  const client: unknown = Reflect.get(
    globalThis,
    Symbol.for("@grasp-os/core/jwks-client")
  );
  if (!isJwksClient(client)) {
    throw new Error(
      "Microsoft's keys are fetched only through the channel door."
    );
  }
  return client(options);
};

export default jwksClient;
