import type { AuditEvent } from "@grasp-os/shared/audit";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { ModelTransportConfig } from "@grasp-os/shared/model-transport";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { z } from "zod";

import { resetCircuits } from "../src/model-circuit.ts";
import { modelLedger } from "../src/model-ledger.ts";
import { models } from "../src/models.ts";
import type { ModelCall, ModelsEnv } from "../src/models.ts";
import { answeringGateway } from "./ai-gateway.ts";
import type { GatewayReply, GatewayRequest } from "./ai-gateway.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { outcome, signedInApi } from "./sign-in.ts";

// Every model transport, at its boundary: the providers are the outside
// systems, faked in their own wire formats (ai-gateway.ts) behind the AI
// binding for AI Gateway, and behind `fetch` for the transports core
// reaches itself. Everything else is real: the allowlist and the rules,
// the model ledger, the audit log. Each transport passes the same suite
// (`conformance`): an answer streams, reaches only its own host with its
// own key, and is charged in the ledger as the audit log says; a call is
// cancelled and timed out; a rate limit, refused credentials and a used-up
// budget are each refused as such.
//
// Then what must never happen, first: an EU organization's call taking a
// route that isn't documented as EU (by its setting or by the host it
// actually sends to), failing over outside the EU, or failing over once a
// request may have been billed; and a custom endpoint aimed at a metadata
// address or a private network.

/** Keys of none of the providers, by the names the transports give them. */
const keys = {
  anthropic: "test-anthropic-key",
  openai: "test-openai-key",
  "bedrock-eu": "test-bedrock-key",
  openrouter: "test-openrouter-key",
  azure: "test-azure-key",
};

const anthropic = "anthropic/claude-sonnet-4-5";
const openai = "openai/gpt-5.4";
const bedrockEu = "bedrock-eu/claude-sonnet-5-5";

const allowed = [anthropic, openai, bedrockEu];

type Transport = ModelTransportConfig["primary"];

/** A transport under test: its setting, a model it reaches, and where it sends. */
interface Case {
  name: string;
  transport: Transport;
  model: string;
  /** The host its requests go to. */
  host: string;
  /** The key its requests carry; none for AI Gateway, which holds them. */
  key: string | undefined;
  /** What the audit log and the ledger name it. */
  label: string;
  region: string;
}

const azure: Transport = {
  kind: "openai-compatible",
  name: "acme-azure",
  baseUrl: "https://acme.openai.azure.com/openai/v1",
  key: "azure",
  models: { [openai]: "gpt-54-prod" },
};

const cases: Case[] = [
  {
    name: "Cloudflare AI Gateway",
    transport: { kind: "cloudflare-ai-gateway" },
    model: anthropic,
    host: "workers-binding.ai",
    key: undefined,
    label: "cloudflare-ai-gateway",
    region: "us",
  },
  {
    name: "Anthropic's own API",
    transport: { kind: "direct", anthropic: { key: "anthropic" } },
    model: anthropic,
    host: "api.anthropic.com",
    key: keys.anthropic,
    label: "direct",
    region: "us",
  },
  {
    name: "OpenAI's own API",
    transport: { kind: "direct", openai: { key: "openai" } },
    model: openai,
    host: "api.openai.com",
    key: keys.openai,
    label: "direct",
    region: "us",
  },
  {
    name: "Amazon Bedrock in the EU",
    transport: { kind: "direct", "bedrock-eu": { key: "bedrock-eu" } },
    model: bedrockEu,
    host: "bedrock-mantle.eu-central-1.api.aws",
    key: keys["bedrock-eu"],
    label: "direct",
    region: "eu-central-1",
  },
  {
    name: "OpenRouter",
    transport: { kind: "openrouter", key: "openrouter" },
    model: anthropic,
    host: "openrouter.ai",
    key: keys.openrouter,
    label: "openrouter",
    region: "global",
  },
  {
    name: "an OpenAI-compatible endpoint",
    transport: azure,
    model: openai,
    host: "acme.openai.azure.com",
    key: keys.azure,
    label: "openai-compatible/acme-azure",
    region: "azure",
  },
];

/** The fake providers, answering `replies` in order, wherever asked. */
const fakeProviders = (replies: GatewayReply[]) =>
  answeringGateway(() => replies.shift());

/**
 * Core's env reaching its models by `transport` (and `failover`), for an
 * organization of `residency`, with the fake providers behind both the AI
 * binding and `fetch`.
 */
const withTransport = (
  replies: GatewayReply[],
  config: Partial<ModelTransportConfig> & { primary: Transport },
  gatewayConfig: Record<string, unknown> = {}
) => {
  const fake = fakeProviders(replies);
  vi.spyOn(globalThis, "fetch").mockImplementation(fake.binding.fetch);
  const transportEnv: ModelsEnv = {
    ...env,
    AI: fake.binding,
    MODEL_GATEWAY: {
      gateway: "grasp-os-test",
      models: allowed,
      ...gatewayConfig,
    },
    MODEL_TRANSPORT: config,
    MODEL_PROVIDER_KEYS: JSON.stringify(keys),
  };
  return { fake, transportEnv };
};

const answer = (text: string): GatewayReply => ({
  text,
  inputTokens: 1000,
  outputTokens: 100,
});

const idp = mockIdp();

let madeWork: ModelCall<undefined>["work"] | undefined;

const makeWork = async (): Promise<void> => {
  if (madeWork !== undefined) {
    return;
  }
  const builder = await signedInApi(idp, "builder");
  const { id } = await builder.api.apps.create({ name: "Transports" });
  const appId = appIdSchema.parse(id);
  madeWork = {
    authority: {
      subject: { type: "app", appId },
      onBehalfOf: builder.userId,
      mode: "interactive",
      appVersion: 1,
    },
    context: { type: "app", appId },
  };
};

const work = (): ModelCall<undefined>["work"] => {
  if (madeWork === undefined) {
    throw new Error("The tests' App isn't made yet");
  }
  return madeWork;
};

const newPerson = () =>
  ({ type: "person", userId: `person-${crypto.randomUUID()}` }) as const;

/** A call to `model` by `trigger`, with `more`. */
const callOf = (
  model: string,
  trigger: ReturnType<typeof newPerson>,
  more: Partial<ModelCall<undefined>> = {}
): ModelCall<undefined> => ({
  model,
  input: "Hello.",
  purpose: "chat.turn",
  trigger,
  work: work(),
  ...more,
});

/** `userId`'s audit events, once there are `count`. */
const auditedFor = async (
  userId: string,
  count: number
): Promise<AuditEvent[]> => {
  const mine = async () => {
    const events = await allEvents();
    return events.filter(
      ({ actor }) => actor.type === "person" && actor.userId === userId
    );
  };
  await vi.waitFor(
    async () => {
      await expect(mine()).resolves.toHaveLength(count);
    },
    { timeout: 10_000, interval: 50 }
  );
  return await mine();
};

/** The host each request reached. */
const hostsOf = (requests: readonly GatewayRequest[]): string[] =>
  requests.map(({ url }) => new URL(url).hostname);

/** The key a request carried, however its API carries one. */
const keyOf = ({ headers }: GatewayRequest): string | undefined =>
  headers.get("x-api-key") ??
  headers.get("authorization")?.replace(/^Bearer /u, "") ??
  undefined;

const ledgerRowSchema = z.object({
  transport: z.string().nullable(),
  provider: z.string().nullable(),
  region: z.string().nullable(),
  charged_micros: z.number().nullable(),
});

/** The ledger's rows of the requests made for `userId`: their route and charge. */
const ledgerRowsFor = async (userId: string) =>
  await runInDurableObject(modelLedger(env), (_instance, state) =>
    state.storage.sql
      .exec(
        "SELECT transport, provider, region, charged_micros FROM requests WHERE actor LIKE ? ORDER BY dispatched_at",
        `%${userId}%`
      )
      .toArray()
      .map((row) => ledgerRowSchema.parse(row))
  );

describe("model transports", { timeout: 30_000 }, () => {
  beforeEach(async () => {
    resetCircuits();
    await makeWork();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe.each(cases)("conformance: $name", (transport) => {
    it("streams an answer to its own host with its own key, and charges the ledger what the audit log records, by its route", async () => {
      const trigger = newPerson();
      const { fake, transportEnv } = withTransport([answer("Hello there.")], {
        primary: transport.transport,
      });
      const streamed: string[] = [];

      const answered = await models(transportEnv).call(
        callOf(transport.model, trigger, {
          onText: (text) => {
            streamed.push(text);
          },
        })
      );

      const [event] = await auditedFor(trigger.userId, 1);
      const [row] = await ledgerRowsFor(trigger.userId);
      const charged = Number(event?.detail?.ledgerCharged);

      expect({
        text: answered.text,
        streamed: streamed.at(-1),
        hosts: hostsOf(fake.requests),
        keys: fake.requests.map(keyOf),
        event,
        // What the audit log says it cost is what the ledger charged.
        charged:
          charged > 0 && Math.abs(charged - (event?.cost?.amount ?? 0)) < 1e-9,
        row,
      }).toMatchObject({
        text: "Hello there.",
        streamed: "Hello there.",
        hosts: [transport.host],
        // AI Gateway holds the keys: none is sent to it.
        keys: [transport.key],
        event: {
          action: "model.call",
          detail: {
            outcome: "answered",
            transport: transport.label,
            region: transport.region,
            ledger: "settled",
          },
        },
        charged: true,
        row: {
          transport: transport.label,
          provider: transport.model.split("/")[0],
          region: transport.region,
          charged_micros: Math.round(charged * 1_000_000),
        },
      });
    });

    it("stops a request its caller cancels, and audits it as cancelled", async () => {
      const trigger = newPerson();
      const { fake, transportEnv } = withTransport([{ hang: true }], {
        primary: transport.transport,
      });
      const caller = new AbortController();
      const asked = outcome(
        models(transportEnv).call(
          callOf(transport.model, trigger, { signal: caller.signal })
        )
      );
      await vi.waitFor(() => {
        expect(fake.requests).toHaveLength(1);
      });
      caller.abort();

      await expect(asked).resolves.toBe("model.failed");
      expect(fake.requests[0]?.signal.aborted).toBeTruthy();
      const [event] = await auditedFor(trigger.userId, 1);
      expect(event).toMatchObject({
        detail: { outcome: "failed", errorType: "cancelled" },
      });
    });

    it("fails a request that takes longer than its timeout", async () => {
      const trigger = newPerson();
      const { transportEnv } = withTransport([{ hang: true }], {
        primary: transport.transport,
      });

      await expect(
        outcome(
          models(transportEnv).call(
            callOf(transport.model, trigger, { timeoutMs: 300 })
          )
        )
      ).resolves.toBe("model.failed");
      const [event] = await auditedFor(trigger.userId, 1);
      expect(event).toMatchObject({
        detail: { outcome: "failed", errorType: "timeout" },
      });
    });

    it("says when the provider's rate limit refuses it, with the wait it asks for", async () => {
      const trigger = newPerson();
      const limited: GatewayReply = {
        status: 429,
        errorType: "rate_limit_error",
        headers: { "retry-after": "1" },
      };
      const { fake, transportEnv } = withTransport(
        [limited, limited, limited],
        { primary: transport.transport }
      );

      const told = await models(transportEnv)
        .call(callOf(transport.model, trigger, { timeoutMs: 20_000 }))
        .then(
          () => "answered",
          (error: unknown) => error
        );

      expect(told).toMatchObject({
        code: "model.rate_limited",
        details: { retryAfterSeconds: 1 },
      });
      // Asked again after the wait, twice: by the SDK through AI Gateway,
      // by the gateway itself on the others.
      expect(fake.requests).toHaveLength(3);
      const [event] = await auditedFor(trigger.userId, 1);
      expect(event).toMatchObject({
        detail: { outcome: "failed", status: 429, transport: transport.label },
      });
    });

    it("fails a request whose credentials the provider refuses, with the status only", async () => {
      const trigger = newPerson();
      const { transportEnv } = withTransport(
        [{ status: 401, errorType: "authentication_error" }],
        { primary: transport.transport }
      );

      await expect(
        outcome(models(transportEnv).call(callOf(transport.model, trigger)))
      ).resolves.toBe("model.failed");
      const [event] = await auditedFor(trigger.userId, 1);
      expect(event).toMatchObject({
        detail: {
          outcome: "failed",
          status: 401,
          errorType: "authentication_error",
        },
      });
      // Never a key in the audit log.
      expect(JSON.stringify(event)).not.toContain("test-");
    });

    it("refuses a call its budget has no room for, and sends nothing", async () => {
      const trigger = newPerson();
      const { fake, transportEnv } = withTransport(
        [answer("Never sent.")],
        { primary: transport.transport },
        { budgets: { user: { limit: 0.01 } } }
      );

      await expect(
        outcome(models(transportEnv).call(callOf(transport.model, trigger)))
      ).resolves.toBe("model.over_budget");
      expect(fake.requests).toHaveLength(0);
    });
  });

  describe("residency", () => {
    it("refuses an EU organization's call on any route not documented as EU, audited, and sends nothing", async () => {
      const refused = [
        { kind: "cloudflare-ai-gateway" },
        { kind: "direct", anthropic: { key: "anthropic" } },
        { kind: "openrouter", key: "openrouter" },
        // Bedrock is in the EU, but AI Gateway's hop isn't.
      ] satisfies Transport[];
      for (const primary of refused) {
        const trigger = newPerson();
        const model =
          primary.kind === "cloudflare-ai-gateway" ? bedrockEu : anthropic;
        const { fake, transportEnv } = withTransport([answer("No.")], {
          primary,
          residency: "eu",
        });

        // oxlint-disable-next-line no-await-in-loop -- one route after another
        await expect(
          outcome(models(transportEnv).call(callOf(model, trigger)))
        ).resolves.toBe("model.eu_only");
        expect(fake.requests).toHaveLength(0);
        // oxlint-disable-next-line no-await-in-loop -- one route after another
        const [event] = await auditedFor(trigger.userId, 1);
        expect(event).toMatchObject({
          action: "model.refused",
          detail: { reason: "model.eu_only", because: "residency" },
        });
        vi.restoreAllMocks();
      }
    });

    it("lets an EU organization's call reach Bedrock in Frankfurt directly, and records the route", async () => {
      const trigger = newPerson();
      const { fake, transportEnv } = withTransport([answer("Hallo.")], {
        primary: { kind: "direct", "bedrock-eu": { key: "bedrock-eu" } },
        residency: "eu",
      });

      await models(transportEnv).call(callOf(bedrockEu, trigger));

      expect(hostsOf(fake.requests)).toStrictEqual([
        "bedrock-mantle.eu-central-1.api.aws",
      ]);
      await expect(ledgerRowsFor(trigger.userId)).resolves.toMatchObject([
        { transport: "direct", provider: "bedrock-eu", region: "eu-central-1" },
      ]);
    });

    it("takes staff's attestation for an Azure endpoint, and never for a host the catalog can't place in the EU", async () => {
      const attestation = {
        basis:
          "https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/deployment-types",
        by: "staff@grasp.test",
        at: "2026-10-29T10:00:00.000Z",
      };
      const attested = (baseUrl: string): Transport => ({
        ...azure,
        baseUrl,
        euAttestation: attestation,
      });
      const outcomes: string[] = [];
      for (const primary of [
        azure,
        attested("https://acme.openai.azure.com/openai/v1"),
        attested("https://eu-proxy.example.com/v1"),
      ]) {
        const { transportEnv } = withTransport([answer("Hallo.")], {
          primary,
          residency: "eu",
        });
        // oxlint-disable-next-line no-await-in-loop -- one endpoint after another
        const told = await outcome(
          models(transportEnv).call(callOf(openai, newPerson()))
        );
        outcomes.push(told);
        vi.restoreAllMocks();
      }

      expect(outcomes).toStrictEqual(["model.eu_only", "ok", "model.eu_only"]);
    });

    it("keeps an EU organization's voice off AI Gateway, whose hop isn't in the EU", async () => {
      const { fake, transportEnv } = withTransport(
        [{ speech: { audio: "audio" } }],
        {
          primary: { kind: "direct", "bedrock-eu": { key: "bedrock-eu" } },
          residency: "eu",
        },
        { models: [...allowed, "elevenlabs/eleven_v4"] }
      );

      await expect(
        outcome(
          models(transportEnv).speak({
            model: "elevenlabs/eleven_v4",
            text: "Hallo.",
            voice: "voice1",
            language: "nl",
            purpose: "onboarding.interview",
            trigger: newPerson(),
            work: { onboarding: true },
          })
        )
      ).resolves.toBe("model.eu_only");
      expect(fake.requests).toHaveLength(0);
    });
  });

  describe("failover", () => {
    const directAnthropic: Transport = {
      kind: "direct",
      anthropic: { key: "anthropic" },
    };

    it("goes to the next transport once the first refuses its credentials, audited", async () => {
      const trigger = newPerson();
      const { fake, transportEnv } = withTransport(
        [{ status: 401, errorType: "authentication_error" }, answer("Hello.")],
        {
          primary: { kind: "openrouter", key: "openrouter" },
          failover: [directAnthropic],
        }
      );

      const answered = await models(transportEnv).call(
        callOf(anthropic, trigger)
      );

      expect(answered.text).toBe("Hello.");
      expect(hostsOf(fake.requests)).toStrictEqual([
        "openrouter.ai",
        "api.anthropic.com",
      ]);
      const events = await auditedFor(trigger.userId, 3);
      expect(
        events.map(({ action, detail }) => [
          action,
          detail?.transport ?? detail?.to,
        ])
      ).toStrictEqual([
        ["model.call", "openrouter"],
        ["model.failover", "direct"],
        ["model.call", "direct"],
      ]);
      expect(events[1]).toMatchObject({
        detail: { from: "openrouter", to: "direct", why: "auth" },
      });
    });

    it("never fails over once a request may have been billed", async () => {
      const trigger = newPerson();
      const { fake, transportEnv } = withTransport(
        [{ status: 503, errorType: "overloaded_error" }, answer("Never sent.")],
        {
          primary: { kind: "openrouter", key: "openrouter" },
          failover: [directAnthropic],
        }
      );

      await expect(
        outcome(models(transportEnv).call(callOf(anthropic, trigger)))
      ).resolves.toBe("model.failed");
      expect(hostsOf(fake.requests)).toStrictEqual(["openrouter.ai"]);
    });

    it("never fails an EU organization's call over to a route outside the EU", async () => {
      const trigger = newPerson();
      const { fake, transportEnv } = withTransport(
        [
          { status: 401, errorType: "authentication_error" },
          answer("Never sent."),
        ],
        {
          primary: { kind: "direct", "bedrock-eu": { key: "bedrock-eu" } },
          failover: [{ kind: "cloudflare-ai-gateway" }],
          residency: "eu",
        }
      );

      await expect(
        outcome(models(transportEnv).call(callOf(bedrockEu, trigger)))
      ).resolves.toBe("model.failed");
      expect(hostsOf(fake.requests)).toStrictEqual([
        "bedrock-mantle.eu-central-1.api.aws",
      ]);
    });

    it("stops sending to a transport whose circuit opened, and goes straight to the next", async () => {
      const down: GatewayReply = { status: 503, errorType: "overloaded_error" };
      const { fake, transportEnv } = withTransport(
        [down, down, down, down, down, answer("Hello.")],
        {
          primary: { kind: "openrouter", key: "openrouter" },
          failover: [directAnthropic],
        }
      );
      for (let call = 0; call < 5; call += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one failure after another
        await outcome(
          models(transportEnv).call(callOf(anthropic, newPerson()))
        );
      }
      const trigger = newPerson();

      const answered = await models(transportEnv).call(
        callOf(anthropic, trigger)
      );

      expect(answered.text).toBe("Hello.");
      expect(hostsOf(fake.requests).at(-1)).toBe("api.anthropic.com");
      expect(
        hostsOf(fake.requests).filter((host) => host === "openrouter.ai")
      ).toHaveLength(5);
      const events = await auditedFor(trigger.userId, 2);
      expect(events[0]).toMatchObject({
        action: "model.failover",
        detail: { from: "openrouter", to: "direct", why: "circuit_open" },
      });
    });
  });

  describe("custom endpoints", () => {
    it.each([
      "https://169.254.169.254/latest",
      "https://[fd00:ec2::254]/v1",
      "https://localhost/v1",
      "https://10.0.0.8/v1",
      "https://models.internal/v1",
      "http://models.example.com/v1",
      "https://models.example.com:8443/v1",
    ])("refuses an endpoint at %s, sending nothing", async (baseUrl) => {
      const trigger = newPerson();
      const { fake, transportEnv } = withTransport([answer("No.")], {
        primary: { ...azure, baseUrl },
      });

      await expect(
        outcome(models(transportEnv).call(callOf(openai, trigger)))
      ).resolves.toBe("model.unconfigured");
      expect(fake.requests).toHaveLength(0);
    });

    it("fails closed on a transport setting that doesn't parse, whatever it was meant to be", async () => {
      const { fake, transportEnv: valid } = withTransport([answer("No.")], {
        primary: { kind: "direct", anthropic: { key: "anthropic" } },
      });
      // A direct transport with no provider: not one at all.
      const transportEnv = {
        ...valid,
        MODEL_TRANSPORT: { primary: { kind: "direct" } },
      };

      await expect(
        outcome(models(transportEnv).call(callOf(anthropic, newPerson())))
      ).resolves.toBe("model.unconfigured");
      expect(fake.requests).toHaveLength(0);
    });
  });
});
