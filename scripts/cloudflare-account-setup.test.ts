import { describe, expect, it } from "vite-plus/test";

import {
  boundSecrets,
  neededSecrets,
  setUpAccount,
} from "./cloudflare-account-setup.ts";
import type { Report, SetupOptions } from "./cloudflare-account-setup.ts";

// The fresh-account setup (scripts/cloudflare-account-setup.ts) against a
// stand-in for the Cloudflare API, the one outside system: it creates what
// a fresh account lacks, in the EU where it should, creates nothing a
// second time, waits on what needs a deployed Worker or the zone, refuses
// to change what points elsewhere, and never sends or says a secret.

const accountId = "0123456789abcdef0123456789abcdef";
const token = "test-token-never-printed";

/** A Cloudflare account and zone, as far as the script reads and writes them. */
interface FakeState {
  namespaces: string[];
  d1: { name: string; jurisdiction: string }[];
  r2: { name: string; jurisdiction: string }[];
  kv: string[];
  stores: string[];
  secrets: string[];
  zone: boolean;
  workers: string[];
  dns: string[];
  routes: { pattern: string; script: string }[];
  domains: { hostname: string; service: string }[];
  emailRouting: boolean;
  catchAll: string | null;
}

/** A call, as a route of the fake reads it. */
interface Call {
  url: URL;
  request: Request;
  /** A field of the call's JSON body, as text. */
  field: (key: string) => string;
}

const answer = (result: unknown): Response =>
  Response.json({
    success: true,
    errors: [],
    result,
    result_info: { total_pages: 1 },
  });

const notFound = (what: string): Response =>
  Response.json(
    {
      success: false,
      errors: [{ code: 7003, message: `No route for ${what}` }],
    },
    { status: 404 }
  );

/** The fake's answers, by method and path. */
const routesOf = (
  state: FakeState
): Record<string, (call: Call) => Response> => {
  const account = `/accounts/${accountId}`;
  return {
    [`GET ${account}/workers/dispatch/namespaces`]: () =>
      answer(state.namespaces.map((name) => ({ namespace_name: name }))),
    [`POST ${account}/workers/dispatch/namespaces`]: ({ field }) => {
      state.namespaces.push(field("name"));
      return answer({});
    },
    [`GET ${account}/d1/database`]: ({ url }) =>
      answer(
        state.d1.filter(({ name }) => name === url.searchParams.get("name"))
      ),
    [`POST ${account}/d1/database`]: ({ field }) => {
      state.d1.push({
        name: field("name"),
        jurisdiction: field("jurisdiction"),
      });
      return answer({});
    },
    [`POST ${account}/r2/buckets`]: ({ field, request }) => {
      state.r2.push({
        name: field("name"),
        jurisdiction: request.headers.get("cf-r2-jurisdiction") ?? "default",
      });
      return answer({});
    },
    [`GET ${account}/storage/kv/namespaces`]: () =>
      answer(state.kv.map((title) => ({ title, id: title }))),
    [`POST ${account}/storage/kv/namespaces`]: ({ field }) => {
      state.kv.push(field("title"));
      return answer({});
    },
    [`GET ${account}/secrets_store/stores`]: () =>
      answer(state.stores.map((id) => ({ id, name: id }))),
    [`POST ${account}/secrets_store/stores`]: ({ field }) => {
      state.stores.push(field("name"));
      return answer({ id: field("name") });
    },
    "GET /zones": ({ url }) =>
      answer(
        state.zone ? [{ id: "zone-1", name: url.searchParams.get("name") }] : []
      ),
    [`GET ${account}/workers/scripts`]: () =>
      answer(state.workers.map((id) => ({ id }))),
    "GET /zones/zone-1/dns_records": ({ url }) =>
      answer(
        state.dns
          .filter((name) => name === url.searchParams.get("name"))
          .map((name) => ({ name }))
      ),
    "POST /zones/zone-1/dns_records": ({ field }) => {
      state.dns.push(field("name"));
      return answer({});
    },
    "GET /zones/zone-1/workers/routes": () => answer(state.routes),
    "POST /zones/zone-1/workers/routes": ({ field }) => {
      state.routes.push({ pattern: field("pattern"), script: field("script") });
      return answer({});
    },
    [`GET ${account}/workers/domains`]: ({ url }) =>
      answer(
        state.domains.filter(
          ({ hostname }) => hostname === url.searchParams.get("hostname")
        )
      ),
    [`PUT ${account}/workers/domains`]: ({ field }) => {
      state.domains.push({
        hostname: field("hostname"),
        service: field("service"),
      });
      return answer({});
    },
    "GET /zones/zone-1/email/routing": () =>
      answer({ enabled: state.emailRouting }),
    "POST /zones/zone-1/email/routing/dns": () => {
      state.emailRouting = true;
      return answer({});
    },
    "GET /zones/zone-1/email/routing/rules/catch_all": () =>
      answer({
        enabled: state.catchAll !== null,
        actions:
          state.catchAll === null
            ? []
            : [{ type: "worker", value: [state.catchAll] }],
      }),
    "PUT /zones/zone-1/email/routing/rules/catch_all": () => {
      state.catchAll = "grasp-os-router";
      return answer({});
    },
  };
};

/** What the fake answers a call no route of its takes: a bucket's or a store's secrets. */
const answerByPath = (state: FakeState, { request, url }: Call): Response => {
  const path = url.pathname.replace("/client/v4", "");
  const bucket = /\/r2\/buckets\/(?<bucket>[^/]+)$/u.exec(path)?.groups?.bucket;
  if (request.method === "GET" && bucket !== undefined) {
    const jurisdiction = request.headers.get("cf-r2-jurisdiction") ?? "default";
    return state.r2.some(
      (each) => each.name === bucket && each.jurisdiction === jurisdiction
    )
      ? answer({ name: bucket })
      : notFound(path);
  }
  if (
    request.method === "GET" &&
    /\/secrets_store\/stores\/[^/]+\/secrets$/u.test(path)
  ) {
    return answer(state.secrets.map((name) => ({ name })));
  }
  return notFound(`${request.method} ${path}`);
};

/** A stand-in for the Cloudflare API, starting as `start` says. */
const fakeCloudflare = (
  start: {
    zone?: boolean;
    workers?: string[];
    secrets?: string[];
    route?: string;
    catchAll?: string;
  } = {}
) => {
  const state: FakeState = {
    namespaces: [],
    d1: [],
    r2: [],
    kv: [],
    stores: [],
    secrets: start.secrets ?? [],
    zone: start.zone ?? true,
    workers: start.workers ?? [],
    dns: [],
    routes:
      start.route === undefined
        ? []
        : [{ pattern: "*.ongrasp.app/*", script: start.route }],
    domains: [],
    emailRouting: start.catchAll !== undefined,
    catchAll: start.catchAll ?? null,
  };
  const routes = routesOf(state);
  const writes: string[] = [];
  const bodies: string[] = [];
  const authorizations = new Set<string>();
  const send = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const path = url.pathname.replace("/client/v4", "");
    const body: unknown =
      request.method === "GET"
        ? undefined
        : await request.json().catch(() => null);
    authorizations.add(request.headers.get("authorization") ?? "");
    if (request.method !== "GET") {
      writes.push(`${request.method} ${path}`);
      bodies.push(JSON.stringify(body ?? null));
    }
    const call: Call = {
      url,
      request,
      field: (key) =>
        typeof body === "object" && body !== null
          ? String(Reflect.get(body, key))
          : "",
    };
    const route = routes[`${request.method} ${path}`];
    return route === undefined ? answerByPath(state, call) : route(call);
  };
  return { state, writes, bodies, authorizations, send };
};

const optionsFor = (
  send: SetupOptions["send"],
  more: Partial<SetupOptions> = {}
): SetupOptions => ({
  accountId,
  token,
  domain: "ongrasp.app",
  adminHost: "admin.ongrasp.app",
  dryRun: false,
  send,
  secrets: ["CLIENT_KEY", "ROUTER_KEY"],
  ...more,
});

/** Each step's outcome, by step. */
const outcomes = (reports: Report[]) =>
  Object.fromEntries(reports.map(({ step, outcome }) => [step, outcome]));

describe("setting up a fresh account", () => {
  it("creates what the account lacks, in the EU where it should, and nothing again on a second run", async () => {
    const cloudflare = fakeCloudflare({
      workers: ["grasp-os-admin", "grasp-os-router"],
    });

    const first = await setUpAccount(optionsFor(cloudflare.send));
    const writesFirst = cloudflare.writes.length;
    const second = await setUpAccount(optionsFor(cloudflare.send));

    expect({
      first: outcomes(first),
      second: new Set(second.map(({ outcome }) => outcome)),
      writesAgain: cloudflare.writes.length - writesFirst,
      d1: cloudflare.state.d1,
      r2: cloudflare.state.r2,
      catchAll: cloudflare.state.catchAll,
      routes: cloudflare.state.routes,
      domains: cloudflare.state.domains,
    }).toStrictEqual({
      first: {
        "dispatch namespace grasp-os-clients": "created",
        "D1 database grasp-os-admin (eu)": "created",
        "R2 bucket grasp-os-releases (eu)": "created",
        "KV namespace grasp-os-router-hosts": "created",
        "Secrets Store": "created",
        "Secrets Store secrets": "missing",
        "zone ongrasp.app": "exists",
        "DNS record *.ongrasp.app": "created",
        "route *.ongrasp.app/*": "created",
        "custom domain admin.ongrasp.app": "created",
        "Email Routing on ongrasp.app": "created",
        "Email Routing catch-all": "created",
      },
      // Only the secrets the operator still has to put in stay missing.
      second: new Set(["exists", "missing"]),
      writesAgain: 0,
      d1: [{ name: "grasp-os-admin", jurisdiction: "eu" }],
      r2: [{ name: "grasp-os-releases", jurisdiction: "eu" }],
      catchAll: "grasp-os-router",
      routes: [{ pattern: "*.ongrasp.app/*", script: "grasp-os-router" }],
      domains: [{ hostname: "admin.ongrasp.app", service: "grasp-os-admin" }],
    });
  });

  it("names the secrets the store lacks, and never creates, sends or prints one", async () => {
    const cloudflare = fakeCloudflare({ secrets: ["ROUTER_KEY"] });

    const reports = await setUpAccount(optionsFor(cloudflare.send));

    const secretsReport = reports.find(
      ({ step }) => step === "Secrets Store secrets"
    );
    expect({
      report: secretsReport,
      // Writes to a store's secrets: none, whatever the store lacks.
      secretWrites: cloudflare.writes.filter((write) =>
        write.endsWith("/secrets")
      ).length,
      tokenInReports: JSON.stringify(reports).includes(token),
      tokenInBodies: cloudflare.bodies.some((body) => body.includes(token)),
      sentAs: [...cloudflare.authorizations],
    }).toStrictEqual({
      report: {
        step: "Secrets Store secrets",
        outcome: "missing",
        detail: "put these in: CLIENT_KEY",
      },
      secretWrites: 0,
      tokenInReports: false,
      tokenInBodies: false,
      sentAs: [`Bearer ${token}`],
    });
  });

  it("waits on the Workers' first deploy for what names them, and on the zone for everything on it", async () => {
    const undeployed = fakeCloudflare();
    const noZone = fakeCloudflare({ zone: false });

    const beforeDeploy = outcomes(
      await setUpAccount(optionsFor(undeployed.send))
    );
    const withoutZone = outcomes(await setUpAccount(optionsFor(noZone.send)));

    expect({
      route: beforeDeploy["route *.ongrasp.app/*"],
      domain: beforeDeploy["custom domain admin.ongrasp.app"],
      catchAll: beforeDeploy["Email Routing catch-all"],
      emailRouting: beforeDeploy["Email Routing on ongrasp.app"],
      zone: withoutZone["zone ongrasp.app"],
      zoneWrites: noZone.writes.filter(
        (write) =>
          write.startsWith("POST /zones") || write.startsWith("PUT /zones")
      ),
    }).toStrictEqual({
      route: "pending",
      domain: "pending",
      catchAll: "pending",
      emailRouting: "created",
      zone: "pending",
      zoneWrites: [],
    });
  });

  it("only reads, and says what it would create, on a dry run", async () => {
    const cloudflare = fakeCloudflare({
      workers: ["grasp-os-admin", "grasp-os-router"],
    });

    const reports = await setUpAccount(
      optionsFor(cloudflare.send, { dryRun: true })
    );

    expect({
      writes: cloudflare.writes,
      outcomes: new Set(reports.map(({ outcome }) => outcome)),
    }).toStrictEqual({
      writes: [],
      outcomes: new Set(["would_create", "missing", "exists"]),
    });
  });

  it("refuses to repoint a route that goes to another Worker", async () => {
    const cloudflare = fakeCloudflare({
      workers: ["grasp-os-admin", "grasp-os-router"],
      route: "someone-else",
    });

    await expect(setUpAccount(optionsFor(cloudflare.send))).rejects.toThrow(
      "goes to someone-else, not grasp-os-router"
    );
    expect(cloudflare.state.routes).toStrictEqual([
      { pattern: "*.ongrasp.app/*", script: "someone-else" },
    ]);
  });
});

describe("what points elsewhere already", () => {
  it("refuses to repoint an Email Routing catch-all that sends mail somewhere else", async () => {
    const cloudflare = fakeCloudflare({
      workers: ["grasp-os-admin", "grasp-os-router"],
      catchAll: "someone-elses-worker",
    });

    await expect(setUpAccount(optionsFor(cloudflare.send))).rejects.toThrow(
      "sends mail somewhere other than grasp-os-router"
    );
    expect({
      catchAll: cloudflare.state.catchAll,
      catchAllWrites: cloudflare.writes.filter((write) =>
        write.endsWith("/catch_all")
      ),
    }).toStrictEqual({ catchAll: "someone-elses-worker", catchAllWrites: [] });
  });
});

describe(neededSecrets, () => {
  it("takes every secret the admin and the router bind, once each", () => {
    const configs: Record<string, string> = {
      "apps/admin/wrangler.jsonc":
        '{ "secret_name": "ROUTER_KEY" }, { "secret_name": "CLIENT_KEY" }',
      "apps/router/wrangler.jsonc": '{ "secret_name": "ROUTER_KEY" }',
    };
    expect({
      names: neededSecrets((file) => configs[file] ?? ""),
      real: neededSecrets().includes("ROUTER_KEY"),
      parsed: boundSecrets('"secret_name": "A", "secret_name":"B"'),
    }).toStrictEqual({
      names: ["CLIENT_KEY", "ROUTER_KEY"],
      real: true,
      parsed: ["A", "B"],
    });
  });
});
