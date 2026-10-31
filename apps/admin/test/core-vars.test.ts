import type { AiProviderId } from "@grasp-os/shared/ai-providers";
import { clientDomain, stages } from "@grasp-os/shared/names";
import { platformAiSchema } from "@grasp-os/shared/platform-ai";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { auditEvents, clients, settings } from "../src/db/schema.ts";
import { oauthRelayOf, signInApps } from "../src/deploy/context.ts";
import {
  derivedCoreConfig,
  onboardingSender,
} from "../src/deploy/core-config.ts";
import { configuredCoreVars } from "../src/deploy/core-vars.ts";
import { errorCode } from "../src/deploy/errors.ts";
import { platformAiOf, setPlatformAi } from "../src/platform-ai.ts";
import { db, staff } from "./hosting.ts";

// A placed client's core vars (src/deploy/core-vars.ts), as its operation
// uploads core with them (src/hosting/operation.ts): what the admin
// derives, each replaced by the client's setting of the same name, its
// other settings, and the change core records. How a setting can go
// wrong, each tried below: a name that isn't a deployment config var (one
// replacing a binding, or taking core's Durable Objects out of the EU),
// a value that isn't JSON, one core wouldn't take, and a MAIL_FROM at an
// address its EMAIL binding won't send from. And the platform's AI
// settings, which staff choose once for every client: audited, given to
// each core as `PLATFORM_AI`, and deployed whether or not Grasp has the
// key yet. No spend ceiling of the platform's: a client controls its
// spend at its own provider, and its own budgets are its settings.

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
      // One the admin derives too (the platform's): the setting goes out
      // in its place.
      PLATFORM_AI: JSON.stringify({ conversion: { provider: "local" } }),
    });

    const vars = await varsOf(clientId);

    expect(vars).toMatchObject({
      AUDIT_RETENTION_DAYS: 90,
      INBOUND_MAIL_DOMAIN: "mail.acme.test",
      MODEL_GATEWAY: rules,
      // As set: core fills in the defaults for what it leaves out.
      PLATFORM_AI: { conversion: { provider: "local" } },
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
      "PLATFORM_AI",
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
    const noPlatformAi = await clientWith({
      PLATFORM_AI: JSON.stringify({ speech: { provider: "openai" } }),
    });

    expect({
      notJson: await refusalOf(notJson),
      noBudget: await refusalOf(noBudget),
      noPlatformAi: await refusalOf(noPlatformAi),
    }).toStrictEqual({
      notJson: "setting_invalid",
      noBudget: "setting_invalid",
      noPlatformAi: "setting_invalid",
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

/** The platform AI changes the audit log has recorded, oldest first. */
const platformAiEvents = async () =>
  await db
    .select({ actor: auditEvents.actor, detail: auditEvents.detail })
    .from(auditEvents)
    .where(eq(auditEvents.action, "platform.ai"))
    .orderBy(auditEvents.at);

/** Grasp's AI settings with conversion on `provider`'s `model`, the rest the defaults. */
const converting = (provider: string, model: string) => ({
  ...platformAiSchema.parse({}),
  conversion: { provider, model },
});

/** How many platform AI changes the audit log has recorded. */
const platformAiCount = async (): Promise<number> => {
  const events = await platformAiEvents();
  return events.length;
};

/** Grasp's AI settings as a save records them. */
const words = (chosen: unknown): string =>
  JSON.stringify(platformAiSchema.parse(chosen));

/**
 * `db`, with `cross` run once, right after the first read of a save: as
 * another save landing between that save's read and its write.
 */
const crossedBy = (
  database: typeof db,
  cross: () => Promise<unknown>
): typeof db => {
  let crossed = false;
  const chain = (built: object): object =>
    new Proxy(built, {
      get: (target, property) => {
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== "function") {
          return value;
        }
        return (...args: unknown[]): unknown => {
          const result: unknown = Reflect.apply(value, target, args);
          if (property === "get" && !crossed) {
            crossed = true;
            return (async () => {
              const read: unknown = await result;
              await cross();
              return read;
            })();
          }
          return typeof result === "object" && result !== null
            ? chain(result)
            : result;
        };
      },
    });
  return new Proxy(database, {
    get: (target, property) => {
      const value: unknown = Reflect.get(target, property, target);
      if (property === "select" && typeof value === "function") {
        return (...args: unknown[]): unknown => {
          const built: unknown = Reflect.apply(value, target, args);
          return typeof built === "object" && built !== null
            ? chain(built)
            : built;
        };
      }
      return typeof value === "function"
        ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
        : value;
    },
  });
};

describe("the platform's AI settings, as every core's PLATFORM_AI", () => {
  it("records two saves that cross as one after the other, never both a change from the same settings", async () => {
    const keyed: ReadonlySet<AiProviderId> = new Set([
      "openai",
      "anthropic",
      "openrouter",
    ]);
    const defaults = platformAiSchema.parse({});
    await setPlatformAi(db, staff, defaults, keyed);
    const earlier = await platformAiCount();
    const mine = converting("anthropic", "claude-haiku-4-5");
    const theirs = converting("openrouter", "openai/gpt-5-mini");

    // Theirs lands between my save's read and its write.
    const saved = await setPlatformAi(
      crossedBy(db, async () => await setPlatformAi(db, staff, theirs, keyed)),
      staff,
      mine,
      keyed
    );
    const after = await platformAiOf(db);
    const events = await platformAiEvents();
    await setPlatformAi(db, staff, defaults, keyed);

    const changeSchema = z.object({ from: z.string(), to: z.string() });
    const changes = events
      .slice(earlier)
      .map(({ detail }) => changeSchema.parse(JSON.parse(detail ?? "null")))
      .map(({ from, to }) => `${from} -> ${to}`)
      .toSorted();
    expect({ saved, after, changes }).toStrictEqual({
      saved: { refused: null, changed: true },
      // Mine read again after theirs, and went on from it.
      after: platformAiSchema.parse(mine),
      changes: [
        `${words(defaults)} -> ${words(theirs)}`,
        `${words(theirs)} -> ${words(mine)}`,
      ].toSorted(),
    });
  });

  it("gives every core the defaults until staff choose, then their choice, audited with what it replaced and marking each client for its next deploy", async () => {
    const clientId = await clientWith({});
    const before = await varsOf(clientId);
    const earlier = await platformAiCount();
    // No ElevenLabs key: speech stays on it, waiting, while conversion moves.
    const keyed: ReadonlySet<AiProviderId> = new Set(["openai", "anthropic"]);
    const chosen = converting("anthropic", "claude-haiku-4-5");

    const changed = await setPlatformAi(db, staff, chosen, keyed);
    const again = await setPlatformAi(db, staff, chosen, keyed);
    const after = await varsOf(clientId);
    const events = await platformAiEvents();
    const audited = events.slice(earlier);
    const [record] = await db
      .select({ configChangedAt: clients.configChangedAt })
      .from(clients)
      .where(eq(clients.id, clientId));
    // Back to the defaults, for the other tests.
    await setPlatformAi(db, staff, platformAiSchema.parse({}), keyed);

    const detail: unknown = JSON.parse(audited.at(-1)?.detail ?? "null");
    expect({
      before: before.PLATFORM_AI,
      after: after.PLATFORM_AI,
      changed,
      again,
      audited: audited.length,
      actor: audited.at(-1)?.actor,
      detail,
      marked: record?.configChangedAt instanceof Date,
    }).toStrictEqual({
      before: platformAiSchema.parse({}),
      after: chosen,
      changed: { refused: null, changed: true },
      again: { refused: null, changed: false },
      audited: 1,
      actor: staff.email,
      detail: {
        from: JSON.stringify(platformAiSchema.parse({})),
        to: JSON.stringify(chosen),
      },
      marked: true,
    });
  });

  it("refuses a feature on a provider Grasp has no key for, and settings core wouldn't take, changing nothing", async () => {
    const keyed: ReadonlySet<AiProviderId> = new Set(["openai"]);
    const earlier = await platformAiCount();

    const refused = {
      unkeyed: await setPlatformAi(
        db,
        staff,
        converting("anthropic", "claude-haiku-4-5"),
        keyed
      ),
      invalid: await setPlatformAi(
        db,
        staff,
        { speech: { provider: "openai" } },
        keyed
      ),
    };
    const audited = (await platformAiCount()) - earlier;

    expect({ refused, audited }).toStrictEqual({
      refused: {
        unkeyed: { refused: "key_missing", changed: false },
        invalid: { refused: "invalid", changed: false },
      },
      audited: 0,
    });
  });

  it("deploys whatever provider platform AI names, Grasp's key or not, so a missing key never stops a deploy", async () => {
    const clientId = await clientWith({});
    const onAnthropic = await clientWith({
      PLATFORM_AI: JSON.stringify(converting("anthropic", "claude-haiku-4-5")),
    });

    // Whether Grasp has the key is connect's business: without it the
    // feature answers "not configured" in core, and everything else works.
    const defaults = await varsOf(clientId);
    const anthropic = await varsOf(onAnthropic);
    expect({
      defaults: defaults.PLATFORM_AI,
      onAnthropic: anthropic.PLATFORM_AI,
    }).toStrictEqual({
      defaults: platformAiSchema.parse({}),
      onAnthropic: platformAiSchema.parse(
        converting("anthropic", "claude-haiku-4-5")
      ),
    });
  });
});
