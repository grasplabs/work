/**
 * The organization's own AI providers, end to end: an admin adds a key
 * through core's `/rpc`, connect seals it, and core's model gateway
 * reaches the provider's own API through connect, which adds the key.
 * The providers are the outside systems here, faked behind connect's
 * fetch (test/ai-providers-fake.ts); core, connect, the ledger and the
 * audit log are real.
 *
 * The ways it can fail come first (threat model in src/ai-providers.ts,
 * src/model-transport-connect.ts and connect's src/ai-providers.ts): a key
 * that lands in core's database, its logs, the audit log or an answer; a
 * key sent to any host but its provider's, or in more than one header; a
 * custom endpoint on a private, metadata or plain-HTTP address; a call
 * with no provider connected. Then the conformance every provider's route
 * passes, and what the organization's admins do with their keys.
 */
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import {
  aiCredentialPlaceholder,
  aiProviderErrors,
} from "@grasp-os/shared/ai-providers";
import type { AiProviderId } from "@grasp-os/shared/ai-providers";
import type { AuditEvent } from "@grasp-os/shared/audit";
import { appIdSchema } from "@grasp-os/shared/ids";
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

import { modelLedger } from "../src/model-ledger.ts";
import { models } from "../src/models.ts";
import type { ModelCall, ModelsEnv } from "../src/models.ts";
import { streamText } from "./ai-gateway.ts";
import type { Answer } from "./ai-gateway.ts";
import { aiProvidersControlUrl, compatibleHost } from "./ai-providers-fake.ts";
import type { PlannedReply, ProviderRequest } from "./ai-providers-fake.ts";
import { allEvents } from "./audit-events.ts";
import { platformOpenAiKey } from "./connect-providers.ts";
import { mockIdp } from "./idp.ts";
import {
  openRpc,
  outcome,
  signedIn,
  signedInApi,
  staffPerson,
} from "./sign-in.ts";
import { connectDb, testBinding } from "./test-env.ts";

const idp = mockIdp();

const isFetcher = (value: unknown): value is Fetcher =>
  typeof value === "object" && value !== null && "fetch" in value;

/** The Worker standing in for the internet behind connect. */
const internet = (): Fetcher => {
  const binding = testBinding("CONNECT_PROVIDERS");
  if (!isFetcher(binding)) {
    throw new TypeError("Expected the providers Worker as CONNECT_PROVIDERS");
  }
  return binding;
};

/** Plans how the providers answer the requests that carry `key`, in order. */
const plan = async (key: string, replies: PlannedReply[]): Promise<void> => {
  await internet().fetch(aiProvidersControlUrl, {
    method: "POST",
    body: JSON.stringify({ key, replies }),
  });
};

/** Every request a provider got whose headers or body carry `text`. */
const carrying = async (text: string): Promise<ProviderRequest[]> => {
  const response = await internet().fetch(
    `${aiProvidersControlUrl}?anywhere=${encodeURIComponent(text)}`
  );
  return await response.json();
};

/** A key no other test uses, so what carries it is this test's. */
const newKey = (): string => `test-byok-${crypto.randomUUID()}`;

/** An answer as `api`'s stream sends it. */
const answered = (
  api: Parameters<typeof streamText>[0],
  text: string,
  usage: Partial<Answer> = {}
): PlannedReply => ({
  sse: streamText(api, {
    text,
    inputTokens: 1000,
    outputTokens: 100,
    ...usage,
  }),
});

/** Core's env without the AI binding: no AI Gateway to fall back on. */
const withoutGateway = (): ModelsEnv => {
  const { AI: _, ...rest } = env;
  return rest;
};

/** A person no other test uses, so their audit events are this test's. */
const newPerson = () =>
  ({ type: "person", userId: `person-${crypto.randomUUID()}` }) as const;

/** The audit events whose actor is `userId`, once `count` have arrived. */
const auditedFor = async (
  userId: string,
  count: number
): Promise<AuditEvent[]> => {
  const mine = async () => {
    const events = await allEvents();
    return events.filter(
      ({ actor }) => "userId" in actor && actor.userId === userId
    );
  };
  await vi.waitFor(
    async () => {
      const found = await mine();
      expect(found.length).toBeGreaterThanOrEqual(count);
    },
    { timeout: 10_000, interval: 50 }
  );
  return await mine();
};

/** The App the calls work in, made once for the file. */
let madeWork: ModelCall<undefined>["work"] | undefined;

/** This test's admin, who sets the providers up: a session per test. */
let signedInAdmin: Awaited<ReturnType<typeof signedInApi>> | undefined;

/** This test's admin, and the App the calls work in. */
const admin = async () => {
  signedInAdmin ??= await signedInApi(idp, "admin");
  if (madeWork === undefined) {
    const { id } = await signedInAdmin.api.apps.create({ name: "Providers" });
    const appId = appIdSchema.parse(id);
    madeWork = {
      authority: {
        subject: { type: "app", appId },
        onBehalfOf: signedInAdmin.userId,
        mode: "interactive",
        appVersion: 1,
      },
      context: { type: "app", appId },
    };
  }
  return { admin: signedInAdmin, work: madeWork };
};

/** One call through the gateway, as an App's for `trigger`. */
const callOf = async (
  model: string,
  fields: Partial<ModelCall<undefined>> = {}
): Promise<ModelCall<undefined>> => {
  const { work } = await admin();
  return {
    model,
    input: "Say hello.",
    purpose: "chat.turn",
    trigger: newPerson(),
    work,
    ...fields,
  };
};

/** Where each provider's route goes, and how it takes its key. */
interface ProviderCase {
  provider: AiProviderId;
  model: string;
  api: Parameters<typeof streamText>[0];
  host: string;
  path: string;
  header: "x-api-key" | "authorization";
  region: string;
  baseUrl?: string;
}

const anthropicCase: ProviderCase = {
  provider: "anthropic",
  model: "anthropic/claude-sonnet-4-5",
  api: "anthropic-messages",
  host: "api.anthropic.com",
  // Anthropic's SDK asks its beta Messages API.
  path: "/v1/messages?beta=true",
  header: "x-api-key",
  region: "us",
};

const openaiCase: ProviderCase = {
  provider: "openai",
  model: "openai/gpt-5.4",
  api: "openai-responses",
  host: "api.openai.com",
  path: "/v1/responses",
  header: "authorization",
  region: "us",
};

const compatibleCase: ProviderCase = {
  provider: "openai-compatible",
  model: "openai-compatible/llama-3.3-70b",
  api: "openai-completions",
  host: compatibleHost,
  path: "/v1/chat/completions",
  header: "authorization",
  region: "custom",
  baseUrl: `https://${compatibleHost}/v1`,
};

const providerCases: ProviderCase[] = [
  anthropicCase,
  openaiCase,
  {
    provider: "mistral",
    model: "mistral/mistral-large-latest",
    api: "openai-completions",
    host: "api.mistral.ai",
    path: "/v1/chat/completions",
    header: "authorization",
    region: "eu",
  },
  {
    provider: "openrouter",
    model: "openrouter/openai/gpt-5.4",
    api: "openai-completions",
    host: "openrouter.ai",
    path: "/api/v1/chat/completions",
    header: "authorization",
    region: "us",
  },
  compatibleCase,
];

/** Connects `each`'s provider with `key`, as an admin adds it. */
const added = async (each: ProviderCase, key: string): Promise<void> => {
  const { admin: by } = await admin();
  if (each.provider === "openai-compatible") {
    await by.api.aiProviders.add({
      provider: "openai-compatible",
      key,
      baseUrl: each.baseUrl ?? "",
    });
    return;
  }
  await by.api.aiProviders.add({ provider: each.provider, key });
};

/** Connects `each`'s provider with a new key, and makes its model the default. */
const connected = async (
  each: ProviderCase,
  fallbacks: string[] = []
): Promise<string> => {
  const key = newKey();
  await added(each, key);
  const { admin: by } = await admin();
  await by.api.aiProviders.setModels({ defaultModel: each.model, fallbacks });
  return key;
};

/**
 * Where `key` went: the hosts it reached, the headers it was in, whether
 * a body carried it, and whether core's placeholder reached a provider.
 */
const placesOf = async (key: string) => {
  const carried = await carrying(key);
  const placeholder = await carrying(aiCredentialPlaceholder);
  return {
    requests: carried.length > 0,
    hosts: [...new Set(carried.map(({ host }) => host))],
    headers: [
      ...new Set(
        carried.flatMap(({ headers }) =>
          Object.entries(headers)
            .filter(([, value]) => value.includes(key))
            .map(([name]) => name)
        )
      ),
    ],
    inBody: carried.some(({ body }) => body.includes(key)),
    placeholder: placeholder.length > 0,
  };
};

/** Where a key should go: to `host`, in `header` alone, and nowhere else. */
const onlyAt = ({ host, header }: Pick<ProviderCase, "host" | "header">) => ({
  requests: true,
  hosts: [host],
  headers: [header],
  inBody: false,
  placeholder: false,
});

/** The model ledger's routes for the requests of `model`. */
const ledgerRoutes = async (model: string) =>
  await runInDurableObject(modelLedger(env), (_ledger, state) =>
    state.storage.sql
      .exec(
        "SELECT transport, provider, region, credential FROM requests WHERE model = ?",
        model
      )
      .toArray()
  );

/** The rows of every table in core's database, as text. */
const coreDatabaseText = async (): Promise<string> => {
  const tables = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE '%_fts%'"
  ).all<{ name: string }>();
  const rows = await Promise.all(
    tables.results.map(
      async ({ name }) => await env.DB.prepare(`SELECT * FROM "${name}"`).all()
    )
  );
  return JSON.stringify(rows.map(({ results }) => results));
};

/** Sets up an organization that defaults to OpenAI and falls back to Claude. */
const fallingBack = async (): Promise<{ openai: string; claude: string }> => {
  const openai = await connected(openaiCase);
  const claude = newKey();
  await added(anthropicCase, claude);
  const { admin: by } = await admin();
  await by.api.aiProviders.setModels({
    defaultModel: openaiCase.model,
    fallbacks: [anthropicCase.model],
  });
  return { openai, claude };
};

describe("AI providers", { timeout: 60_000 }, () => {
  beforeEach(async () => {
    signedInAdmin = undefined;
    // Each test starts with no provider connected and no model chosen.
    await connectDb().prepare("DELETE FROM ai_provider_keys").run();
    await env.DB.prepare(
      "DELETE FROM org_settings WHERE kind = 'ai_models'"
    ).run();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("an organization's own keys", () => {
    it("keeps a key only in connect, sealed, and never logs, stores or answers it in core", async () => {
      const spies = [
        vi.spyOn(console, "log"),
        vi.spyOn(console, "warn"),
        vi.spyOn(console, "error"),
      ];
      const key = newKey();
      const { admin: by } = await admin();

      const saved = await by.api.aiProviders.add({ provider: "openai", key });
      await by.api.aiProviders.setModels({ defaultModel: openaiCase.model });
      await plan(key, [answered("openai-responses", "Hello.")]);
      await models(env).call(await callOf(openaiCase.model));
      const listing = await by.api.aiProviders.list();
      const sealed = await connectDb()
        .prepare("SELECT * FROM ai_provider_keys")
        .all();

      expect(listing.providers).toMatchObject([
        { provider: "openai", mask: `…${key.slice(-4)}` },
      ]);
      expect(sealed.results).toHaveLength(1);
      // Nowhere: not what core answered, not connect's database, not
      // core's, not the audit log, not core's logs.
      const everywhere = JSON.stringify([
        saved,
        listing,
        sealed.results,
        await coreDatabaseText(),
        await allEvents(),
        spies.map((spy) => spy.mock.calls),
      ]);
      expect(everywhere).not.toContain(key);
    });

    it("refuses a custom endpoint on a private, internal, metadata or plain-HTTP address, and keeps nothing", async () => {
      const { admin: by } = await admin();
      const refused = await Promise.all(
        [
          "http://llm.acme-ai.test/v1",
          "https://169.254.169.254/latest",
          "https://metadata.google.internal/v1",
          "https://10.0.0.8/v1",
          "https://127.0.0.1/v1",
          "https://localhost/v1",
          "https://models.internal/v1",
          "https://[::1]/v1",
          "https://127.0.0.1.nip.io/v1",
          "https://169-254-169-254.acme-ai.test/v1",
          "https://llm.acme-ai.test:8443/v1",
          `https://${["user", "pass"].join(":")}@llm.acme-ai.test/v1`,
        ].map(
          async (baseUrl) =>
            await outcome(
              by.api.aiProviders.add({
                provider: "openai-compatible",
                key: newKey(),
                baseUrl,
              })
            )
        )
      );
      const { providers } = await by.api.aiProviders.list();

      expect(new Set(refused)).toStrictEqual(
        new Set(["ai_provider.endpoint_refused"])
      );
      expect(providers).toStrictEqual([]);
    });

    it("sends a custom endpoint's key only to the base URL it was added with, asking its model by its own name", async () => {
      const key = await connected(compatibleCase);
      await plan(key, [answered("openai-completions", "Hello from Llama.")]);

      const answer = await models(env).call(await callOf(compatibleCase.model));

      expect(answer.text).toBe("Hello from Llama.");
      const [request] = await carrying(key);
      const asked: unknown = JSON.parse(request?.body ?? "{}");
      expect({ path: request?.path, asked }).toMatchObject({
        path: "/v1/chat/completions",
        asked: { model: "llama-3.3-70b" },
      });
      await expect(placesOf(key)).resolves.toStrictEqual(
        onlyAt(compatibleCase)
      );
    });

    it("fails every call as having no provider while none is connected, and while none of its models is chosen", async () => {
      const noProvider = await outcome(
        models(withoutGateway()).call(await callOf(openaiCase.model))
      );
      await added(openaiCase, newKey());
      const noModel = await outcome(
        models(withoutGateway()).call(await callOf(openaiCase.model))
      );

      expect({ noProvider, noModel }).toStrictEqual({
        noProvider: "model.no_provider",
        noModel: "model.no_provider",
      });
    });

    it("refuses a model the organization didn't choose once it connected a provider, the deployment's allowlist too", async () => {
      await connected(openaiCase);

      const unchosen = await outcome(
        models(env).call(await callOf("openai/gpt-5-mini"))
      );
      const allowlisted = await outcome(
        models(env).call(
          await callOf("workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast")
        )
      );

      expect({ unchosen, allowlisted }).toStrictEqual({
        unchosen: "model.not_allowed",
        allowlisted: "model.not_allowed",
      });
    });

    it("adds, tests, uses, replaces and removes a key", async () => {
      const { admin: by } = await admin();
      const first = newKey();
      const second = newKey();
      await plan(first, [
        answered("anthropic-messages", "OK"),
        answered("anthropic-messages", "Hello."),
      ]);
      await plan(second, [answered("anthropic-messages", "Hello again.")]);

      await by.api.aiProviders.add({ provider: "anthropic", key: first });
      const tested = await by.api.aiProviders.test("anthropic");
      await by.api.aiProviders.setModels({ defaultModel: anthropicCase.model });
      const used = await models(env).call(await callOf(anthropicCase.model));
      await by.api.aiProviders.add({ provider: "anthropic", key: second });
      const replaced = await models(env).call(
        await callOf(anthropicCase.model)
      );
      const { providers } = await by.api.aiProviders.list();
      await by.api.aiProviders.remove("anthropic");
      const removed = await outcome(
        models(withoutGateway()).call(await callOf(anthropicCase.model))
      );
      const kept = await connectDb()
        .prepare("SELECT * FROM ai_provider_keys")
        .all();

      expect(tested).toStrictEqual({
        ok: true,
        model: "anthropic/claude-haiku-4-5",
      });
      expect([used.text, replaced.text, removed]).toStrictEqual([
        "Hello.",
        "Hello again.",
        "model.no_provider",
      ]);
      expect(providers[0]?.status?.lastOkAt).toBeTypeOf("number");
      const [withFirst, withSecond] = await Promise.all([
        carrying(first),
        carrying(second),
      ]);
      expect({
        first: withFirst.length,
        second: withSecond.length,
        kept: kept.results.length,
      }).toStrictEqual({ first: 2, second: 1, kept: 0 });
    });

    it("audits each change in the admin's name, and the test as a call through the gateway, never with the key", async () => {
      const { admin: by } = await admin();
      const key = newKey();
      await plan(key, [answered("anthropic-messages", "OK")]);

      await by.api.aiProviders.add({ provider: "anthropic", key });
      await by.api.aiProviders.test("anthropic");
      await by.api.aiProviders.setModels({ defaultModel: anthropicCase.model });
      await by.api.aiProviders.add({ provider: "anthropic", key: newKey() });
      await by.api.aiProviders.remove("anthropic");

      const events = await auditedFor(by.userId, 6);
      // Connect records a key's changes in its own outbox, core the rest
      // in its: the log has them all, each in its own outbox's order.
      expect(
        events
          .filter(({ action }) => action.startsWith("ai_provider."))
          .map(({ action, source }) => `${source} ${action}`)
          .toSorted()
      ).toStrictEqual([
        "connect ai_provider.added",
        "connect ai_provider.removed",
        "connect ai_provider.replaced",
        "core ai_provider.models_set",
        "core ai_provider.tested",
      ]);
      expect(
        events
          .filter(({ source }) => source === "connect")
          .map(({ action }) => action)
      ).toStrictEqual([
        "ai_provider.added",
        "ai_provider.replaced",
        "ai_provider.removed",
      ]);
      expect(
        events.find(({ action }) => action === "model.call")
      ).toMatchObject({
        model: { provider: "anthropic", model: "claude-haiku-4-5" },
        detail: {
          purpose: "ai_provider.test",
          transport: "connect",
          credential: "organization",
          platform: "provider_test",
        },
      });
      expect(JSON.stringify(events)).not.toContain(key);
    });

    it("lets only the organization's admins read its providers, and its own admins change them", async () => {
      const member = await signedInApi(idp, "user");

      const adding = await outcome(
        member.api.aiProviders.add({ provider: "openai", key: newKey() })
      );
      const listed = await outcome(member.api.aiProviders.list());

      expect({ added: adding, listed }).toStrictEqual({
        added: "role.forbidden",
        listed: "role.forbidden",
      });
    });

    it("refuses a key change from an admin demoted since their session was checked", async () => {
      const key = newKey();
      const { admin: by } = await admin();
      await by.api.aiProviders.add({ provider: "openai", key });
      await env.DB.prepare("UPDATE members SET role = 'user' WHERE user_id = ?")
        .bind(by.userId)
        .run();

      const adding = await outcome(
        by.api.aiProviders.add({ provider: "anthropic", key: newKey() })
      );
      const removing = await outcome(by.api.aiProviders.remove("openai"));
      const kept = await connectDb()
        .prepare("SELECT provider FROM ai_provider_keys")
        .all<{ provider: string }>();

      expect({ adding, removing }).toStrictEqual({
        adding: "role.forbidden",
        removing: "role.forbidden",
      });
      expect(kept.results.map(({ provider }) => provider)).toStrictEqual([
        "openai",
      ]);
    });

    it("answers a save the database refuses as a failure that quotes nothing of what was written", async () => {
      const spies = [
        vi.spyOn(console, "log"),
        vi.spyOn(console, "warn"),
        vi.spyOn(console, "error"),
      ];
      const key = newKey();
      const marker = "QUOTED:";
      const { admin: by } = await admin();
      // A database error quotes its query's values: here the sealed key
      // and its mask, behind the marker.
      await connectDb()
        .prepare(
          `CREATE TRIGGER quoting_refusal BEFORE INSERT ON ai_provider_keys BEGIN SELECT RAISE(ABORT, '${marker}' || NEW.sealed || ' ' || NEW.mask); END`
        )
        .run();
      let failure: unknown;
      try {
        await by.api.aiProviders.add({ provider: "openai", key });
      } catch (error) {
        failure = error;
      } finally {
        await connectDb().prepare("DROP TRIGGER quoting_refusal").run();
      }

      expect(aiProviderErrors.codeOf(failure)).toBe("ai_provider.failed");
      const everywhere = JSON.stringify([
        String(failure),
        failure instanceof Error ? failure.message : null,
        spies.map((spy) => spy.mock.calls),
        await coreDatabaseText(),
      ]);
      expect(everywhere).not.toContain(marker);
      expect(everywhere).not.toContain(key.slice(-4));
    });

    it("audits Grasp staff's every read of the providers, naming nothing they hold", async () => {
      const key = newKey();
      const { admin: by } = await admin();
      await by.api.aiProviders.add({ provider: "openai", key });
      const { core } = await openRpc(
        await signedIn(idp, "grasp-staff", staffPerson())
      );
      const staff = core.authenticate();
      const { userId } = await staff.whoami();

      const listing = await staff.aiProviders.list();
      const adding = await outcome(
        staff.aiProviders.add({ provider: "anthropic", key: newKey() })
      );

      expect(listing.providers.map(({ provider }) => provider)).toStrictEqual([
        "openai",
      ]);
      expect(adding).toBe("role.forbidden");
      const audited = await auditedFor(userId, 2);
      const views = audited.filter(({ action }) => action === "staff.accessed");
      expect(views.map(({ detail }) => detail.surface)).toStrictEqual(
        expect.arrayContaining(["aiProviders.list", "aiProviders.add"])
      );
      expect(JSON.stringify(views)).not.toContain(key.slice(-4));
    });
  });

  describe("falling back", () => {
    it("tries the next model when a provider refuses a call before anything was billed, and audits it", async () => {
      const keys = await fallingBack();
      // Refused for its credentials: OpenAI takes nothing on.
      await plan(keys.openai, [{ status: 401 }]);
      await plan(keys.claude, [answered("anthropic-messages", "From Claude.")]);
      const trigger = newPerson();

      const answer = await models(env).call(
        await callOf(openaiCase.model, { trigger })
      );

      expect(answer.text).toBe("From Claude.");
      const events = await auditedFor(trigger.userId, 3);
      expect(
        events.map(({ action, model, detail }) => ({
          action,
          provider: model?.provider ?? null,
          outcome: detail.outcome ?? null,
          why: detail.why ?? null,
        }))
      ).toStrictEqual([
        {
          action: "model.call",
          provider: "openai",
          outcome: "failed",
          why: null,
        },
        {
          action: "model.fallback",
          provider: null,
          outcome: null,
          why: "auth",
        },
        {
          action: "model.call",
          provider: "anthropic",
          outcome: "answered",
          why: null,
        },
      ]);
    });

    it("never falls back once a provider failed a call it may have billed", async () => {
      const keys = await fallingBack();
      await plan(keys.openai, [{ status: 503 }]);

      const failed = await outcome(
        models(env).call(await callOf(openaiCase.model))
      );

      expect(failed).toBe("model.failed");
      await expect(carrying(keys.claude)).resolves.toStrictEqual([]);
    });

    it("falls back in an agent's loop too, before anything streamed", async () => {
      const keys = await fallingBack();
      await plan(keys.openai, [{ status: 403 }]);
      await plan(keys.claude, [answered("anthropic-messages", "From Claude.")]);
      const { input: _input, ...session } = await callOf(openaiCase.model);

      const agent = await models(env).agent(session);
      const answer = await agent
        .stream(
          agent.model,
          normalizeContext({
            messages: [
              { role: "user", content: "Hello.", timestamp: Date.now() },
            ],
          })
        )
        .result();

      expect({
        stopReason: answer.stopReason,
        content: answer.content,
      }).toMatchObject({
        stopReason: "stop",
        content: [{ type: "text", text: "From Claude." }],
      });
    });
  });

  describe("Grasp's own keys, for platform features", () => {
    it("calls a provider Grasp has a key for, with that key, audited as the platform's", async () => {
      await plan(platformOpenAiKey, [
        answered("openai-responses", "Converted."),
      ]);
      const trigger = newPerson();

      const answer = await models(withoutGateway()).platformCall(
        await callOf("openai/gpt-5-mini", {
          trigger,
          work: { platform: "brain_upkeep" },
        })
      );

      expect(answer.text).toBe("Converted.");
      await expect(placesOf(platformOpenAiKey)).resolves.toStrictEqual(
        onlyAt(openaiCase)
      );
      const [event] = await auditedFor(trigger.userId, 1);
      expect(event?.detail).toMatchObject({
        transport: "connect",
        credential: "platform",
        platform: "brain_upkeep",
      });
    });

    it("doesn't offer a provider Grasp has no key for, nor its key to anything but a platform feature", async () => {
      const { platform } = await env.CONNECT.aiProviderRoutes();
      const noKey = await outcome(
        models(env).platformCall(
          await callOf(anthropicCase.model, {
            work: { platform: "brain_upkeep" },
          })
        )
      );
      const notPlatform = await outcome(
        models(env).platformCall(await callOf("openai/gpt-5-mini"))
      );

      expect({ platform, noKey, notPlatform }).toStrictEqual({
        platform: ["openai"],
        noKey: "model.not_allowed",
        notPlatform: "model.invalid_call",
      });
    });
  });

  describe.each(providerCases)("the route to $provider", (each) => {
    it("streams an answer, sending the key once, to the provider's own host only", async () => {
      const key = await connected(each);
      await plan(key, [answered(each.api, "Hello, Ada.")]);
      const streamed: string[] = [];

      const answer = await models(env).call(
        await callOf(each.model, {
          onText: (text) => {
            streamed.push(text);
          },
        })
      );

      expect(answer).toMatchObject({
        text: "Hello, Ada.",
        usage: { inputTokens: 1000, outputTokens: 100 },
      });
      expect(streamed.at(-1)).toBe("Hello, Ada.");
      const [request] = await carrying(key);
      expect(request?.path).toBe(each.path);
      await expect(placesOf(key)).resolves.toStrictEqual(onlyAt(each));
    });

    it("records its usage and the route in the audit log and the ledger", async () => {
      const key = await connected(each);
      await plan(key, [answered(each.api, "Hello, Ada.")]);
      const trigger = newPerson();

      await models(env).call(await callOf(each.model, { trigger }));

      const [event] = await auditedFor(trigger.userId, 1);
      expect(event).toMatchObject({
        action: "model.call",
        model: {
          provider: each.provider,
          inputTokens: 1000,
          outputTokens: 100,
        },
        detail: {
          outcome: "answered",
          transport: "connect",
          region: each.region,
          credential: "organization",
        },
      });
      await expect(ledgerRoutes(each.model)).resolves.toContainEqual({
        transport: "connect",
        provider: each.provider,
        region: each.region,
        credential: "organization",
      });
    });

    it("stops a request its caller cancels mid-answer", async () => {
      const key = await connected(each);
      const begun = streamText(each.api, {
        text: "Hello",
        inputTokens: 1000,
        outputTokens: 100,
        cut: 3,
      });
      await plan(key, [{ hold: begun }]);
      const cancel = new AbortController();
      const trigger = newPerson();

      const cancelled = await outcome(
        models(env).call(
          await callOf(each.model, {
            trigger,
            signal: cancel.signal,
            onText: () => {
              cancel.abort();
            },
          })
        )
      );

      expect(cancelled).toBe("model.failed");
      const [event] = await auditedFor(trigger.userId, 1);
      expect(event?.detail).toMatchObject({
        outcome: "failed",
        errorType: "cancelled",
      });
    });

    it("fails a request that takes longer than its timeout", async () => {
      const key = await connected(each);
      await plan(key, [{ hang: true }]);
      const trigger = newPerson();

      const late = await outcome(
        models(env).call(await callOf(each.model, { trigger, timeoutMs: 500 }))
      );

      expect(late).toBe("model.failed");
      const [event] = await auditedFor(trigger.userId, 1);
      expect(event?.detail).toMatchObject({
        outcome: "failed",
        errorType: "timeout",
      });
    });

    it("waits out a rate limit it can within its deadline, and is refused for one it can't", async () => {
      const key = await connected(each);
      await plan(key, [
        { status: 429, headers: { "retry-after": "1" } },
        answered(each.api, "After the wait."),
        { status: 429, headers: { "retry-after": "3600" } },
      ]);

      const waited = await models(env).call(await callOf(each.model));
      // Its wait, held to core's most (a minute), ends past its deadline.
      const refused = await outcome(
        models(env).call(await callOf(each.model, { timeoutMs: 10_000 }))
      );

      expect([waited.text, refused]).toStrictEqual([
        "After the wait.",
        "model.rate_limited",
      ]);
      await expect(carrying(key)).resolves.toHaveLength(3);
    });

    it("fails a call whose key the provider refuses, without asking again, and says so in its status", async () => {
      const key = await connected(each);
      await plan(key, [{ status: 401 }]);
      const trigger = newPerson();

      const refused = await outcome(
        models(env).call(await callOf(each.model, { trigger }))
      );
      const asked = await carrying(key);
      const { admin: by } = await admin();
      const { providers } = await by.api.aiProviders.list();

      expect([refused, asked.length]).toStrictEqual(["model.failed", 1]);
      const [event] = await auditedFor(trigger.userId, 1);
      expect(event?.detail).toMatchObject({ outcome: "failed", status: 401 });
      expect(providers[0]?.status).toMatchObject({
        lastFailure: "auth",
        lastStatus: 401,
      });
    });

    it("sends nothing a budget can't hold", async () => {
      const key = await connected(each);
      const budgeted: ModelsEnv = {
        ...env,
        MODEL_GATEWAY: {
          gateway: "grasp-os-test",
          models: ["workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast"],
          budgets: { user: { limit: 0.01 } },
        },
      };

      const held = await outcome(
        models(budgeted).call(await callOf(each.model))
      );

      expect(held).toBe(
        // An endpoint of the organization's own has no price to bound.
        each.provider === "openai-compatible"
          ? "model.unpriced"
          : "model.over_budget"
      );
      await expect(carrying(key)).resolves.toStrictEqual([]);
    });
  });
});
