/**
 * Connect as the e2e stack runs it (e2e/connect-config.ts names this file
 * as its `main`): connect itself, unchanged (apps/connect/src/index.ts),
 * with Linear's MCP server beside it, connect's own faithful fake
 * (apps/connect/test/linear-mcp-fake.ts), at Linear's origin, which the
 * built-in Linear serves, and at the copy's (`linearCopyOrigin`), which an
 * admin adds by its URL, so a person connects either without any request
 * leaving the machine: requests to those origins, and the DNS lookups of
 * their names, are
 * answered here, in connect's own isolate; every other request goes out
 * as it would. A person's approval comes back as e2e/linear-consent.ts
 * describes. Never deployed: no deployment's connect has this entry.
 */
import {
  linearCopyOrigin,
  linearMcpFake,
  linearOrigin,
} from "../apps/connect/test/linear-mcp-fake.ts";
import { consentedUrlOf } from "./linear-consent.ts";

/** Each fake by its origin. */
const fakes = new Map(
  [linearOrigin, linearCopyOrigin].map((origin) => [
    origin,
    linearMcpFake(origin),
  ])
);

/** Where connect asks DNS (apps/connect/src/mcp-discovery.ts). */
const dnsResolverHost = "cloudflare-dns.com";

/** Their names, which resolve to a public address. */
const linearHosts = new Set(
  [...fakes.keys()].map((origin) => new URL(origin).hostname)
);

/**
 * `request` as Linear's token endpoint is to take it: a code the test
 * gave as the person's approval (e2e/linear-consent.ts) is redeemed as the
 * code the fake issues once it approves the request the code carries.
 */
const consented = async (request: Request): Promise<Request> => {
  if (request.method !== "POST" || new URL(request.url).pathname !== "/token") {
    return request;
  }
  const form = new URLSearchParams(await request.clone().text());
  const authorizationUrl = consentedUrlOf(form.get("code") ?? "");
  if (authorizationUrl === undefined) {
    return request;
  }
  const fake = fakes.get(new URL(authorizationUrl).origin);
  if (fake === undefined) {
    return request;
  }
  form.set("code", fake.consent(authorizationUrl).code);
  return new Request(request.url, {
    method: "POST",
    headers: request.headers,
    body: form.toString(),
  });
};

const outward = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  const fake = fakes.get(url.origin);
  if (fake !== undefined) {
    return await fake.handle(await consented(new Request(input, init)));
  }
  const name = url.searchParams.get("name") ?? "";
  if (url.hostname === dnsResolverHost && linearHosts.has(name)) {
    const type = url.searchParams.get("type") === "AAAA" ? 28 : 1;
    return Response.json({
      Status: 0,
      Answer: type === 1 ? [{ name, type, TTL: 60, data: "34.120.10.1" }] : [],
    });
  }
  return await outward(input, init);
};

// Every export wrangler.jsonc binds, as apps/connect/src/index.ts has
// them, by name (`export *` is a barrel the linter refuses).
export { Clock, ConnectorEgress, default } from "../apps/connect/src/index.ts";
