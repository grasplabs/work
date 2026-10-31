import { toBase64 } from "@grasp-os/shared/encoding";
import type { SessionApi } from "@grasp-os/shared/rpc";
import { uploadTypes } from "@grasp-os/shared/uploads";
import type { Upload } from "@grasp-os/shared/uploads";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { extractUpload, originalKey } from "../src/knowledge/uploads.ts";
import { usableAnswerTokens } from "../src/models.ts";
import type { PlannedReply } from "./ai-providers-fake.ts";
import { allEvents } from "./audit-events.ts";
import {
  platformAnthropicKey,
  platformOpenAiKey,
} from "./connect-providers.ts";
import { mockIdp } from "./idp.ts";
import { newTeam } from "./knowledge.ts";
import { streamText } from "./model-provider.ts";
import { carrying, keyPlaces, plan, sentCount } from "./platform-providers.ts";
import { outcome, signedInApi, unique } from "./sign-in.ts";

// Which extractor reads an uploaded file: Grasp's own document conversion
// (@grasp-os/shared/platform-ai), OpenAI's by default, for a PDF in a
// normal collection, through the model gateway and connect with Grasp's
// key; and the Worker itself for any other file, a sensitive collection's,
// a deployment whose rules keep everything in the EU, and where the
// platform's settings say `local`. A sensitive file never leaves the
// deployment. The providers are the outside systems: fakes behind
// connect's fetch, which keep what they were sent. Connect, the gateway,
// the ledger and the audit log are real.

const idp = mockIdp();

/** A test file, from the fixtures the test assets serve. */
const fixture = async (name: string): Promise<Uint8Array> => {
  const response = await env.ASSETS.fetch(`https://assets/uploads/${name}`);
  return new Uint8Array(await response.arrayBuffer());
};

/** A conversion's answer, as `api` streams it. */
const converted = (
  api: Parameters<typeof streamText>[0],
  markdown: string,
  { truncated = false } = {}
): PlannedReply => ({
  sse: streamText(api, {
    text: markdown,
    inputTokens: 2000,
    outputTokens: 100,
    truncated,
  }),
});

/** The upload once its extraction has ended, ready or failed. */
const ended = async (api: SessionApi, uploadId: string): Promise<Upload> =>
  await vi.waitFor(
    async () => {
      const upload = await api.uploads.get(uploadId);
      if (upload.status !== "ready" && upload.status !== "failed") {
        throw new Error(`Upload ${uploadId} is ${upload.status}`);
      }
      return upload;
    },
    { timeout: 20_000, interval: 100 }
  );

/** A file name no other test uploads, so what reached a provider with it is this test's. */
const newName = (extension: "pdf" | "docx"): string =>
  `policy-${unique()}.${extension}`;

/** Uploads a fixture as `name` into `collectionId` and waits for it to end. */
const uploadedTo = async (
  api: SessionApi,
  collectionId: string,
  name: string,
  file = name.endsWith(".pdf") ? "expense-policy.pdf" : "travel-policy.docx"
): Promise<Upload> => {
  const upload = await api.uploads.upload({
    collectionId,
    name,
    bytes: await fixture(file),
  });
  return await ended(api, upload.id);
};

/** Which extractor the audit log says read `upload`. */
const extractorOf = async (upload: Upload): Promise<unknown> => {
  const events = await allEvents();
  return events.find(
    ({ action, target }) =>
      action === "knowledge.upload.extracted" && target?.id === upload.id
  )?.detail.extractor;
};

/** How many times the audit log says `upload` was sent out to be converted. */
const timesSent = async (upload: Upload): Promise<number> => {
  const events = await allEvents();
  return events.filter(
    ({ action, target, detail }) =>
      action === "knowledge.upload.sent" &&
      target?.id === upload.id &&
      detail.extractor === "platform"
  ).length;
};

/** Runs `run` with `config` as the deployment's rules for model calls. */
const withDeployment = async <T>(
  config: unknown,
  run: () => Promise<T>
): Promise<T> => {
  const { MODEL_GATEWAY: gateway } = env;
  env.MODEL_GATEWAY = config;
  try {
    return await run();
  } finally {
    env.MODEL_GATEWAY = gateway;
  }
};

/** Runs `run` with `settings` as the platform's AI settings. */
const withPlatformAi = async <T>(
  settings: unknown,
  run: () => Promise<T>
): Promise<T> => {
  const { PLATFORM_AI: before } = env;
  env.PLATFORM_AI = settings;
  try {
    return await run();
  } finally {
    env.PLATFORM_AI = before;
  }
};

/** Rules that keep every call of the deployment in the EU. */
const euOnly = {
  eu: { models: ["mistral/mistral-large-latest"], deployment: true },
};

/** A collection of the person's own, normal: not sensitive. */
const ownCollection = async (api: SessionApi): Promise<string> => {
  const { id } = await api.knowledge.createCollection({
    name: `Files ${unique()}`,
    access: "me",
  });
  return id;
};

// Each test waits for an upload to end, up to 20 seconds (`ended`): more
// than Vitest's default five on a loaded runner. Sixty leaves room for
// signing in and making a team.
describe("upload routing", { timeout: 60_000 }, () => {
  it("converts a normal collection's PDF through OpenAI with Grasp's key, and saves what it returns", async () => {
    const person = await signedInApi(idp, "user");
    const collectionId = await ownCollection(person.api);
    const name = newName("pdf");
    await plan(platformOpenAiKey, [
      converted(
        "openai-responses",
        "# Expense policy\n\n## Travel\n\nFly economy."
      ),
    ]);

    const upload = await uploadedTo(person.api, collectionId, name);

    const { hits } = await person.api.knowledge.search("economy", {
      collectionId,
    });
    const pdf = await fixture("expense-policy.pdf");
    const [sent] = await carrying(name);
    const body: unknown = JSON.parse(sent?.body ?? "{}");
    const events = await allEvents();
    const call = events.find(
      ({ action, actor, detail }) =>
        action === "model.call" &&
        "userId" in actor &&
        actor.userId === person.userId &&
        detail.platform === "document_conversion"
    );
    expect({
      status: upload.status,
      extractor: await extractorOf(upload),
      recorded: await timesSent(upload),
      hits: hits.map(({ path, headings }) => ({ path, headings })),
      host: sent?.host,
      path: sent?.path,
      body,
    }).toMatchObject({
      status: "ready",
      extractor: "platform",
      recorded: 1,
      hits: [{ path: name, headings: ["Expense policy", "Travel"] }],
      host: "eu.api.openai.com",
      path: "/v1/responses",
      body: {
        model: "gpt-5.4-mini",
        input: [
          // The instructions: the document's text, and nothing else.
          { role: "developer" },
          {
            role: "user",
            content: [
              {
                type: "input_file",
                filename: name,
                file_data: `data:application/pdf;base64,${toBase64(pdf)}`,
              },
              { type: "input_text" },
            ],
          },
        ],
      },
    });
    expect(call).toMatchObject({
      model: { provider: "openai", model: "gpt-5.4-mini" },
      detail: {
        purpose: "knowledge.conversion",
        transport: "connect",
        credential: "platform",
      },
    });
    await expect(keyPlaces(name, platformOpenAiKey)).resolves.toStrictEqual({
      hosts: ["eu.api.openai.com"],
      headers: ["authorization"],
      inBody: false,
      placeholder: false,
    });
  });

  it("asks for the model's whole output, and continues an answer cut off at it until the document is whole", async () => {
    const person = await signedInApi(idp, "user");
    const collectionId = await ownCollection(person.api);
    const name = newName("pdf");
    await plan(platformOpenAiKey, [
      converted("openai-responses", "# Expense policy\n\n## Travel\n\nFly", {
        truncated: true,
      }),
      converted("openai-responses", " economy, always."),
    ]);

    const upload = await uploadedTo(person.api, collectionId, name);

    const { hits } = await person.api.knowledge.search("always", {
      collectionId,
    });
    const carried = await carrying(name);
    const sent = carried.map(({ body }) =>
      z
        .object({
          max_output_tokens: z.number(),
          input: z.array(
            z.object({ role: z.string(), content: z.unknown() }).loose()
          ),
        })
        .parse(JSON.parse(body))
    );
    expect({
      status: upload.status,
      hits: hits.map(({ path }) => path),
      requests: sent.length,
      // The catalog's cap for the model, not the gateway's default.
      capped: sent.every(
        ({ max_output_tokens: cap }) =>
          cap === usableAnswerTokens("openai/gpt-5.4-mini") && cap > 16_384
      ),
      // The second carries what the first wrote, and asks to go on.
      continued: sent[1]?.input.map(({ role }) => role),
      wrote: JSON.stringify(sent[1]?.input).includes("Fly"),
    }).toStrictEqual({
      status: "ready",
      hits: [name],
      requests: 2,
      capped: true,
      continued: ["developer", "user", "assistant", "user"],
      wrote: true,
    });
  });

  it("fails as too large a document whose answer, cut off, can't be continued", async () => {
    const person = await signedInApi(idp, "user");
    const collectionId = await ownCollection(person.api);
    const name = newName("pdf");
    await plan(platformOpenAiKey, [
      converted("openai-responses", "# Expense policy", { truncated: true }),
      converted("openai-responses", "", { truncated: true }),
    ]);

    const upload = await uploadedTo(person.api, collectionId, name);

    expect({
      status: upload.status,
      failure: upload.failure?.code,
      requests: await sentCount(name),
    }).toStrictEqual({
      status: "failed",
      failure: "knowledge.too_large",
      requests: 2,
    });
  });

  it("converts on Anthropic when the platform's settings say so, with Grasp's key there", async () => {
    const person = await signedInApi(idp, "user");
    const collectionId = await ownCollection(person.api);
    const name = newName("pdf");
    await plan(platformAnthropicKey, [
      converted("anthropic-messages", "# Expense policy\n\nClaim in a week."),
    ]);

    const upload = await withPlatformAi(
      { conversion: { provider: "anthropic", model: "claude-haiku-4-5" } },
      async () => await uploadedTo(person.api, collectionId, name)
    );

    // Only this test converts on Anthropic: what carries Grasp's key there.
    const [sent, ...more] = await carrying(platformAnthropicKey);
    const pdf = await fixture("expense-policy.pdf");
    const body: unknown = JSON.parse(sent?.body ?? "{}");
    expect({
      status: upload.status,
      extractor: await extractorOf(upload),
      requests: more.length + 1,
      host: sent?.host,
      body,
    }).toMatchObject({
      status: "ready",
      extractor: "platform",
      requests: 1,
      host: "api.anthropic.com",
      body: {
        model: "claude-haiku-4-5",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document",
                source: {
                  type: "base64",
                  media_type: "application/pdf",
                  data: toBase64(pdf),
                },
              },
              { type: "text" },
            ],
          },
        ],
      },
    });
  });

  it.each([
    [
      "Grasp has no key for the conversion's provider",
      { conversion: { provider: "openrouter", model: "openai/gpt-5-mini" } },
    ],
    [
      "the platform's settings don't parse",
      { conversion: { provider: "no-such-provider", model: "toMarkdown" } },
    ],
    // Broken JSON meant to keep conversion local: never OpenAI's default.
    [
      "the platform's settings aren't JSON",
      '{"conversion": {"provider": "local"',
    ],
    ["the platform's settings are null", "null"],
  ])(
    "fails a PDF at once while %s, sending nothing, never read another way",
    async (_, settings) => {
      const person = await signedInApi(idp, "user");
      const collectionId = await ownCollection(person.api);
      const name = newName("pdf");

      const upload = await withPlatformAi(
        settings,
        async () => await uploadedTo(person.api, collectionId, name)
      );

      expect({
        status: upload.status,
        failure: upload.failure?.code,
        sent: await carrying(name),
      }).toStrictEqual({
        status: "failed",
        failure: "upload.conversion_unavailable",
        sent: [],
      });
    }
  );

  it("reads a Word file in the Worker, sending nothing", async () => {
    const person = await signedInApi(idp, "user");
    const collectionId = await ownCollection(person.api);
    const name = newName("docx");

    const upload = await uploadedTo(person.api, collectionId, name);

    expect({
      status: upload.status,
      extractor: await extractorOf(upload),
      recorded: await timesSent(upload),
      sent: await carrying(name),
    }).toStrictEqual({
      status: "ready",
      extractor: "local",
      recorded: 0,
      sent: [],
    });
  });

  it("never sends a sensitive collection's PDF out", async () => {
    const admin = await signedInApi(idp, "admin");
    const team = await newTeam(admin, []);
    const { id: collectionId } = await admin.api.knowledge.createCollection({
      name: `Payroll ${unique()}`,
      access: "teams",
      teams: [team],
      sensitive: true,
    });
    const name = newName("pdf");

    const upload = await uploadedTo(admin.api, collectionId, name);

    expect({
      sent: await carrying(name),
      status: upload.status,
      extractor: await extractorOf(upload),
    }).toStrictEqual({ sent: [], status: "ready", extractor: "local" });
  });

  it("converts an EU-only deployment's PDF at OpenAI's EU host, where Grasp's project keeps its data", async () => {
    const person = await signedInApi(idp, "user");
    const collectionId = await ownCollection(person.api);
    const name = newName("pdf");
    await plan(platformOpenAiKey, [
      converted("openai-responses", "# Expense policy\n\nFly economy."),
    ]);

    const upload = await withDeployment(
      euOnly,
      async () => await uploadedTo(person.api, collectionId, name)
    );

    const sent = await carrying(name);
    expect({
      status: upload.status,
      extractor: await extractorOf(upload),
      hosts: sent.map(({ host }) => host),
    }).toStrictEqual({
      status: "ready",
      extractor: "platform",
      hosts: ["eu.api.openai.com"],
    });
  });

  it("keeps every file of an EU-only deployment in the Worker while Grasp's project is in the US", async () => {
    const person = await signedInApi(idp, "user");
    const collectionId = await ownCollection(person.api);
    const name = newName("pdf");
    const uploads: Upload[] = [];

    await withDeployment(euOnly, async () => {
      await withPlatformAi({ region: "us" }, async () => {
        uploads.push(await uploadedTo(person.api, collectionId, name));
      });
    });

    expect({
      sent: await carrying(name),
      uploads: await Promise.all(
        uploads.map(async (upload) => ({
          status: upload.status,
          extractor: await extractorOf(upload),
          sent: await timesSent(upload),
        }))
      ),
    }).toStrictEqual({
      sent: [],
      uploads: [{ status: "ready", extractor: "local", sent: 0 }],
    });
  });

  it("keeps a file in the Worker while the deployment's rules don't parse", async () => {
    const person = await signedInApi(idp, "user");
    const collectionId = await ownCollection(person.api);
    const name = newName("pdf");
    let upload: Upload | undefined;

    await withDeployment({ ...euOnly, eu: { deployment: "yes" } }, async () => {
      upload = await uploadedTo(person.api, collectionId, name);
    });

    expect({
      sent: await carrying(name),
      status: upload?.status,
      extractor: upload && (await extractorOf(upload)),
      recorded: upload && (await timesSent(upload)),
    }).toStrictEqual({
      sent: [],
      status: "ready",
      extractor: "local",
      recorded: 0,
    });
  });

  it("reads every file in the Worker where the platform's settings say local, as on-prem", async () => {
    const person = await signedInApi(idp, "user");
    const collectionId = await ownCollection(person.api);
    const name = newName("pdf");
    const upload = await withPlatformAi(
      { conversion: { provider: "local" } },
      async () => await uploadedTo(person.api, collectionId, name)
    );

    expect({
      sent: await carrying(name),
      status: upload.status,
      extractor: await extractorOf(upload),
    }).toStrictEqual({ sent: [], status: "ready", extractor: "local" });
  });

  it("sends nothing out while the record that it's sent can't be written", async () => {
    const person = await signedInApi(idp, "user");
    const collectionId = await ownCollection(person.api);
    const bytes = await fixture("expense-policy.pdf");
    const id = crypto.randomUUID();
    const name = newName("pdf");
    const now = Date.now();
    await env.FILES.put(originalKey(collectionId, id), bytes);
    await env.DB.prepare(
      `INSERT INTO uploads (id, collection_id, path, media_type, bytes, sha256,
         uploaded_by, actor, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'x', ?, ?, 'pending', ?, ?)`
    )
      .bind(
        id,
        collectionId,
        name,
        uploadTypes.pdf,
        bytes.length,
        person.userId,
        JSON.stringify({ type: "person", userId: person.userId }),
        now,
        now
      )
      .run();
    // Core's database refusing every batch: the record's too.
    const refusing = new Proxy(env.DB, {
      get: (target, property) => {
        if (property === "batch") {
          return async () =>
            await Promise.reject(new Error("D1 is down for a moment"));
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function"
          ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
          : value;
      },
    });

    const refused = await outcome(extractUpload({ ...env, DB: refusing }, id));

    expect({ refused, sent: await carrying(name) }).toStrictEqual({
      refused: "Error: D1 is down for a moment",
      sent: [],
    });
  });

  it("retries the conversion while the provider fails, recording each time the file was sent, then fails", async () => {
    const person = await signedInApi(idp, "user");
    const collectionId = await ownCollection(person.api);
    const name = newName("pdf");
    // The first try and its three retries, each failed by the provider.
    await plan(
      platformOpenAiKey,
      Array.from({ length: 4 }, () => ({ status: 503 }))
    );
    // Every retry due at once.
    env.WORKFLOW_RETRY_DELAY_MS = "0";
    let upload: Upload;
    try {
      upload = await uploadedTo(person.api, collectionId, name);
    } finally {
      Reflect.deleteProperty(env, "WORKFLOW_RETRY_DELAY_MS");
    }

    expect({
      tries: await sentCount(name),
      recorded: await timesSent(upload),
      status: upload.status,
      failure: upload.failure,
    }).toStrictEqual({
      tries: 4,
      recorded: 4,
      status: "failed",
      failure: {
        code: "internal.unexpected",
        message: "Something went wrong.",
      },
    });
  });

  it("fails a PDF the model finds no text in at once, with a record that it was sent", async () => {
    const person = await signedInApi(idp, "user");
    const collectionId = await ownCollection(person.api);
    const name = newName("pdf");
    await plan(platformOpenAiKey, [converted("openai-responses", "  ")]);

    const upload = await uploadedTo(person.api, collectionId, name);

    expect({
      tries: await sentCount(name),
      recorded: await timesSent(upload),
      status: upload.status,
      failure: upload.failure?.code,
    }).toStrictEqual({
      tries: 1,
      recorded: 1,
      status: "failed",
      failure: "upload.no_text",
    });
  });
});
