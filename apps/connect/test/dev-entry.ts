/**
 * Connect as `vp run dev` runs it, for local development only: never
 * deployed, and never what connect's own wrangler.jsonc names. Connect
 * itself, unchanged (src/index.ts), with one outside API beside it for an
 * admin to approve as an HTTP connection (outside-api-fake.ts): requests
 * to `outsideApiOrigin`, and the DNS lookups of its two names, are
 * answered here, in connect's own isolate; every other request goes out
 * as it would.
 *
 * It is this entry that stands in for the internet, never a setting of
 * connect's: its code has no way to be told that a private address is
 * fine, so no deployment can be configured into one (see the header of
 * src/http-connections.ts). scripts/dev.ts names this file as the local
 * config's `main` (scripts/wrangler-local-config.ts).
 */
import {
  outsideApiFake,
  outsideApiInsideOrigin,
  outsideApiOrigin,
  outsideApiSlowMs,
} from "./outside-api-fake.ts";

const outsideApi = outsideApiFake({
  origin: outsideApiOrigin,
  insideOrigin: outsideApiInsideOrigin,
  slowMs: outsideApiSlowMs,
});

/** Where connect asks DNS (src/http-connections.ts). */
const dnsResolverHost = "cloudflare-dns.com";

const outward = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin === outsideApiOrigin) {
    // With the call's `signal`, which the fake honours as a fetch does.
    return await outsideApi.answer(new Request(input, init), url);
  }
  const resolved =
    url.hostname === dnsResolverHost ? outsideApi.dns(url) : undefined;
  // Everything else exactly as it was asked.
  return resolved ?? (await outward(input, init));
};

// Every export wrangler.jsonc binds, as src/index.ts has them, by name:
// `export *` is a barrel the linter refuses (`oxc/no-barrel-file`). One
// missing here fails `vp run dev` at its start, naming the class.
export { Clock, ConnectorEgress, default } from "../src/index.ts";
