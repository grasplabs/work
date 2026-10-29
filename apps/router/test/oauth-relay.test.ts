import { authRelayHost } from "@grasp-os/shared/names";
import { relayMaxAgeS, relayState } from "@grasp-os/shared/oauth-relay";
import { deriveRouterSecret } from "@grasp-os/shared/router";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import worker from "../src/index.ts";
import {
  fakeCores,
  mapHost,
  routerKeyAdmin,
  testRouterKey,
} from "./fixtures.ts";

// The OAuth relay on auth.<hosted domain> (@grasp-os/shared/oauth-relay).
// How it could fail, and what each test below holds it to:
// - Open redirect: sending the browser, and with it an OAuth code, to a
//   host the request names, through the state, the Host header, the path
//   or a smuggled query. It only ever builds `https://<label>.<hosted
//   domain>` from a label a client can have, for a client in its own map.
// - Cross-client delivery: one client's code sent to another. A state
//   relabelled for another client, or signed with another client's key,
//   fails the MAC, which is keyed from that client's router secret.
// - Tampering: any part of the state changed (its time, provider, the
//   client's own state), or a sign-in's state sent to the connections
//   path. The MAC covers every part and the flow.
// - Replay: an old callback URL sent again. Past `relayMaxAgeS` it goes
//   nowhere; before, it goes only to the client that made it, whose
//   one-time state is spent (core's and connect's own tests).
// - Unknown or offboarded clients: a plain page, no redirect. Offboarding
//   takes the hostname out of the map (the admin's offboarding tests).
// - Its own pages: nothing a request carries is reflected, nothing is
//   stored, framed or leaked by referrer.
// - Floods: limited per address before anything is looked up.
// - Reaching a core: never, whatever the path, even with `auth` mapped.

const relayHost = authRelayHost("production");
const relay = `https://${relayHost}`;

const entry = (clientId: string) => ({
  clientId,
  script: `grasp-${clientId}-core`,
  generation: 1,
});

/** Client `clientId`'s router secret, as its core holds it (`ROUTER_SECRET`). */
const secretOf = async (clientId: string, generation = 1): Promise<string> =>
  await deriveRouterSecret(testRouterKey, clientId, generation);

/** A sign-in's state as client `label`'s core sends its IdP. */
const signInState = async (
  label: string,
  state = "s7ate",
  {
    secret,
    provider = "microsoft",
    at,
  }: {
    secret?: string;
    provider?: string;
    at?: number;
  } = {}
): Promise<string> =>
  await relayState(
    secret ?? (await secretOf(label)),
    { kind: "sign-in", label, provider, state },
    at
  );

/** A connection's state as client `label`'s core sends the provider. */
const connectionState = async (label: string, state = "c0nn") =>
  await relayState(await secretOf(label), {
    kind: "connections",
    label,
    state,
  });

/** A limiter that lets everything through, so tests don't share a budget. */
const unlimited: RateLimit = {
  limit: async () => await Promise.resolve({ success: true }),
};

/** A request to the router, as the browser sends it back from the IdP. */
const get = async (
  url: string,
  init: { method?: string; headers?: Record<string, string> } = {},
  overrides: Partial<Env> = {}
): Promise<Response> =>
  await worker.fetch(new Request(url, { redirect: "manual", ...init }), {
    ...env,
    AUTH_RATE_LIMIT: unlimited,
    ...overrides,
  });

const query = (params: Record<string, string>): string =>
  new URLSearchParams(params).toString();

/** What a refusal shows and sends: its status, page and the headers that matter. */
const refusal = async (response: Response) => ({
  status: response.status,
  location: response.headers.get("location"),
  type: response.headers.get("content-type"),
  cache: response.headers.get("cache-control"),
  referrer: response.headers.get("referrer-policy"),
  body: await response.text(),
});

describe("the OAuth relay", () => {
  const cores = fakeCores();

  beforeAll(async () => {
    const admin = await routerKeyAdmin();
    await admin.create(testRouterKey);
    await Promise.all([
      mapHost("acme.ongrasp.app", entry("acme")),
      mapHost("globex.ongrasp.app", entry("globex")),
    ]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends a sign-in back to its client's own callback, with the client's own state and the rest as the IdP sent it", async () => {
    const state = await signInState("acme");
    const response = await get(
      `${relay}/callback/sign-in?${query({ code: "c0de", state, session_state: "x", iss: "https://login.microsoftonline.com/t/v2.0" })}`
    );

    expect({
      status: response.status,
      location: response.headers.get("location"),
      cache: response.headers.get("cache-control"),
      referrer: response.headers.get("referrer-policy"),
      // It answers itself: no core sees the code.
      cores: cores.received.length,
    }).toStrictEqual({
      status: 302,
      location: `https://acme.ongrasp.app/api/auth/sso/callback/microsoft?${query({ code: "c0de", state: "s7ate", session_state: "x", iss: "https://login.microsoftonline.com/t/v2.0" })}`,
      cache: "no-store",
      referrer: "no-referrer",
      cores: 0,
    });
  });

  it("sends a connection back to its client's connections callback", async () => {
    const state = await connectionState("globex", "abc");
    const response = await get(
      `${relay}/callback/connections?${query({ code: "c", state })}`
    );

    expect(response.headers.get("location")).toBe(
      "https://globex.ongrasp.app/api/connections/callback?code=c&state=abc"
    );
  });

  it("sends the IdP's refusal back too, for the client to tell the person, and keeps the client's state whole, dots and all", async () => {
    const state = await signInState("acme", "a.b.c", { provider: "google" });
    const response = await get(
      `${relay}/callback/sign-in?${query({ error: "access_denied", error_description: "No", state })}`
    );

    expect(response.headers.get("location")).toBe(
      "https://acme.ongrasp.app/api/auth/sso/callback/google?error=access_denied&error_description=No&state=a.b.c"
    );
  });

  it("refuses a state with any part changed, or a sign-in's sent to the connections path", async () => {
    const state = await signInState("acme");
    const [label, issued, mac, provider, own] = state.split(".");
    const other = await signInState("acme", "other");
    const otherMac = other.split(".").at(2);
    const changed = [
      // The client's own state.
      [label, issued, mac, provider, "s7atf"],
      // The provider: its callback would be another.
      [label, issued, mac, "google", own],
      // When it started: made younger to outlive the limit.
      [
        label,
        (Number.parseInt(issued ?? "", 36) + 60).toString(36),
        mac,
        provider,
        own,
      ],
      // Another flow's MAC.
      [label, issued, otherMac, provider, own],
      // A MAC cut short, or flipped.
      [label, issued, mac?.slice(0, -1), provider, own],
      [
        label,
        issued,
        `${mac?.slice(0, -1)}${mac?.endsWith("A") === true ? "B" : "A"}`,
        provider,
        own,
      ],
    ].map((parts) => parts.join("."));
    const responses = await Promise.all([
      ...changed.map(
        async (each) =>
          await get(
            `${relay}/callback/sign-in?${query({ code: "c", state: each })}`
          )
      ),
      get(`${relay}/callback/connections?${query({ code: "c", state })}`),
    ]);

    expect(
      responses.map(({ status, headers }) => [status, headers.get("location")])
    ).toStrictEqual(Array.from({ length: 7 }, () => [400, null]));
  });

  it("never sends one client's flow to another: relabelled, or signed with the other's key", async () => {
    const acmes = await signInState("acme");
    const relabelled = acmes.replace(/^acme\./u, "globex.");
    // Acme's core naming globex, with acme's own key.
    const forged = await signInState("globex", "s7ate", {
      secret: await secretOf("acme"),
    });
    // A key from an old generation of globex's secret.
    const stale = await signInState("globex", "s7ate", {
      secret: await secretOf("globex", 0),
    });

    const responses = await Promise.all(
      [relabelled, forged, stale].map(
        async (state) =>
          await get(`${relay}/callback/sign-in?${query({ code: "c", state })}`)
      )
    );

    expect(
      responses.map(({ status, headers }) => [status, headers.get("location")])
    ).toStrictEqual([
      [400, null],
      [400, null],
      [400, null],
    ]);
  });

  it("sends a callback replayed past its time nowhere, and one replayed in time only to the same client again", async () => {
    const old = await signInState("acme", "s7ate", {
      at: Date.now() - (relayMaxAgeS + 1) * 1000,
    });
    const fresh = await signInState("acme");
    const freshUrl = `${relay}/callback/sign-in?${query({ code: "c", state: fresh })}`;

    const late = await get(
      `${relay}/callback/sign-in?${query({ code: "c", state: old })}`
    );
    const first = await get(freshUrl);
    const again = await get(freshUrl);

    expect({
      late: [late.status, late.headers.get("location")],
      again: again.headers.get("location"),
    }).toStrictEqual({
      late: [400, null],
      again: first.headers.get("location"),
    });
    expect(again.headers.get("location")).toMatch(
      /^https:\/\/acme\.ongrasp\.app\//u
    );
  });

  it("shows an unknown client a plain page and sends it nowhere", async () => {
    // Signed as initech's core would, but initech isn't in the map.
    const state = await signInState("initech");
    const response = await get(
      `${relay}/callback/sign-in?${query({ code: "c", state })}`
    );

    await expect(refusal(response)).resolves.toMatchObject({
      status: 404,
      location: null,
      type: "text/html; charset=utf-8",
      cache: "no-store",
      referrer: "no-referrer",
    });
  });

  it("stops relaying for a client once offboarding takes its hostname out of the map", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await mapHost("hooli.ongrasp.app", entry("hooli"));
    const url = `${relay}/callback/sign-in?${query({ code: "c", state: await signInState("hooli") })}`;
    const before = await get(url);

    // As the admin's offboarding unroutes it; the router's cache of the
    // map then runs out (30 s).
    await env.HOSTS.delete("hooli.ongrasp.app");
    vi.setSystemTime(Date.now() + 31_000);
    const after = await get(url);

    expect({
      before: before.status,
      after: [after.status, after.headers.get("location")],
    }).toStrictEqual({ before: 302, after: [404, null] });
  });

  it.each([
    ["no state", { code: "c" }],
    ["an empty state", { code: "c", state: "" }],
    ["a state naming no client", { code: "c", state: "s7ate" }],
    [
      "a label no client can have",
      { code: "c", state: "ACME.0.x.microsoft.s" },
    ],
    ["a reserved label", { code: "c", state: "auth.0.x.microsoft.s" }],
    [
      "a state too long to read",
      { code: "c", state: `acme.${"a".repeat(2100)}` },
    ],
  ])("refuses %s with a plain page", async (_case, params) => {
    const response = await get(`${relay}/callback/sign-in?${query(params)}`);

    await expect(refusal(response)).resolves.toMatchObject({
      status: 400,
      location: null,
      type: "text/html; charset=utf-8",
      cache: "no-store",
    });
  });

  it("refuses a second state, whichever is the client's", async () => {
    const state = await signInState("acme");
    const responses = await Promise.all(
      [
        `code=c&state=${state}&state=evil`,
        `code=c&state=evil&state=${state}`,
      ].map(async (search) => await get(`${relay}/callback/sign-in?${search}`))
    );

    expect(responses.map(({ status }) => status)).toStrictEqual([400, 400]);
  });

  it("answers no other path, and takes only the IdP's GET", async () => {
    const state = await signInState("acme");
    const search = query({ code: "c", state });
    const responses = await Promise.all([
      get(`${relay}/`),
      get(`${relay}/callback`),
      get(`${relay}/callback/sign-in/x?${search}`),
      get(`${relay}/callback/sign-in%2F..%2Fx?${search}`),
      get(`${relay}/api/rpc`),
      get(`${relay}/callback/sign-in?${search}`, { method: "POST" }),
    ]);

    expect(
      responses.map(({ status, headers }) => [
        status,
        headers.get("location"),
        headers.get("allow"),
      ])
    ).toStrictEqual([
      [404, null, null],
      [404, null, null],
      [404, null, null],
      [404, null, null],
      [404, null, null],
      [405, null, "GET"],
    ]);
  });

  it("forwards nothing to a core, even with an auth hostname in the map", async () => {
    await mapHost(relayHost, entry("acme"));
    await mapHost("auth.elsewhere.test", entry("acme"));

    const responses = await Promise.all([
      get(`${relay}/api/rpc`),
      get("https://auth.elsewhere.test/api/rpc"),
    ]);

    expect({
      statuses: responses.map(({ status }) => status),
      cores: cores.received.length,
    }).toStrictEqual({ statuses: [404, 404], cores: 0 });
    await env.HOSTS.delete(relayHost);
    await env.HOSTS.delete("auth.elsewhere.test");
  });

  it("builds where it sends the browser from the state alone, never the Host it was asked at", async () => {
    const state = await signInState("acme");
    const search = query({ code: "c", state });
    const [shouted, lookalike, otherDomain] = await Promise.all([
      // The same host, as a browser may spell it.
      get(`https://AUTH.ONGRASP.APP./callback/sign-in?${search}`),
      // A host that only starts like the relay's.
      get(`https://auth.ongrasp.app.evil.test/callback/sign-in?${search}`),
      get(`https://auth.evil.test/callback/sign-in?${search}`),
    ]);

    expect({
      shouted: shouted.headers.get("location"),
      lookalike: [lookalike.status, lookalike.headers.get("location")],
      otherDomain: [otherDomain.status, otherDomain.headers.get("location")],
    }).toStrictEqual({
      shouted:
        "https://acme.ongrasp.app/api/auth/sso/callback/microsoft?code=c&state=s7ate",
      lookalike: [404, null],
      otherDomain: [404, null],
    });
  });

  it("carries a smuggled line break or path in the query only as encoded data", async () => {
    const state = await signInState("acme");
    const response = await get(
      `${relay}/callback/sign-in?code=c%0d%0aSet-Cookie:%20x=1&next=%2F%2Fevil.test%2F&state=${state}`
    );
    const location = response.headers.get("location") ?? "";
    const target = new URL(location);

    expect({
      status: response.status,
      cookie: response.headers.get("set-cookie"),
      origin: target.origin,
      path: target.pathname,
      raw: /[\r\n]/u.test(location),
      code: target.searchParams.get("code"),
    }).toStrictEqual({
      status: 302,
      cookie: null,
      origin: "https://acme.ongrasp.app",
      path: "/api/auth/sso/callback/microsoft",
      raw: false,
      code: "c\r\nSet-Cookie: x=1",
    });
  });

  it("shows nothing a request carried on its pages", async () => {
    const marker = "<script>alert(1)</script>";
    const responses = await Promise.all([
      get(
        `${relay}/callback/sign-in?${query({ code: marker, state: marker })}`
      ),
      get(`${relay}/${encodeURIComponent(marker)}`),
      get(
        `${relay}/callback/sign-in?${query({ code: marker, state: await signInState("initech", marker) })}`
      ),
    ]);
    const pages = await Promise.all(responses.map(refusal));

    expect(
      pages.map(({ status, body }) => [
        status,
        body.includes("script") || body.includes("initech"),
      ])
    ).toStrictEqual([
      [400, false],
      [404, false],
      [404, false],
    ]);
    expect(responses[0]?.headers.get("content-security-policy")).toBe(
      "default-src 'none'; frame-ancestors 'none'"
    );
  });

  it("limits callbacks per address across every client, before looking any up", async () => {
    const counts = new Map<string, number>();
    const limiter: RateLimit = {
      limit: async ({ key }) => {
        const count = (counts.get(key) ?? 0) + 1;
        counts.set(key, count);
        return await Promise.resolve({ success: count <= 2 });
      },
    };
    const from = async (ip: string, label: string) =>
      await get(
        `${relay}/callback/sign-in?${query({ code: "c", state: await signInState(label) })}`,
        { headers: { "cf-connecting-ip": ip } },
        { AUTH_RATE_LIMIT: limiter }
      );

    const first = await from("203.0.113.7", "acme");
    const second = await from("203.0.113.7", "globex");
    const third = await from("203.0.113.7", "acme");
    const elsewhere = await from("198.51.100.1", "acme");

    expect({
      statuses: [first, second, third, elsewhere].map(({ status }) => status),
      limited: await refusal(third),
      retry: third.headers.get("retry-after"),
    }).toMatchObject({
      statuses: [302, 302, 429, 302],
      limited: { location: null, type: "text/html; charset=utf-8" },
      retry: "60",
    });
  });

  it("relays staging's clients on staging's own relay host, and no other stage's", async () => {
    await mapHost("acme.staging.ongrasp.app", entry("acme"));
    const state = await signInState("acme");
    const search = query({ code: "c", state });
    const staging = { STAGE: "staging" } as const;

    const own = await get(
      `https://${authRelayHost("staging")}/callback/sign-in?${search}`,
      {},
      staging
    );
    const production = await get(
      `${relay}/callback/sign-in?${search}`,
      {},
      staging
    );

    expect({
      own: own.headers.get("location"),
      production: [production.status, production.headers.get("location")],
    }).toStrictEqual({
      own: "https://acme.staging.ongrasp.app/api/auth/sso/callback/microsoft?code=c&state=s7ate",
      production: [404, null],
    });
  });

  it("serves no relay while STAGE names no stage exactly, and forwards nothing", async () => {
    const search = query({ code: "c", state: await signInState("acme") });
    const responses = await Promise.all(
      ["prod", "", "Production"].map(async (stage) => {
        // A misconfigured STAGE, which Env's type rules out.
        const misconfigured = { ...env, AUTH_RATE_LIMIT: unlimited };
        Reflect.set(misconfigured, "STAGE", stage);
        return await worker.fetch(
          new Request(`${relay}/callback/sign-in?${search}`, {
            redirect: "manual",
          }),
          misconfigured
        );
      })
    );

    expect({
      answers: responses.map(({ status, headers }) => [
        status,
        headers.get("location"),
      ]),
      cores: cores.received.length,
    }).toStrictEqual({
      answers: [
        [404, null],
        [404, null],
        [404, null],
      ],
      cores: 0,
    });
  });
});
