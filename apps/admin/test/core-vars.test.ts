import { clientDomain, stages } from "@grasp-os/shared/names";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { oauthRelayOf, signInApps } from "../src/deploy/context.ts";
import {
  derivedCoreConfig,
  onboardingSender,
} from "../src/deploy/core-config.ts";
import { configuredCoreVars } from "../src/deploy/core-vars.ts";
import { staff } from "./hosting.ts";

// A placed client's core vars (src/deploy/core-vars.ts), as its operation
// uploads core with them (src/hosting/operation.ts): what the admin
// derives and the change core records.

const domain = "grasp.test";

const signIn = {
  domains: ["acme.test"],
  admins: ["ada@acme.test"],
  googleHostedDomain: "acme.test",
};

const change = {
  by: staff.email,
  what: "release",
  release: "26.01.100000001",
  at: new Date(0).toISOString(),
} as const;

describe("a placed client's core vars", () => {
  it("gives core what the admin derives and the change it records, and nothing else", () => {
    const clientId = "acme";

    const vars = configuredCoreVars(
      clientId,
      derivedCoreConfig({
        clientId,
        signIn: JSON.stringify(signIn),
        domain,
        apps: signInApps(env),
      }),
      change
    );

    expect({
      names: Object.keys(vars).toSorted(),
      clientId: vars.CLIENT_ID,
      mailFrom: vars.MAIL_FROM,
      change: vars.PLATFORM_CHANGE,
    }).toStrictEqual({
      names: [
        "CLIENT_ID",
        "MAIL_FROM",
        "PLATFORM_CHANGE",
        "RUNTIME_PROFILE",
        "SIGN_IN",
      ],
      clientId,
      mailFrom: onboardingSender(clientId, domain),
      change,
    });
  });
});

describe("a hosted client's sign-in, in relay mode", () => {
  /** Client acme's derived `SIGN_IN` under `servedUnder`, as an admin with `vars` deploys it. */
  const signInWith = (
    vars: { STAGE: string; OAUTH_RELAY: string },
    servedUnder: string
  ): unknown => {
    const relay = oauthRelayOf(vars);
    return derivedCoreConfig({
      clientId: "acme",
      signIn: JSON.stringify(signIn),
      domain: servedUnder,
      apps: signInApps(env),
      ...(relay === undefined ? {} : { oauthRelay: relay }),
    }).SIGN_IN;
  };

  it("sends each stage's hosted clients back through that stage's relay while OAUTH_RELAY is on", () => {
    expect(
      stages.map((stage) =>
        signInWith({ STAGE: stage, OAUTH_RELAY: "on" }, clientDomain(stage))
      )
    ).toMatchObject([
      {
        origin: "https://acme.ongrasp.app",
        callbackOrigin: "https://auth.ongrasp.app",
      },
      {
        origin: "https://acme.staging.ongrasp.app",
        callbackOrigin: "https://auth.staging.ongrasp.app",
      },
    ]);
  });

  it("leaves a client's IdPs returning to its own origin while OAUTH_RELAY is off", () => {
    const config = signInWith(
      { STAGE: "production", OAUTH_RELAY: "off" },
      clientDomain("production")
    );

    expect(config).toMatchObject({ origin: "https://acme.ongrasp.app" });
    expect(config).not.toHaveProperty("callbackOrigin");
  });

  it("refuses relay mode for a client under a domain its stage's relay doesn't serve, and another stage's", () => {
    const refusal = (
      vars: { STAGE: string; OAUTH_RELAY: string },
      servedUnder: string
    ): unknown => {
      try {
        signInWith(vars, servedUnder);
      } catch (error) {
        return error instanceof Error && "code" in error
          ? error.code
          : "thrown";
      }
      return "taken";
    };

    expect([
      refusal({ STAGE: "production", OAUTH_RELAY: "on" }, domain),
      refusal(
        { STAGE: "production", OAUTH_RELAY: "on" },
        clientDomain("staging")
      ),
    ]).toStrictEqual(["sign_in_incomplete", "sign_in_incomplete"]);
  });
});
