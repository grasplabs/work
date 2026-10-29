import { describe, expect, it } from "vite-plus/test";

import {
  platformNameErrors,
  sharedRateLimitIds,
  wranglerConfigErrors,
} from "./wrangler-config-rules.ts";

const file = "apps/example/wrangler.jsonc";

/** A config that follows every rule, as JSONC with a comment and trailing commas. */
const compliant = `{
  // A Worker.
  "name": "example",
  "preview_urls": false,
  "observability": {
    "redact_query_string": true,
    "logs": { "invocation_logs": false },
  },
}`;

/**
 * `compliant` with `changes` merged over its top level; a key set to
 * undefined is left out.
 */
const configWith = (changes: Record<string, unknown>): string =>
  JSON.stringify({
    name: "example",
    preview_urls: false,
    observability: {
      redact_query_string: true,
      logs: { invocation_logs: false },
    },
    ...changes,
  });

describe("wrangler config rules", () => {
  it("accept a config that follows every rule", () => {
    expect(wranglerConfigErrors(file, compliant)).toStrictEqual([]);
  });

  it("refuse a config without preview_urls false, and an env that turns preview URLs on", () => {
    expect({
      missing: wranglerConfigErrors(
        file,
        configWith({ preview_urls: undefined })
      ),
      on: wranglerConfigErrors(file, configWith({ preview_urls: true })),
      envOn: wranglerConfigErrors(
        file,
        configWith({ env: { staging: { preview_urls: true } } })
      ),
      envOff: wranglerConfigErrors(
        file,
        configWith({ env: { staging: { preview_urls: false } } })
      ),
    }).toStrictEqual({
      missing: [`${file}: set preview_urls to false.`],
      on: [`${file}: set preview_urls to false.`],
      envOn: [`${file} (env staging): set preview_urls to false.`],
      envOff: [],
    });
  });

  it("refuse invocation logs or unredacted query strings, at the top level or in an env that sets its own observability", () => {
    expect({
      missing: wranglerConfigErrors(
        file,
        configWith({ observability: undefined })
      ),
      envLogs: wranglerConfigErrors(
        file,
        configWith({
          env: {
            staging: {
              observability: {
                redact_query_string: true,
                logs: { invocation_logs: true },
              },
            },
          },
        })
      ),
    }).toStrictEqual({
      missing: [
        `${file}: set observability.logs.invocation_logs to false.`,
        `${file}: set observability.redact_query_string to true.`,
      ],
      envLogs: [
        `${file} (env staging): set observability.logs.invocation_logs to false.`,
      ],
    });
  });

  it("refuse a TOML config", () => {
    expect(
      wranglerConfigErrors("apps/example/wrangler.toml", 'name = "example"')
    ).toStrictEqual([
      "apps/example/wrangler.toml: use wrangler.jsonc, as every Worker here does.",
    ]);
  });
});

/** The router's routes in each stage. */
const productionRoutes = [
  { pattern: "*.ongrasp.app/*", zone_name: "ongrasp.app" },
];
const stagingRoutes = [
  { pattern: "*.staging.ongrasp.app/*", zone_name: "ongrasp.app" },
];

/** A router config in both stages, with `overrides` merged over each. */
const router = (overrides: { production?: object; staging?: object } = {}) =>
  JSON.stringify({
    name: "grasp-router",
    vars: { STAGE: "production" },
    routes: productionRoutes,
    ratelimits: [{ name: "A", namespace_id: "1001" }],
    dispatch_namespaces: [
      { binding: "DISPATCHER", namespace: "grasp-clients" },
    ],
    ...overrides.production,
    env: {
      staging: {
        name: "grasp-router-staging",
        vars: { STAGE: "staging" },
        routes: stagingRoutes,
        ratelimits: [{ name: "A", namespace_id: "2001" }],
        dispatch_namespaces: [
          { binding: "DISPATCHER", namespace: "grasp-clients-staging" },
        ],
        ...overrides.staging,
      },
    },
  });
const routerFile = "apps/router/wrangler.jsonc";

/** A router secret binding, stored as `name`. */
const secret = (name: string) => [
  { binding: "ROUTER_KEY", store_id: "s", secret_name: name },
];

const gatewayFile = "apps/gateway/wrangler.jsonc";

/** A connect gateway config in both stages, with `routes` in production. */
const gateway = (routes?: object) =>
  JSON.stringify({
    name: "grasp-connect-gateway",
    vars: { STAGE: "production" },
    ...(routes === undefined ? {} : { routes }),
    env: {
      staging: {
        name: "grasp-connect-gateway-staging",
        vars: { STAGE: "staging" },
      },
    },
  });

describe("platform names", () => {
  it("accept a platform config named as @grasp-os/shared/names does, in both stages", () => {
    expect({
      errors: platformNameErrors(routerFile, router()),
      shared: sharedRateLimitIds([{ file: routerFile, text: router() }]),
      other: platformNameErrors(file, router({ production: { name: "x" } })),
    }).toStrictEqual({ errors: [], shared: [], other: [] });
  });

  it("refuse a staging Worker named or placed like production, and a rate limit id both stages share", () => {
    const placedInProduction = router({
      staging: {
        dispatch_namespaces: [
          { binding: "DISPATCHER", namespace: "grasp-clients" },
        ],
      },
    });
    const sharedLimit = router({
      staging: { ratelimits: [{ name: "A", namespace_id: "1001" }] },
    });
    expect({
      named: platformNameErrors(
        routerFile,
        router({ staging: { name: "grasp-router" } })
      ),
      placed: platformNameErrors(routerFile, placedInProduction),
      shared: sharedRateLimitIds([{ file: routerFile, text: sharedLimit }]),
      noStaging: platformNameErrors(
        routerFile,
        JSON.stringify({
          name: "grasp-router",
          vars: { STAGE: "production" },
          routes: productionRoutes,
        })
      ),
    }).toStrictEqual({
      named: [
        `${routerFile} (env staging): name is grasp-router, not grasp-router-staging.`,
      ],
      placed: [
        `${routerFile} (env staging): the dispatch namespace is grasp-clients, not grasp-clients-staging.`,
      ],
      shared: ["1001"],
      noStaging: [
        `${routerFile}: add env.staging, the staging platform's names.`,
      ],
    });
  });

  it("refuse a platform Worker that answers nowhere, on another stage's hosts, or, for the gateway, anywhere", () => {
    expect({
      unrouted: platformNameErrors(
        routerFile,
        router({ staging: { routes: undefined } })
      ),
      productionsHosts: platformNameErrors(
        routerFile,
        router({ staging: { routes: productionRoutes } })
      ),
      gatewayUnrouted: platformNameErrors(gatewayFile, gateway()),
      gatewayRouted: platformNameErrors(gatewayFile, gateway(productionRoutes)),
    }).toStrictEqual({
      unrouted: [
        `${routerFile} (env staging): routes is none, not *.staging.ongrasp.app/* zone ongrasp.app.`,
      ],
      productionsHosts: [
        `${routerFile} (env staging): routes is *.ongrasp.app/* zone ongrasp.app, not *.staging.ongrasp.app/* zone ongrasp.app.`,
      ],
      gatewayUnrouted: [],
      gatewayRouted: [
        `${gatewayFile}: routes is *.ongrasp.app/* zone ongrasp.app, not none.`,
      ],
    });
  });

  it("refuse a staging secret under production's name in the store, and a production one under staging's", () => {
    expect({
      own: platformNameErrors(
        routerFile,
        router({
          production: { secrets_store_secrets: secret("ROUTER_KEY") },
          staging: { secrets_store_secrets: secret("ROUTER_KEY_STAGING") },
        })
      ),
      stagingShares: platformNameErrors(
        routerFile,
        router({ staging: { secrets_store_secrets: secret("ROUTER_KEY") } })
      ),
      productionTakesStaging: platformNameErrors(
        routerFile,
        router({
          production: { secrets_store_secrets: secret("ROUTER_KEY_STAGING") },
        })
      ),
    }).toStrictEqual({
      own: [],
      stagingShares: [
        `${routerFile} (env staging): the Secrets Store secret of ROUTER_KEY is ROUTER_KEY, not ROUTER_KEY_STAGING.`,
      ],
      productionTakesStaging: [
        `${routerFile}: the Secrets Store secret of ROUTER_KEY is ROUTER_KEY_STAGING, not ROUTER_KEY.`,
      ],
    });
  });
});
