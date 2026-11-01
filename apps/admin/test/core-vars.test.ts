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
import { errorCode } from "../src/deploy/errors.ts";
import { db, staff } from "./hosting.ts";

// A placed client's core vars (src/deploy/core-vars.ts), as its operation
// uploads core with them (src/hosting/operation.ts): what the admin
// derives, each replaced by the client's setting of the same name, its
// other settings, and the change core records. How a setting can go
// wrong, each tried below: a name that isn't a deployment config var (one
// replacing a binding, or taking core's Durable Objects out of the EU),
// a value that isn't JSON, one core wouldn't take, and a MAIL_FROM at an
// address its EMAIL binding won't send from. No spend ceiling of the
// platform's: a client controls its spend at its own provider, and its own
// budgets are its settings.

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

/** Why reading `clientId`'s core vars was refused: its code, as a deploy records it. */
const refusalOf = async (clientId: string): Promise<unknown> => {
  try {
    await varsOf(clientId);
  } catch (error) {
    return errorCode(error);
  }
  return "taken";
};

describe("a placed client's settings, as core's vars", () => {
  it("gives core its settings as vars, each replacing what the admin derives of the same name, with the change it records", async () => {
    // The client's own model rules, its budgets among them, as set: no
    // ceiling of the platform's is laid over them.
    const rules = {
      budgets: {
        deployment: { limit: 5000, alertAt: 90 },
        user: { limit: 20 },
      },
    };
    const clientId = await clientWith({
      AUDIT_RETENTION_DAYS: JSON.stringify(90),
      // Where the client receives mail, for its email triggers' addresses.
      INBOUND_MAIL_DOMAIN: JSON.stringify("mail.acme.test"),
      MODEL_GATEWAY: JSON.stringify(rules),
    });

    const vars = await varsOf(clientId);

    expect(vars).toMatchObject({
      AUDIT_RETENTION_DAYS: 90,
      INBOUND_MAIL_DOMAIN: "mail.acme.test",
      MODEL_GATEWAY: rules,
      CLIENT_ID: clientId,
      PLATFORM_CHANGE: change,
    });
  });

  it("gives a client without model rules none: no allowlist, gateway or budget of the platform's", async () => {
    const clientId = await clientWith({});

    const vars = await varsOf(clientId);

    expect(Object.keys(vars).toSorted()).toStrictEqual([
      "CLIENT_ID",
      "MAIL_FROM",
      "PLATFORM_CHANGE",
      "RUNTIME_PROFILE",
      "SIGN_IN",
    ]);
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
    const noBudget = await clientWith({
      MODEL_GATEWAY: JSON.stringify({ budgets: { user: { limit: 0 } } }),
    });

    expect({
      notJson: await refusalOf(notJson),
      noBudget: await refusalOf(noBudget),
    }).toStrictEqual({
      notJson: "setting_invalid",
      noBudget: "setting_invalid",
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
