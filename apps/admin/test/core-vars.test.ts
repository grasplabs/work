import { clientDomain, stages } from "@grasp-os/shared/names";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { clients, settings } from "../src/db/schema.ts";
import { oauthRelayOf, signInApps } from "../src/deploy/context.ts";
import {
  derivedCoreConfig,
  onboardingSender,
} from "../src/deploy/core-config.ts";
import { configuredCoreVars } from "../src/deploy/core-vars.ts";
import { db, staff } from "./hosting.ts";

// A placed client's core vars (src/deploy/core-vars.ts), as its operation
// uploads core with them (src/hosting/operation.ts): what the admin
// derives, each replaced by the client's setting of the same name, its
// other settings, and the change core records. How a setting can go
// wrong, each tried below: a name that isn't a deployment config var (one
// replacing a binding, or taking core's Durable Objects out of the EU),
// a value that isn't JSON, one core wouldn't take, and a MAIL_FROM at an
// address its EMAIL binding won't send from.

const domain = "grasp.test";

const signIn = {
  domains: ["acme.test"],
  admins: ["ada@acme.test"],
  googleHostedDomain: "acme.test",
};

const change = {
  by: staff.email,
  what: "release",
  release: "r100000001-0000000",
  at: new Date(0).toISOString(),
} as const;

/** A recorded client with `stored` as its settings, by name, each as stored. */
const clientWith = async (stored: Record<string, string>): Promise<string> => {
  const clientId = `client-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date();
  await db.insert(clients).values({
    id: clientId,
    name: clientId,
    ring: 0,
    signIn: JSON.stringify(signIn),
    createdAt: now,
    updatedAt: now,
  });
  for (const [key, value] of Object.entries(stored)) {
    // oxlint-disable-next-line no-await-in-loop -- one setting at a time
    await db.insert(settings).values({
      clientId,
      key,
      value,
      updatedBy: staff.email,
      updatedAt: now,
    });
  }
  return clientId;
};

/** Client `clientId`'s core vars, as its operation reads them. */
const varsOf = async (clientId: string) =>
  await configuredCoreVars(
    db,
    clientId,
    derivedCoreConfig({
      clientId,
      signIn: JSON.stringify(signIn),
      domain,
      apps: signInApps(env),
    }),
    change,
    onboardingSender(clientId, domain).address
  );

/** Why reading `clientId`'s core vars was refused: its code. */
const refusalOf = async (clientId: string): Promise<unknown> => {
  try {
    await varsOf(clientId);
  } catch (error) {
    return error instanceof Error && "code" in error ? error.code : "thrown";
  }
  return "taken";
};

describe("a placed client's settings, as core's vars", () => {
  it("gives core its settings as vars, each replacing what the admin derives of the same name, with the change it records", async () => {
    const gateway = {
      gateway: "grasp-os",
      models: ["anthropic/claude-sonnet-4-5"],
    };
    const clientId = await clientWith({
      AUDIT_RETENTION_DAYS: JSON.stringify(90),
      // Where the client receives mail, for its email triggers' addresses.
      INBOUND_MAIL_DOMAIN: JSON.stringify("mail.acme.test"),
      // One the admin derives too: the setting goes out in its place.
      MODEL_GATEWAY: JSON.stringify(gateway),
    });

    await expect(varsOf(clientId)).resolves.toMatchObject({
      AUDIT_RETENTION_DAYS: 90,
      INBOUND_MAIL_DOMAIN: "mail.acme.test",
      MODEL_GATEWAY: gateway,
      CLIENT_ID: clientId,
      PLATFORM_CHANGE: change,
    });
  });

  it.each([
    // It would replace a binding.
    ["DB", JSON.stringify("elsewhere")],
    // It would take core's Durable Objects out of the EU.
    ["DURABLE_OBJECT_JURISDICTION", JSON.stringify("none")],
  ])(
    "refuses a %s setting, which isn't a deployment config var",
    async (key, value) => {
      const clientId = await clientWith({ [key]: value });

      await expect(refusalOf(clientId)).resolves.toBe("unknown_setting");
    }
  );

  it("refuses a setting that isn't JSON, or one core wouldn't take", async () => {
    const notJson = await clientWith({ AUDIT_RETENTION_DAYS: "ninety" });
    const noModels = await clientWith({
      MODEL_GATEWAY: JSON.stringify({ gateway: "grasp-os", models: [] }),
    });

    expect({
      notJson: await refusalOf(notJson),
      noModels: await refusalOf(noModels),
    }).toStrictEqual({
      notJson: "setting_invalid",
      noModels: "setting_invalid",
    });
  });

  it("takes a MAIL_FROM at the onboarding sender's address under another name, and refuses one at any other address", async () => {
    const sender = (clientId: string) =>
      onboardingSender(clientId, domain).address;
    const named = await clientWith({});
    await db.insert(settings).values({
      clientId: named,
      key: "MAIL_FROM",
      value: JSON.stringify({
        name: "Acme onboarding",
        address: sender(named),
      }),
      updatedBy: staff.email,
      updatedAt: new Date(),
    });
    const elsewhere = await clientWith({
      MAIL_FROM: JSON.stringify({ name: "Acme", address: "ceo@acme.test" }),
    });

    const { MAIL_FROM: taken } = await varsOf(named);

    expect({
      named: taken,
      elsewhere: await refusalOf(elsewhere),
    }).toStrictEqual({
      named: { name: "Acme onboarding", address: sender(named) },
      elsewhere: "mail_sender_locked",
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
