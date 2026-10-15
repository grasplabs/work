import type { AuditEvent } from "@grasp-os/shared/audit";
import { sha256Hex } from "@grasp-os/shared/encoding";
import type { Json } from "@grasp-os/shared/json";
import type { ModelBindingSpend } from "@grasp-os/shared/models";
import { knowledgeSearchMaxLength } from "@grasp-os/shared/operation-limits";
import type { OperationResult } from "@grasp-os/shared/operations";
import { permissionErrors } from "@grasp-os/shared/permissions";
import type {
  ModelBindingBudgetInput,
  ResourceBindingsReview,
} from "@grasp-os/shared/resource-bindings";
import { valueDepth } from "@grasp-os/shared/value-depth";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { callAppFunction } from "../src/app-functions.ts";
import type { FunctionAnswer } from "../src/app-functions.ts";
import type { Release } from "../src/app-releases.ts";
import { appFor, commitFiles, setCurrentVersion } from "../src/apps.ts";
import {
  appMembers,
  appResourceBindings,
  permissions as permissionRows,
} from "../src/db/core/schema.ts";
import { createCollection } from "../src/knowledge/collections.ts";
import { saveDocument } from "../src/knowledge/documents.ts";
import {
  grantPermission,
  requestPermission,
  revokePermission,
} from "../src/permissions.ts";
import { revokeRelease } from "../src/release-retention.ts";
import { invocationSources } from "../src/resource-adapter.ts";
import {
  approveResourceBinding,
  listResourceBindings,
  reviewResourceBindings,
  revokeResourceBinding,
} from "../src/resource-bindings.ts";
import { publishTemplate, templateAdapter } from "../src/resource-templates.ts";
import { isRestricted } from "../src/restricted.ts";
import { fakeGateway } from "./ai-gateway.ts";
import type { GatewayReply } from "./ai-gateway.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { appWith, failure, person, seal } from "./sealed-apps.ts";
import type { Fixture } from "./sealed-apps.ts";
import { openRpc, signedInWithRole } from "./sign-in.ts";

// An App's declared resources reach real providers only through bindings
// an admin approved, and the live grant each names, through core's
// operation host (spec 12, 32.3). Each request resolves its binding again,
// so revoking it, changing the declaration or losing the target stops the
// next one; the model gateway is the real one, with only AI Gateway behind
// the AI binding faked.

/** The model the tests' deployment allows. */
const allowedModel = "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/**
 * The `writer` token bound at which one request reserves some $0.009 for
 * its longest answer: one fits a cent, two never do.
 */
const nearCentBound = 3800;

/**
 * The `writer` token bound at which one request reserves some $0.0117:
 * more than a cent, one fits two cents, two never do.
 */
const overCentBound = 5000;

/** An App whose actions use a text model and a structured one. */
const modelFiles = (
  maxOutputTokens = 300,
  taggerTokens = 200
): Record<string, string> => ({
  "schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({
  notes: defineTable({ title: v.string() }),
});
`,
  "operations/assist.ts": `import { resource, v } from "@grasp-os/sdk";
import { action } from "#grasp/server";

export const writer = resource.model("writer", { maxOutputTokens: ${maxOutputTokens} });

export const tagger = resource.model("tagger", {
  structuredOutput: v.object({ tags: v.array(v.string().trim().min(1)).max(5) }),
  maxOutputTokens: ${taggerTokens},
});

export const labeler = resource.model("labeler", {
  structuredOutput: v.object({ label: v.string(), status: v.string().default("draft") }),
  maxOutputTokens: 200,
});

export const label = action({
  args: { text: v.string().min(1) },
  returns: v.object({ label: v.string(), status: v.string() }),
  uses: [labeler],
  handler: async (ctx, args) => await ctx.resources.labeler.generate({ prompt: args.text }),
});

export const draft = action({
  args: { prompt: v.string().min(1) },
  returns: v.string(),
  uses: [writer],
  handler: async (ctx, args) =>
    await ctx.resources.writer.generate({ prompt: args.prompt, instructions: "Be brief." }),
});

export const tag = action({
  args: { text: v.string().min(1) },
  returns: v.object({ tags: v.array(v.string()) }),
  uses: [tagger],
  handler: async (ctx, args) => await ctx.resources.tagger.generate({ prompt: args.text }),
});

/** Everything App code can see of its model client, and what it answered. */
export const probe = action({
  args: {},
  returns: v.string(),
  uses: [writer],
  handler: async (ctx) => {
    const client = ctx.resources.writer;
    const answer = await client.generate({ prompt: "Hi" });
    const prototype = Object.getPrototypeOf(client) ?? {};
    return [
      answer,
      JSON.stringify(client),
      Object.getOwnPropertyNames(client).join(","),
      Object.getOwnPropertyNames(prototype).join(","),
      String(client.generate),
      Object.getOwnPropertyNames(globalThis).join(","),
    ].join("\\n");
  },
});

/** Two requests in one call; says how the second ended. */
export const twice = action({
  args: {},
  returns: v.string(),
  uses: [writer],
  handler: async (ctx) => {
    const first = await ctx.resources.writer.generate({ prompt: "one" });
    try {
      await ctx.resources.writer.generate({ prompt: "two" });
      return \`\${first}|ran\`;
    } catch (error) {
      // A platform refusal reaches App code as an error with its code.
      return \`\${first}|\${String(Reflect.get(Object(error), "code"))}\`;
    }
  },
});

/** One request; what App code sees of a refusal: its code and when to ask again. */
export const attempt = action({
  args: { prompt: v.string().min(1) },
  returns: v.string(),
  uses: [writer],
  handler: async (ctx) => {
    try {
      return await ctx.resources.writer.generate({ prompt: "Hi" });
    } catch (error) {
      const details = Object(Reflect.get(Object(error), "details"));
      return [
        Reflect.get(Object(error), "code"),
        Reflect.get(details, "retryAfterSeconds"),
      ].map(String).join("|");
    }
  },
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { attempt, draft, label, labeler, probe, tag, tagger, twice, writer } from "./operations/assist.ts";
import schema from "./schema.ts";

export default app({
  name: "Assistant",
  schema,
  access: { tables: { notes: { read: "owner", write: "owner" } } },
  operations: { assist: { draft, tag, twice, probe, label, attempt } },
  internalOperations: {},
  screens: [],
  uses: [writer, tagger, labeler],
});
`,
});

type Sealed = Fixture & { release: Release };

/** An App with `files`, sealed and current. */
const sealedApp = async (
  files: Record<string, string>,
  name?: string
): Promise<Sealed> => {
  const fixture = await appWith(files, name);
  const release = await seal(fixture);
  await setCurrentVersion(env, fixture.owner, fixture.app, 1);
  return { ...fixture, release };
};

/** Commits `files` as the App's next version, seals it and makes it current. */
const nextVersion = async (
  sealed: Sealed,
  files: Record<string, string>,
  version: number
): Promise<Sealed> => {
  await commitFiles(env, sealed.owner, sealed.app, files, "Next version");
  const release = await seal(sealed, version);
  await setCurrentVersion(env, sealed.owner, sealed.app, version);
  return { ...sealed, release };
};

/** The request a screen sends to call `path` of `release`. */
const requestFor = (release: Release, path: string, input: unknown): string => {
  const operation = release.app.operations[path];
  if (operation === undefined) {
    throw new Error(`No ${path}`);
  }
  return JSON.stringify({
    reference: {
      resourceId: release.manifest.resourceId,
      resourceVersion: release.manifest.resourceVersion,
      contractId: path,
      fingerprint: release.fingerprints[path] ?? "",
      kind: operation.kind,
    },
    input,
  });
};

/** Core's env with the fake gateway, the allowlist `models` and `rules`. */
const gatewayEnv = (
  replies: GatewayReply[],
  models: string[] = [allowedModel],
  rules: Record<string, unknown> = {}
) => {
  const gateway = fakeGateway(...replies);
  const withGateway: Env = {
    ...env,
    MODEL_GATEWAY: { gateway: "grasp-os-test", models, ...rules },
  };
  // The fake's binding is the AI binding as the model gateway reads it.
  Reflect.set(withGateway, "AI", gateway.binding);
  return { gateway, gatewayEnv: withGateway };
};

const answer = (text: string): GatewayReply => ({
  text,
  inputTokens: 100,
  outputTokens: 20,
});

/** Calls `path` of the App as its owner, through `callEnv`. */
const call = async (
  callEnv: Env,
  { app, owner, release }: Sealed,
  path: string,
  input: unknown
): Promise<OperationResult> => {
  const answered = await callAppFunction(
    callEnv,
    owner,
    app,
    requestFor(release, path, input)
  );
  return answered.result;
};

/** The code of an error something threw. */
const codeOfError = (error: unknown): string =>
  error instanceof Error ? String(Reflect.get(error, "code")) : "?";

/** Knowledge hits, as an action answers them. */
const hitsSchema = z.array(
  z.strictObject({ title: z.string(), excerpt: z.string() })
);

/** What a call answered: its value, or its error's code. */
const outcomeOf = (result: OperationResult): Json =>
  result.ok ? result.value : { failed: result.error.code };

/** An admin's approval of `alias` of the App to the allowed model. */
const approveModel = async (
  sealed: Sealed,
  alias: string,
  version = sealed.release.manifest.resourceVersion
) =>
  await approveResourceBinding(env, await person("admin"), {
    app: sealed.app,
    alias,
    target: { kind: "model", model: allowedModel },
    reviewed: { version },
  });

/** The audit log's events of `action` about App `app`, outboxes drained. */
const auditedFor = async (
  action: string,
  app: string
): Promise<AuditEvent[]> => {
  const events = await allEvents();
  return events.filter(
    (event) =>
      event.action === action &&
      (event.target?.id === app ||
        (event.actor.type === "app" && event.actor.appId === app))
  );
};

/** The gateway's request `index`, as JSON text. */
const sentText = (
  gateway: ReturnType<typeof fakeGateway>,
  index: number
): string => JSON.stringify(gateway.requests[index]?.body ?? null);

/** An approval of the App's `writer` to the allowed model, as a client sends it. */
const writerApproval = (sealed: Sealed) => ({
  app: sealed.app,
  alias: "writer",
  target: { kind: "model", model: allowedModel },
  reviewed: { version: 1 },
});

/** An App whose actions search and read two Knowledge collections. */
const knowledgeFiles = (): Record<string, string> => ({
  "schema.ts": modelFiles()["schema.ts"] ?? "",
  "operations/help.ts": `import { resource, v } from "@grasp-os/sdk";
import { action } from "#grasp/server";

export const help = resource.knowledge("help", {
  operations: ["search", "read"],
  collections: ["handbook", "salaries"],
});

export const find = action({
  args: { text: v.string().min(1) },
  returns: v.array(v.object({ title: v.string(), excerpt: v.string() })).max(20),
  uses: [help],
  handler: async (ctx, args) => await ctx.resources.help.search({ text: args.text, limit: 5 }),
});

export const open = action({
  args: { id: v.string().min(1) },
  returns: v.object({ title: v.string(), text: v.string() }),
  uses: [help],
  handler: async (ctx, args) => await ctx.resources.help.read({ id: args.id }),
});

export const writer = resource.model("writer", { maxOutputTokens: 300 });

/** Reads a document, then has the model summarize it. */
export const summarize = action({
  args: { id: v.string().min(1) },
  returns: v.string(),
  uses: [help, writer],
  handler: async (ctx, args) => {
    const document = await ctx.resources.help.read({ id: args.id });
    return await ctx.resources.writer.generate({ prompt: document.text });
  },
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { find, help, open, summarize, writer } from "./operations/help.ts";
import schema from "./schema.ts";

export default app({
  name: "Help",
  schema,
  access: { tables: { notes: { read: "owner", write: "owner" } } },
  operations: { help: { find, open, summarize } },
  internalOperations: {},
  screens: [],
  uses: [help, writer],
});
`,
});

/** A collection permission of the App, asked for by its owner and granted. */
const grantedCollection = async (
  sealed: Sealed,
  admin: Awaited<ReturnType<typeof person>>,
  collectionId: string,
  binding: string
): Promise<string> => {
  const requested = await requestPermission(
    env,
    sealed.owner,
    {
      subject: { type: "app", appId: sealed.app },
      object: { type: "collection", collectionId },
      actions: ["read"],
      binding,
    },
    {
      app: async (app, role) => await appFor(env, sealed.owner, app, role),
      resource: async () =>
        await Promise.reject(
          new Error("No independent resource is named here")
        ),
    }
  );
  await grantPermission(env, admin, requested.id, {
    version: sealed.release.manifest.resourceVersion,
  });
  return requested.id;
};

/**
 * The Help App, sealed and current, with a handbook everyone reads, a
 * sensitive salaries collection of a team its owner is in, and one more
 * collection it was never granted; each holds one document.
 */
const knowledgeApp = async () => {
  const sealed = await sealedApp(knowledgeFiles());
  const admin = await person("admin");
  const team = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO teams (id, name, organization_id, created_at) VALUES (?, 'Payroll', 'organization', ?)"
    ).bind(team, Date.now()),
    ...[sealed.owner, admin].map((member) =>
      env.DB.prepare(
        "INSERT INTO team_members (id, team_id, user_id, created_at) VALUES (?, ?, ?, ?)"
      ).bind(crypto.randomUUID(), team, member.userId, Date.now())
    ),
  ]);
  const teamAdmin = { ...admin, teams: [{ id: team, name: "Payroll" }] };
  const documentIn = async (collectionId: string, path: string, text: string) =>
    await saveDocument(env, teamAdmin, {
      collectionId,
      path,
      text,
      ifVersion: 0,
    });
  const handbook = await createCollection(env, admin, {
    name: "Handbook",
    access: "everyone",
  });
  const salaries = await createCollection(env, teamAdmin, {
    name: "Salaries",
    access: "teams",
    teams: [team],
    sensitive: true,
  });
  const other = await createCollection(env, admin, {
    name: "Other",
    access: "everyone",
  });
  const leave = await documentIn(
    handbook.id,
    "leave.md",
    "# Leave\nAsk your lead before you take leave."
  );
  const pay = await documentIn(
    salaries.id,
    "pay.md",
    "# Pay\nLeave is paid at the usual rate."
  );
  const secret = await documentIn(other.id, "other.md", "# Other\nNot bound.");
  const permissions = {
    handbook: await grantedCollection(sealed, admin, handbook.id, "HANDBOOK"),
    salaries: await grantedCollection(sealed, admin, salaries.id, "SALARIES"),
  };
  const binding = await approveResourceBinding(env, admin, {
    app: sealed.app,
    alias: "help",
    target: { kind: "knowledge", collections: permissions },
    reviewed: { version: 1 },
  });
  return {
    sealed,
    admin,
    team,
    binding,
    permissions,
    collections: { handbook: handbook.id, salaries: salaries.id },
    documents: {
      leave: leave.id,
      pay: pay.id,
      secret: secret.id,
    },
  };
};

/** Calls `path` of the App as its owner: the whole answer. */
const answerOf = async (
  { app, owner, release }: Sealed,
  path: string,
  input: unknown
): Promise<FunctionAnswer> =>
  await callAppFunction(env, owner, app, requestFor(release, path, input));

/** A search text of exactly `length` code units that still finds the leave policy. */
const searchTextOf = (length: number): string =>
  "leave ".repeat(length).slice(0, length);

/** An App whose action reads a letter template. */
const letterFiles = (): Record<string, string> => ({
  "schema.ts": modelFiles()["schema.ts"] ?? "",
  "operations/letters.ts": `import { resource, v } from "@grasp-os/sdk";
import { action } from "#grasp/server";

export const letter = resource.template("letter", { contract: "grasp.letter@1" });

export const read = action({
  args: {},
  returns: v.object({ version: v.number(), greeting: v.string() }),
  uses: [letter],
  handler: async (ctx) => {
    const template = await ctx.resources.letter.read();
    const { content } = template;
    const greeting =
      typeof content === "object" && content !== null && !Array.isArray(content)
        ? String(content.greeting)
        : "";
    return { version: template.version, greeting };
  },
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { letter, read } from "./operations/letters.ts";
import schema from "./schema.ts";

export default app({
  name: "Letters",
  schema,
  access: { tables: { notes: { read: "owner", write: "owner" } } },
  operations: { letters: { read } },
  internalOperations: {},
  screens: [],
  uses: [letter],
});
`,
});

/** The error code publishing `publication` as `by` fails with. */
const publishRefusal = async (
  by: Awaited<ReturnType<typeof person>>,
  publication: object
): Promise<string> =>
  await failure(async () => await publishTemplate(env, by, publication));

/** Letter content whose deepest value is `depth` levels down. */
const deepLetter = (depth: number): Json => {
  let rest: Json = "end";
  for (let level = 2; level < depth; level += 1) {
    rest = [rest];
  }
  return { greeting: "Deep", rest };
};

/** Overwrites version 1 of `templateId` behind the platform's back. */
const tamperTemplate = async (
  templateId: string,
  content: string,
  contentHash?: string
): Promise<void> => {
  await env.DB.prepare(
    "UPDATE resource_templates SET content = ?, content_hash = COALESCE(?, content_hash) WHERE id = ? AND version = 1"
  )
    .bind(content, contentHash ?? null, templateId)
    .run();
};

/** An approval of the Letters App's `letter` to `version` of `templateId`. */
const letterApproval = (
  sealed: Sealed,
  templateId: string,
  version: number
) => ({
  app: sealed.app,
  alias: "letter",
  target: { kind: "template", templateId, version },
  reviewed: { version: 1 },
});

describe("resource bindings", { timeout: 120_000 }, () => {
  it("refuse a model an action declares until an admin binds it", async () => {
    const sealed = await sealedApp(modelFiles());
    const { gateway, gatewayEnv: withGateway } = gatewayEnv([
      answer("A short draft."),
    ]);
    const unbound = await call(withGateway, sealed, "assist.draft", {
      prompt: "Hi",
    });
    const sentUnbound = gateway.requests.length;
    await approveModel(sealed, "writer");
    const bound = await call(withGateway, sealed, "assist.draft", {
      prompt: "Hi",
    });
    expect({
      unbound: outcomeOf(unbound),
      sentUnbound,
      bound: outcomeOf(bound),
    }).toStrictEqual({
      unbound: { failed: "resource.unavailable" },
      sentUnbound: 0,
      bound: "A short draft.",
    });
  });

  it("call a bound model through the gateway, accounted", async () => {
    const sealed = await sealedApp(modelFiles());
    await approveModel(sealed, "writer");
    const { gateway, gatewayEnv: withGateway } = gatewayEnv([
      answer("A short draft."),
    ]);
    await call(withGateway, sealed, "assist.draft", { prompt: "Hi" });
    const [sent] = gateway.requests;
    // The declared token bound, the instructions as the system prompt.
    expect(sent?.body).toMatchObject({
      max_completion_tokens: 300,
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "Hi" },
      ],
    });
    // Recorded and settled by the ledger, for the App.
    const [called] = await auditedFor("model.call", sealed.app);
    expect(called).toMatchObject({
      actor: { type: "app", appId: sealed.app },
      detail: { purpose: "app.resource", ledger: "settled" },
    });
  });

  it("bind a model only when it can give each request's share of the declared bound", async () => {
    // Llama 3.3 answers at most a quarter of its 24,000-token window. The
    // text writer asks for its whole bound at once; the structured tagger
    // for half, as it may ask again.
    const sealed = await sealedApp(modelFiles(6001, 12_000));
    const admin = await person("admin");
    const refused = await failure(
      async () =>
        await approveResourceBinding(env, admin, writerApproval(sealed))
    );
    await approveModel(sealed, "tagger");
    const { gateway, gatewayEnv: withGateway } = gatewayEnv([
      answer('{"tags": ["launch"]}'),
    ]);
    const tagged = await call(withGateway, sealed, "assist.tag", {
      text: "Notes",
    });
    const writers = await listResourceBindings(env, admin, sealed.app);
    expect({
      refused,
      bound: writers.filter(({ alias }) => alias === "writer").length,
      tagged: outcomeOf(tagged),
      sent: gateway.requests.map(({ body }) => body),
    }).toStrictEqual({
      refused: "resource.model_too_small",
      bound: 0,
      tagged: { tags: ["launch"] },
      sent: [expect.objectContaining({ max_completion_tokens: 6000 })],
    });
  });

  it("hold a resource no action uses yet to what an action would ask", async () => {
    // A later version may add an action using the alias, and the binding
    // would serve it while the declaration stays the same.
    const files = modelFiles();
    const sealed = await sealedApp({
      ...files,
      "operations/assist.ts": `${files["operations/assist.ts"] ?? ""}
export const idle = resource.model("idle", { maxOutputTokens: 6001 });
`,
      "app.ts": (files["app.ts"] ?? "")
        .replace("twice, writer }", "twice, writer, idle }")
        .replace(
          "uses: [writer, tagger, labeler]",
          "uses: [writer, tagger, labeler, idle]"
        ),
    });
    await expect(
      failure(async () => await approveModel(sealed, "idle"))
    ).resolves.toBe("resource.model_too_small");
  });

  it("send an App's request the whole bound a model can answer", async () => {
    const sealed = await sealedApp(modelFiles(6000));
    await approveModel(sealed, "writer");
    const { gateway, gatewayEnv: withGateway } = gatewayEnv([
      answer("A long draft."),
    ]);
    const drafted = await call(withGateway, sealed, "assist.draft", {
      prompt: "Hi",
    });
    expect({
      drafted: outcomeOf(drafted),
      sent: gateway.requests.map(({ body }) => body),
    }).toStrictEqual({
      drafted: "A long draft.",
      sent: [expect.objectContaining({ max_completion_tokens: 6000 })],
    });
  });

  it("enforce a model's structured output, asking again once", async () => {
    const sealed = await sealedApp(modelFiles());
    await approveModel(sealed, "tagger");
    const { gateway, gatewayEnv: withGateway } = gatewayEnv([
      answer('{"tags": ["  padded  "]}'),
      answer('{"tags": ["launch", "plans"]}'),
      answer("not json"),
      answer('{"tags": [""]}'),
    ]);
    const fitted = await call(withGateway, sealed, "assist.tag", {
      text: "Notes",
    });
    const neverFitted = await call(withGateway, sealed, "assist.tag", {
      text: "Notes",
    });
    expect({
      fitted: outcomeOf(fitted),
      neverFitted: outcomeOf(neverFitted),
    }).toStrictEqual({
      fitted: { tags: ["launch", "plans"] },
      // Two answers that never fit: the contract the provider broke.
      neverFitted: { failed: "contract.invalid_resource_result" },
    });
    // The declared 200 tokens bound the App's request as a whole: each of
    // its two attempts may take half.
    const ceilings = gateway.requests
      .slice(0, 2)
      .map(
        ({ body }) =>
          z.object({ max_completion_tokens: z.number() }).parse(body)
            .max_completion_tokens
      );
    expect(ceilings).toStrictEqual([100, 100]);
    // The model was told the descriptor's JSON Schema, and why its first
    // answer didn't fit: not in its exact form.
    expect([sentText(gateway, 0), sentText(gateway, 1)]).toStrictEqual([
      expect.stringContaining(String.raw`\"maxItems\":5`),
      expect.stringContaining("exact form"),
    ]);
  });

  it("stop a binding revoked between two requests of one call", async () => {
    const sealed = await sealedApp(modelFiles());
    const binding = await approveModel(sealed, "writer");
    const gate = Promise.withResolvers<unknown>();
    const { gateway, gatewayEnv: withGateway } = gatewayEnv([
      { ...answer("first"), pause: { at: 2, until: gate.promise } },
      answer("never sent"),
    ]);
    const running = call(withGateway, sealed, "assist.twice", {});
    while (gateway.requests.length === 0) {
      // oxlint-disable-next-line no-await-in-loop -- until the first request is out
      await scheduler.wait(10);
    }
    await revokeResourceBinding(env, await person("admin"), binding.id);
    gate.resolve(null);
    const result = await running;
    expect({
      outcome: outcomeOf(result),
      sent: gateway.requests.length,
    }).toStrictEqual({ outcome: "first|resource.unavailable", sent: 1 });
  });

  it("serve only the declaration an admin approved", async () => {
    const sealed = await sealedApp(modelFiles());
    await approveModel(sealed, "writer");
    // The next version asks for longer answers: the binding no longer
    // matches what was reviewed.
    const widened = await nextVersion(sealed, modelFiles(5000), 2);
    const { gateway, gatewayEnv: withGateway } = gatewayEnv([
      answer("Longer."),
    ]);
    const before = await call(withGateway, widened, "assist.draft", {
      prompt: "Hi",
    });
    const sentBefore = gateway.requests.length;
    await approveModel(widened, "writer", 2);
    const after = await call(withGateway, widened, "assist.draft", {
      prompt: "Hi",
    });
    expect({
      before: outcomeOf(before),
      sentBefore,
      after: outcomeOf(after),
    }).toStrictEqual({
      before: { failed: "resource.unavailable" },
      sentBefore: 0,
      after: "Longer.",
    });
  });

  it("stop a model the deployment no longer allows", async () => {
    const sealed = await sealedApp(modelFiles());
    await approveModel(sealed, "writer");
    const { gateway, gatewayEnv: withGateway } = gatewayEnv(
      [answer("Hidden.")],
      ["openai/gpt-5.4"]
    );
    const result = await call(withGateway, sealed, "assist.draft", {
      prompt: "Hi",
    });
    expect({
      outcome: outcomeOf(result),
      sent: gateway.requests.length,
    }).toStrictEqual({ outcome: { failed: "resource.unavailable" }, sent: 0 });
  });

  it("count every request against the person's budget", async () => {
    const sealed = await sealedApp(modelFiles(overCentBound));
    await approveModel(sealed, "writer");
    // Less than the longest answer the declaration allows could cost:
    // refused by the ledger before anything is sent.
    const { gateway, gatewayEnv: withGateway } = gatewayEnv(
      [answer("Too dear.")],
      [allowedModel],
      { budgets: { user: { limit: 0.01 } } }
    );
    const result = await call(withGateway, sealed, "assist.draft", {
      prompt: "Hi",
    });
    expect({
      outcome: outcomeOf(result),
      sent: gateway.requests.length,
    }).toStrictEqual({
      outcome: { failed: "resource.budget_exhausted" },
      sent: 0,
    });
  });

  it("are approved by admins only, never staff or builders", async () => {
    const sealed = await sealedApp(modelFiles());
    const staff = { ...(await person("admin")), staff: true };
    const approval = writerApproval(sealed);
    const refused = {
      builder: await failure(
        async () => await approveResourceBinding(env, sealed.owner, approval)
      ),
      staff: await failure(
        async () => await approveResourceBinding(env, staff, approval)
      ),
    };
    expect(refused).toStrictEqual({
      builder: "role.forbidden",
      staff: "role.forbidden",
    });
  });

  it("bind only what the reviewed version declares, to what may serve it", async () => {
    const sealed = await sealedApp(modelFiles());
    const admin = await person("admin");
    const approval = writerApproval(sealed);
    const refusal = async (change: object) =>
      await failure(
        async () =>
          await approveResourceBinding(env, admin, { ...approval, ...change })
      );
    expect({
      undeclared: await refusal({ alias: "mailer" }),
      otherKind: await refusal({
        target: { kind: "template", templateId: "letter", version: 1 },
      }),
      notAllowed: await refusal({
        target: { kind: "model", model: "openai/gpt-5.4" },
      }),
      notCurrent: await refusal({ reviewed: { version: 2 } }),
    }).toStrictEqual({
      undeclared: "resource.undeclared",
      otherKind: "resource.undeclared",
      notAllowed: "resource.target_invalid",
      notCurrent: "app.conflict",
    });
  });

  it("replace an alias's binding when approved again, audited", async () => {
    const sealed = await sealedApp(modelFiles());
    const admin = await person("admin");
    const first = await approveResourceBinding(
      env,
      admin,
      writerApproval(sealed)
    );
    const second = await approveResourceBinding(
      env,
      admin,
      writerApproval(sealed)
    );
    const listed = await listResourceBindings(env, sealed.owner, sealed.app);
    expect(listed.map(({ id, status }) => ({ id, status }))).toStrictEqual([
      { id: second.id, status: "active" },
      { id: first.id, status: "revoked" },
    ]);
    const approved = await auditedFor(
      "app.resource_binding.approved",
      sealed.app
    );
    const revoked = await auditedFor(
      "app.resource_binding.revoked",
      sealed.app
    );
    expect({
      approved: approved.map(({ detail }) => detail?.binding),
      revoked: revoked.map(({ detail }) => detail),
    }).toStrictEqual({
      approved: [first.id, second.id],
      revoked: [
        expect.objectContaining({ binding: first.id, replacedBy: second.id }),
      ],
    });
  });

  it("are revoked by admins only, while they are admins", async () => {
    const sealed = await sealedApp(modelFiles());
    const admin = await person("admin");
    const binding = await approveResourceBinding(
      env,
      admin,
      writerApproval(sealed)
    );
    const byBuilder = await failure(
      async () => await revokeResourceBinding(env, sealed.owner, binding.id)
    );
    // An admin demoted since their session was checked changes nothing.
    await env.DB.prepare("UPDATE members SET role = 'member' WHERE user_id = ?")
      .bind(admin.userId)
      .run();
    const byDemoted = await failure(
      async () => await revokeResourceBinding(env, admin, binding.id)
    );
    const still = await drizzle(env.DB)
      .select({ status: appResourceBindings.status })
      .from(appResourceBindings)
      .where(eq(appResourceBindings.id, binding.id))
      .get();
    expect({ byBuilder, byDemoted, still }).toStrictEqual({
      byBuilder: "role.forbidden",
      byDemoted: "role.forbidden",
      still: { status: "active" },
    });
  });

  it("hand App code no key, token or gateway detail", async () => {
    const sealed = await sealedApp(modelFiles());
    await approveModel(sealed, "writer");
    const { gatewayEnv: withGateway } = gatewayEnv([answer("Plain text.")]);
    const result = await call(withGateway, sealed, "assist.probe", {});
    const seen =
      result.ok && typeof result.value === "string" ? result.value : "";
    // Every secret core holds, and what its gateway requests carry.
    const secrets = [
      env.CAPABILITY_SIGNING_KEY,
      env.BETTER_AUTH_SECRET,
      env.ROUTER_SECRET,
      "cf-aig",
      "Bearer",
      "grasp-os-test",
      "workers-binding",
    ];
    expect({
      answered: seen.startsWith("Plain text."),
      leaked: secrets.filter((secret) => seen.includes(secret)),
    }).toStrictEqual({ answered: true, leaked: [] });
  });

  it("serve one App's binding to that App only", async () => {
    const sealed = await sealedApp(modelFiles());
    const other = await sealedApp(modelFiles());
    await approveModel(sealed, "writer");
    const { gateway, gatewayEnv: withGateway } = gatewayEnv([answer("Mine.")]);
    // The same declaration, in another App with no binding of its own.
    const result = await call(withGateway, other, "assist.draft", {
      prompt: "Hi",
    });
    expect({
      outcome: outcomeOf(result),
      sent: gateway.requests.length,
    }).toStrictEqual({ outcome: { failed: "resource.unavailable" }, sent: 0 });
  });

  it("keep one active binding when two approvals of an alias race", async () => {
    const sealed = await sealedApp(modelFiles());
    const [one, two] = await Promise.allSettled([
      approveModel(sealed, "writer"),
      approveModel(sealed, "writer"),
    ]);
    const active = await drizzle(env.DB)
      .select({ id: appResourceBindings.id })
      .from(appResourceBindings)
      .where(
        and(
          eq(appResourceBindings.appId, sealed.app),
          eq(appResourceBindings.status, "active")
        )
      );
    const settled = [one, two].map((outcome) =>
      outcome?.status === "fulfilled"
        ? "approved"
        : codeOfError(outcome?.reason)
    );
    expect({
      active: active.length,
      settled: settled.every(
        (each) => each === "approved" || each === "app.conflict"
      ),
      approved: settled.includes("approved"),
    }).toStrictEqual({ active: 1, settled: true, approved: true });
  });

  it("refuse an approval by an admin demoted since their session was checked", async () => {
    const sealed = await sealedApp(modelFiles());
    const admin = await person("admin");
    await env.DB.prepare("UPDATE members SET role = 'member' WHERE user_id = ?")
      .bind(admin.userId)
      .run();
    const refused = await failure(
      async () =>
        await approveResourceBinding(env, admin, writerApproval(sealed))
    );
    const rows = await drizzle(env.DB)
      .select({ id: appResourceBindings.id })
      .from(appResourceBindings)
      .where(eq(appResourceBindings.appId, sealed.app));
    expect({ refused, rows: rows.length }).toStrictEqual({
      refused: "role.forbidden",
      rows: 0,
    });
  });

  it("tell the model a defaulted field must be given, as the exact form is checked", async () => {
    const sealed = await sealedApp(modelFiles());
    await approveModel(sealed, "labeler");
    const { gateway, gatewayEnv: withGateway } = gatewayEnv([
      answer('{"label": "Launch", "status": "draft"}'),
    ]);
    const result = await call(withGateway, sealed, "assist.label", {
      text: "Notes",
    });
    expect({
      outcome: outcomeOf(result),
      sent: gateway.requests.length,
      told: sentText(gateway, 0).includes(
        String.raw`\"required\":[\"label\",\"status\"]`
      ),
    }).toStrictEqual({
      outcome: { label: "Launch", status: "draft" },
      sent: 1,
      told: true,
    });
  });

  it("stop a release revoked between two requests of one call", async () => {
    const sealed = await sealedApp(modelFiles());
    await approveModel(sealed, "writer");
    const gate = Promise.withResolvers<unknown>();
    const { gateway, gatewayEnv: withGateway } = gatewayEnv([
      { ...answer("first"), pause: { at: 2, until: gate.promise } },
      answer("never sent"),
    ]);
    const running = call(withGateway, sealed, "assist.twice", {});
    while (gateway.requests.length === 0) {
      // oxlint-disable-next-line no-await-in-loop -- until the first request is out
      await scheduler.wait(10);
    }
    await revokeRelease(
      env,
      await person("admin"),
      { app: sealed.app, version: 1 },
      "Compromised"
    );
    gate.resolve(null);
    const result = await running;
    expect({
      outcome: outcomeOf(result),
      sent: gateway.requests.length,
    }).toStrictEqual({ outcome: "first|version.revoked", sent: 1 });
  });

  it("stop a screen caller whose App role is removed between two requests", async () => {
    const sealed = await sealedApp(modelFiles());
    await approveModel(sealed, "writer");
    const user = await person("user");
    await drizzle(env.DB).insert(appMembers).values({
      appId: sealed.app,
      memberType: "person",
      memberId: user.userId,
      role: "user",
      addedBy: sealed.owner.userId,
      addedAt: new Date(),
    });
    const gate = Promise.withResolvers<unknown>();
    const { gateway, gatewayEnv: withGateway } = gatewayEnv([
      { ...answer("first"), pause: { at: 2, until: gate.promise } },
      answer("never sent"),
    ]);
    const running = callAppFunction(
      withGateway,
      user,
      sealed.app,
      requestFor(sealed.release, "assist.twice", {})
    );
    while (gateway.requests.length === 0) {
      // oxlint-disable-next-line no-await-in-loop -- until the first request is out
      await scheduler.wait(10);
    }
    // No longer shared with them: the action already running goes on,
    // but reaches nothing more.
    await drizzle(env.DB)
      .delete(appMembers)
      .where(
        and(
          eq(appMembers.appId, sealed.app),
          eq(appMembers.memberId, user.userId)
        )
      );
    gate.resolve(null);
    const answered = await running;
    expect({
      outcome: outcomeOf(answered.result),
      sent: gateway.requests.length,
    }).toStrictEqual({ outcome: "first|app.not_found", sent: 1 });
  });

  it("stop a call once what admitted its caller no longer holds, between two requests", async () => {
    const sealed = await sealedApp(modelFiles());
    await approveModel(sealed, "writer");
    const { gateway, gatewayEnv: withGateway } = gatewayEnv([
      answer("first"),
      answer("never sent"),
    ]);
    // As an agent's permission revoked mid-call: it holds as the call
    // starts and for its first request, then no more.
    let checks = 0;
    const stillAllowed = async () => {
      checks += 1;
      if (checks > 2) {
        throw permissionErrors.create("permission.denied", { action: "call" });
      }
      await Promise.resolve();
    };
    const answered = await callAppFunction(
      withGateway,
      sealed.owner,
      sealed.app,
      requestFor(sealed.release, "assist.twice", {}),
      Date.now() + 60_000,
      stillAllowed
    );
    expect({
      outcome: outcomeOf(answered.result),
      sent: gateway.requests.length,
    }).toStrictEqual({ outcome: "first|permission.denied", sent: 1 });
  });

  it("answer two racing revocations with the binding as it is", async () => {
    const sealed = await sealedApp(modelFiles());
    const binding = await approveModel(sealed, "writer");
    const admins = [await person("admin"), await person("admin")];
    // Both read it active before either writes.
    const [one, two] = await Promise.all(
      admins.map(
        async (admin) => await revokeResourceBinding(env, admin, binding.id)
      )
    );
    // Revoking it twice records it once: the loser reads it again.
    const revoked = await auditedFor(
      "app.resource_binding.revoked",
      sealed.app
    );
    expect({
      one: one?.status,
      two: two?.status,
      recorded: revoked.length,
    }).toStrictEqual({ one: "revoked", two: "revoked", recorded: 1 });
  });

  it("search and read only the bound collections, as the person may", async () => {
    const { sealed, documents, collections } = await knowledgeApp();
    const found = await answerOf(sealed, "help.find", { text: "leave" });
    const opened = await answerOf(sealed, "help.open", {
      id: documents.leave,
    });
    // A document of a collection the binding doesn't name is no item at
    // all, whatever else the App may read.
    const unbound = await answerOf(sealed, "help.open", {
      id: documents.secret,
    });
    const hits = hitsSchema.parse(outcomeOf(found.result));
    expect({
      // Each collection's best, interleaved; a hit is a title and an excerpt.
      found: hits.map(({ title, excerpt }) => [
        title,
        excerpt.toLowerCase().includes("leave"),
      ]),
      opened: outcomeOf(opened.result),
      unbound: outcomeOf(unbound.result),
    }).toStrictEqual({
      found: [
        ["Leave", true],
        ["Pay", true],
      ],
      opened: {
        title: "Leave",
        text: "# Leave\nAsk your lead before you take leave.",
      },
      unbound: { failed: "resource.item_not_found" },
    });
    // The handbook alone was read: nothing sensitive in the answer.
    expect(opened.provenance).toStrictEqual({
      collectionIds: [collections.handbook],
      sensitive: false,
      restricted: false,
      connections: [],
      truncated: false,
    });
  });

  it("search what the person may read of the bound collections, and nothing else", async () => {
    const { sealed, documents, collections, team } = await knowledgeApp();
    // The App's owner leaves the payroll team: its salaries collection is
    // still bound, but no longer theirs to read.
    await env.DB.prepare(
      "DELETE FROM team_members WHERE team_id = ? AND user_id = ?"
    )
      .bind(team, sealed.owner.userId)
      .run();
    const found = await answerOf(sealed, "help.find", { text: "leave" });
    const opened = await answerOf(sealed, "help.open", { id: documents.pay });
    expect({
      found: hitsSchema
        .parse(outcomeOf(found.result))
        .map(({ title }) => title),
      provenance: found.provenance,
      opened: outcomeOf(opened.result),
    }).toStrictEqual({
      found: ["Leave"],
      provenance: {
        collectionIds: [collections.handbook],
        sensitive: false,
        restricted: false,
        connections: [],
        truncated: false,
      },
      // As a document that doesn't exist.
      opened: { failed: "resource.item_not_found" },
    });
  });

  it("search with text up to Knowledge's own limit, and refuse longer up front", async () => {
    const { sealed } = await knowledgeApp();
    const atLimit = await answerOf(sealed, "help.find", {
      text: searchTextOf(knowledgeSearchMaxLength),
    });
    const pastLimit = await answerOf(sealed, "help.find", {
      text: searchTextOf(knowledgeSearchMaxLength + 1),
    });
    expect({
      atLimit: hitsSchema
        .parse(outcomeOf(atLimit.result))
        .map(({ title }) => title),
      pastLimit: outcomeOf(pastLimit.result),
    }).toStrictEqual({
      atLimit: ["Leave", "Pay"],
      pastLimit: { failed: "contract.invalid_args" },
    });
  });

  it("carry a sensitive source's classification and restrict the App", async () => {
    const { sealed, documents, collections } = await knowledgeApp();
    const authority = {
      subject: { type: "app" as const, appId: sealed.app },
      onBehalfOf: sealed.owner.userId,
      mode: "interactive" as const,
      appVersion: 1,
    };
    const context = { type: "app" as const, appId: sealed.app };
    const before = await isRestricted(env, authority, context);
    const opened = await answerOf(sealed, "help.open", { id: documents.pay });
    expect({
      before,
      after: await isRestricted(env, authority, context),
      provenance: opened.provenance,
    }).toStrictEqual({
      before: false,
      after: true,
      provenance: {
        collectionIds: [collections.salaries],
        sensitive: true,
        restricted: true,
        connections: [],
        truncated: false,
      },
    });
  });

  it("hand what a call read to the gateway's data rules", async () => {
    const { sealed, documents } = await knowledgeApp();
    await approveModel(sealed, "writer");
    // Sensitive data may go to another model only.
    const { gateway, gatewayEnv: withGateway } = gatewayEnv(
      [answer("Leave needs your lead's yes.")],
      [allowedModel, "openai/gpt-5.4"],
      { sensitive: { models: ["openai/gpt-5.4"], connections: [] } }
    );
    const plain = await call(withGateway, sealed, "help.summarize", {
      id: documents.leave,
    });
    const sensitive = await call(withGateway, sealed, "help.summarize", {
      id: documents.pay,
    });
    expect({
      plain: outcomeOf(plain),
      sensitive: outcomeOf(sensitive),
      sent: gateway.requests.length,
    }).toStrictEqual({
      plain: "Leave needs your lead's yes.",
      sensitive: { failed: "resource.unavailable" },
      sent: 1,
    });
  });

  it("stop knowledge whose collection permission was revoked", async () => {
    const { sealed, admin, permissions } = await knowledgeApp();
    await revokePermission(env, admin, permissions.salaries);
    const found = await answerOf(sealed, "help.find", { text: "leave" });
    expect(outcomeOf(found.result)).toStrictEqual({
      failed: "resource.unavailable",
    });
  });

  it("bind knowledge only to the App's own grants, for every collection declared", async () => {
    const { sealed, admin, permissions } = await knowledgeApp();
    const other = await sealedApp(knowledgeFiles());
    const refusal = async (collections: Record<string, string>, app = sealed) =>
      await failure(
        async () =>
          await approveResourceBinding(env, admin, {
            app: app.app,
            alias: "help",
            target: { kind: "knowledge", collections },
            reviewed: { version: 1 },
          })
      );
    expect({
      missing: await refusal({ handbook: permissions.handbook }),
      extra: await refusal({ ...permissions, more: permissions.handbook }),
      anotherApps: await refusal(permissions, other),
    }).toStrictEqual({
      missing: "resource.target_invalid",
      extra: "resource.target_invalid",
      anotherApps: "resource.target_invalid",
    });
  });

  it("read the template version a binding pins, whatever is published later", async () => {
    const sealed = await sealedApp(letterFiles());
    const admin = await person("admin");
    const first = await publishTemplate(env, admin, {
      contract: "grasp.letter@1",
      content: { greeting: "Dear" },
    });
    await approveResourceBinding(
      env,
      admin,
      letterApproval(sealed, first.templateId, 1)
    );
    const second = await publishTemplate(env, admin, {
      templateId: first.templateId,
      contract: "grasp.letter@1",
      content: { greeting: "Hello" },
    });
    const pinned = await call(env, sealed, "letters.read", {});
    await approveResourceBinding(
      env,
      admin,
      letterApproval(sealed, first.templateId, second.version)
    );
    const moved = await call(env, sealed, "letters.read", {});
    expect({
      pinned: outcomeOf(pinned),
      moved: outcomeOf(moved),
    }).toStrictEqual({
      pinned: { version: 1, greeting: "Dear" },
      moved: { version: 2, greeting: "Hello" },
    });
    // Each read is recorded, by the App, of the version it read.
    const reads = await auditedFor("resource.template.read", sealed.app);
    const published = await auditedFor(
      "resource.template.published",
      first.templateId
    );
    expect({
      reads: reads.map(({ detail }) => detail?.version),
      published: published.map(({ detail }) => detail?.version),
    }).toStrictEqual({ reads: [1, 2], published: [1, 2] });
  });

  it("number a template's versions one at a time, even published at once", async () => {
    const admin = await person("admin");
    const first = await publishTemplate(env, admin, {
      contract: "grasp.letter@1",
      content: { greeting: "Dear" },
    });
    const publishNext = async (greeting: string): Promise<string> =>
      await failure(
        async () =>
          await publishTemplate(env, admin, {
            templateId: first.templateId,
            contract: "grasp.letter@1",
            content: { greeting },
          })
      );
    const outcomes = await Promise.all([
      publishNext("Hello"),
      publishNext("Hi"),
    ]);
    const published = await auditedFor(
      "resource.template.published",
      first.templateId
    );
    expect({
      outcomes: outcomes.toSorted(),
      published: published.map(({ detail }) => detail?.version),
    }).toStrictEqual({
      outcomes: ["app.conflict", "ok"],
      published: [1, 2],
    });
  });

  it("publish templates by admins only, keeping each one's contract", async () => {
    const admin = await person("admin");
    const builder = await person("builder");
    const first = await publishTemplate(env, admin, {
      contract: "grasp.letter@1",
      content: { greeting: "Dear" },
    });
    expect({
      builder: await publishRefusal(builder, {
        contract: "grasp.letter@1",
        content: {},
      }),
      otherContract: await publishRefusal(admin, {
        templateId: first.templateId,
        contract: "grasp.invoice@1",
        content: {},
      }),
      unknown: await publishRefusal(admin, {
        templateId: "no-such-template",
        contract: "grasp.letter@1",
        content: {},
      }),
      tooLarge: await publishRefusal(admin, {
        contract: "grasp.letter@1",
        content: { text: "x".repeat(70_000) },
      }),
      // A contract too long to name in the publication's audit event.
      longContract: await publishRefusal(admin, {
        contract: `${"a".repeat(255)}@1`,
        content: {},
      }),
      // Served inside its answer, one level down: too deep to be read.
      tooDeep: await publishRefusal(admin, {
        contract: "grasp.letter@1",
        content: deepLetter(valueDepth),
      }),
    }).toStrictEqual({
      builder: "role.forbidden",
      otherContract: "resource.template_contract_changed",
      unknown: "resource.template_not_found",
      tooLarge: "resource.template_invalid",
      longContract: "resource.template_invalid",
      tooDeep: "resource.template_invalid",
    });
  });

  it("refuse a publication by an admin demoted since their session was checked", async () => {
    const admin = await person("admin");
    await env.DB.prepare("UPDATE members SET role = 'member' WHERE user_id = ?")
      .bind(admin.userId)
      .run();
    const refused = await publishRefusal(admin, {
      contract: "grasp.letter@1",
      content: { greeting: "Stale" },
    });
    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM resource_templates WHERE published_by = ?"
    )
      .bind(admin.userId)
      .first<{ count: number }>();
    expect({ refused, published: rows?.count }).toStrictEqual({
      refused: "role.forbidden",
      published: 0,
    });
  });

  it("bind only a template of the declared contract, and stop one changed in storage", async () => {
    const sealed = await sealedApp(letterFiles());
    const admin = await person("admin");
    const invoice = await publishTemplate(env, admin, {
      contract: "grasp.invoice@1",
      content: { total: 1 },
    });
    const letter = await publishTemplate(env, admin, {
      contract: "grasp.letter@1",
      content: { greeting: "Dear" },
    });
    const otherContract = await failure(
      async () =>
        await approveResourceBinding(
          env,
          admin,
          letterApproval(sealed, invoice.templateId, 1)
        )
    );
    await approveResourceBinding(
      env,
      admin,
      letterApproval(sealed, letter.templateId, 1)
    );
    // A version is never changed; one changed behind the platform's back
    // no longer hashes to what was approved, and serves nothing: changed
    // content, content that isn't JSON, or content changed with its hash.
    const gotcha = JSON.stringify({ greeting: "Gotcha" });
    await tamperTemplate(letter.templateId, gotcha);
    const tampered = await call(env, sealed, "letters.read", {});
    await tamperTemplate(letter.templateId, "{not json");
    const notJson = await call(env, sealed, "letters.read", {});
    await tamperTemplate(letter.templateId, gotcha, await sha256Hex(gotcha));
    const rehashed = await call(env, sealed, "letters.read", {});
    expect({
      otherContract,
      tampered: outcomeOf(tampered),
      notJson: outcomeOf(notJson),
      rehashed: outcomeOf(rehashed),
    }).toStrictEqual({
      otherContract: "resource.target_invalid",
      tampered: { failed: "resource.unavailable" },
      notJson: { failed: "resource.unavailable" },
      rehashed: { failed: "resource.unavailable" },
    });
  });

  it("serve only the approved content, even when storage changes after the binding resolved", async () => {
    const sealed = await sealedApp(letterFiles());
    const admin = await person("admin");
    const letter = await publishTemplate(env, admin, {
      contract: "grasp.letter@1",
      content: { greeting: "Dear" },
    });
    const declaration = {
      "~resource": "template",
      alias: "letter",
      contract: "grasp.letter@1",
    } as const;
    const bound = await templateAdapter.bind(env, sealed.app, declaration, {
      kind: "template",
      templateId: letter.templateId,
      version: 1,
    });
    const served = typeof bound === "object" ? bound : undefined;
    // Between the request resolving its binding and reading it, the row
    // and its hash are both replaced: the read must not serve the new row.
    const gotcha = JSON.stringify({ greeting: "Gotcha" });
    await tamperTemplate(letter.templateId, gotcha, await sha256Hex(gotcha));
    const read = await failure(
      async () =>
        await served?.call(
          {
            app: sealed.app,
            authority: {
              subject: { type: "app", appId: sealed.app },
              onBehalfOf: sealed.owner.userId,
              mode: "interactive",
              appVersion: 1,
            },
            context: { type: "app", appId: sealed.app },
            sources: invocationSources(),
            actor: { type: "app", appId: sealed.app, part: "server" },
          },
          { method: "read", args: [] },
          {
            requestId: crypto.randomUUID(),
            deadline: Date.now() + 10_000,
            idempotencyKey: crypto.randomUUID(),
          },
          {
            id: crypto.randomUUID(),
            declarationHash: "0".repeat(64),
            fingerprint: letter.contentHash,
          },
          { alias: "letter", budget: null }
        )
    );
    expect(read).toBe("resource.unavailable");
  });

  it("serve the deepest content its answer can carry", async () => {
    const sealed = await sealedApp(letterFiles());
    const admin = await person("admin");
    const deepest = await publishTemplate(env, admin, {
      contract: "grasp.letter@1",
      content: deepLetter(valueDepth - 1),
    });
    await approveResourceBinding(
      env,
      admin,
      letterApproval(sealed, deepest.templateId, 1)
    );
    const read = await call(env, sealed, "letters.read", {});
    expect(outcomeOf(read)).toStrictEqual({ version: 1, greeting: "Deep" });
  });
});

/** An admin's approval of the App's `writer`, with its own caps if given. */
const approveWriter = async (
  sealed: Sealed,
  budget?: ModelBindingBudgetInput
) =>
  await approveResourceBinding(env, await person("admin"), {
    ...writerApproval(sealed),
    ...(budget === undefined ? {} : { budget }),
  });

/**
 * An answer that uses most of what a `nearCentBound` request reserves,
 * some $0.0084, and never more: past 80% of a cent on its own.
 */
const longAnswer: GatewayReply = {
  text: "Long.",
  inputTokens: 100,
  outputTokens: 3700,
};

/** Calls `path` of the App through `callEnv`, counting days as `day`. */
const callOn = async (
  callEnv: Env,
  sealed: Sealed,
  path: string,
  day = "2031-01-01"
): Promise<OperationResult> =>
  await call({ ...callEnv, MODEL_BUDGET_DAY: day }, sealed, path, {
    prompt: "Hi",
  });

/** Calls the App's `draft` through `callEnv`: its outcome. */
const draftOn = async (
  callEnv: Env,
  sealed: Sealed,
  day?: string
): Promise<Json> =>
  outcomeOf(await callOn(callEnv, sealed, "assist.draft", day));

describe("model binding budgets", { timeout: 120_000 }, () => {
  it("cap a binding's day, alerting admins, until the next day", async () => {
    const sealed = await sealedApp(modelFiles(nearCentBound));
    await approveWriter(sealed, { perDay: 0.01 });
    const { gateway, gatewayEnv: withGateway } = gatewayEnv([
      longAnswer,
      answer("Next day."),
    ]);
    const first = await draftOn(withGateway, sealed);
    const second = await draftOn(withGateway, sealed);
    const sentThatDay = gateway.requests.length;
    const nextDay = await draftOn(withGateway, sealed, "2031-01-02");
    expect({ first, second, sentThatDay, nextDay }).toStrictEqual({
      first: "Long.",
      second: { failed: "resource.budget_exhausted" },
      sentThatDay: 1,
      nextDay: "Next day.",
    });
    const alerted = await auditedFor("model.budget.alert", sealed.app);
    const refused = await auditedFor("model.refused", sealed.app);
    expect({
      alerted: alerted.map(({ detail }) => detail),
      refused: refused.map(({ detail }) => detail),
    }).toStrictEqual({
      alerted: [
        expect.objectContaining({
          scope: "binding_day",
          app: sealed.app,
          binding: "writer",
          day: "2031-01-01",
          limit: 0.01,
        }),
      ],
      refused: [
        expect.objectContaining({
          reason: "model.over_budget",
          because: "binding_day",
          binding: "writer",
        }),
      ],
    });
  });

  it("count a binding's month at what each request used once it settled", async () => {
    // Two requests' reservations never fit a cent together: the second
    // fits only once the first settled at what it used.
    const sealed = await sealedApp(modelFiles(nearCentBound));
    await approveWriter(sealed, { perMonth: 0.01 });
    const { gateway, gatewayEnv: withGateway } = gatewayEnv([
      answer("One."),
      answer("Two."),
      longAnswer,
      answer("Never sent."),
    ]);
    const outcomes: Json[] = [];
    for (let made = 0; made < 4; made += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one after another
      outcomes.push(await draftOn(withGateway, sealed));
    }
    expect({ outcomes, sent: gateway.requests.length }).toStrictEqual({
      outcomes: [
        "One.",
        "Two.",
        "Long.",
        { failed: "resource.budget_exhausted" },
      ],
      sent: 3,
    });
  });

  it("keep each App's spend apart, whatever their aliases", async () => {
    const one = await sealedApp(modelFiles(nearCentBound));
    const other = await sealedApp(modelFiles(nearCentBound));
    await approveWriter(one, { perDay: 0.01 });
    await approveWriter(other, { perDay: 0.01 });
    const { gateway, gatewayEnv: withGateway } = gatewayEnv([
      longAnswer,
      answer("Other App."),
    ]);
    expect({
      outcomes: [
        await draftOn(withGateway, one),
        await draftOn(withGateway, one),
        await draftOn(withGateway, other),
      ],
      sent: gateway.requests.length,
    }).toStrictEqual({
      outcomes: [
        "Long.",
        { failed: "resource.budget_exhausted" },
        "Other App.",
      ],
      sent: 2,
    });
  });

  it("hold one App request's provider requests to the cap per request, retries included", async () => {
    const sealed = await sealedApp(modelFiles(overCentBound));
    await approveWriter(sealed, { perRequest: 0.01 });
    const { gateway, gatewayEnv: withGateway } = gatewayEnv([
      { status: 500 },
      { status: 500 },
      answer("Retried."),
    ]);
    // Its longest answer alone could cost more than the cap.
    const tooDear = await draftOn(withGateway, sealed);
    const sentTooDear = gateway.requests.length;
    // A server error's outcome is unknown: that request keeps all it
    // reserved, so its retry has no room beside it under $0.02.
    await approveWriter(sealed, { perRequest: 0.02 });
    const retryHeld = await draftOn(withGateway, sealed);
    const sentRetryHeld = gateway.requests.length;
    await approveWriter(sealed, { perRequest: 0.03 });
    const retried = await draftOn(withGateway, sealed);
    const refused = await auditedFor("model.refused", sealed.app);
    expect({
      tooDear,
      sentTooDear,
      retryHeld,
      sentRetryHeld,
      retried,
      sent: gateway.requests.length,
      because: refused.map(({ detail }) => detail?.because),
    }).toStrictEqual({
      tooDear: { failed: "resource.budget_exhausted" },
      sentTooDear: 0,
      retryHeld: { failed: "resource.budget_exhausted" },
      sentRetryHeld: 1,
      retried: "Retried.",
      sent: 3,
      because: ["binding_request", "binding_request"],
    });
  });

  it("give a retry the room a request the provider refused left", async () => {
    // A 429 is refused before the provider took the request on: it costs
    // nothing, so its retry fits beside it under two cents.
    const sealed = await sealedApp(modelFiles(overCentBound));
    await approveWriter(sealed, { perRequest: 0.02 });
    const { gateway, gatewayEnv: withGateway } = gatewayEnv([
      { status: 429 },
      answer("After the refusal."),
    ]);
    expect({
      outcome: await draftOn(withGateway, sealed),
      sent: gateway.requests.length,
    }).toStrictEqual({ outcome: "After the refusal.", sent: 2 });
  });

  it("give a second attempt the room the first left once it settled", async () => {
    // Each attempt reserves some $0.0117 for its half of the bound: both
    // fit two cents only because the first settled at what it used.
    const sealed = await sealedApp(modelFiles(300, overCentBound * 2));
    await approveResourceBinding(env, await person("admin"), {
      app: sealed.app,
      alias: "tagger",
      target: { kind: "model", model: allowedModel },
      reviewed: { version: 1 },
      budget: { perRequest: 0.02 },
    });
    const { gateway, gatewayEnv: withGateway } = gatewayEnv([
      answer("not json"),
      answer('{"tags": ["launch"]}'),
    ]);
    const tagged = await call(withGateway, sealed, "assist.tag", {
      text: "Notes",
    });
    expect({
      outcome: outcomeOf(tagged),
      sent: gateway.requests.length,
    }).toStrictEqual({ outcome: { tags: ["launch"] }, sent: 2 });
  });

  it("refuse a second attempt the room a first of unknown cost still holds", async () => {
    // The first answer came with no count of what it used: it keeps all
    // it reserved, and the second attempt has no room beside it.
    const sealed = await sealedApp(modelFiles(300, overCentBound * 2));
    await approveResourceBinding(env, await person("admin"), {
      app: sealed.app,
      alias: "tagger",
      target: { kind: "model", model: allowedModel },
      reviewed: { version: 1 },
      budget: { perRequest: 0.02 },
    });
    const { gateway, gatewayEnv: withGateway } = gatewayEnv([
      { ...answer("not json"), noUsage: true },
      answer('{"tags": ["never sent"]}'),
    ]);
    const tagged = await call(withGateway, sealed, "assist.tag", {
      text: "Notes",
    });
    expect({
      outcome: outcomeOf(tagged),
      sent: gateway.requests.length,
    }).toStrictEqual({
      outcome: { failed: "resource.budget_exhausted" },
      sent: 1,
    });
  });

  it("tell a busy binding from one used up, worth trying again later", async () => {
    const sealed = await sealedApp(modelFiles(nearCentBound));
    await approveWriter(sealed, { perDay: 0.015 });
    const gate = Promise.withResolvers<unknown>();
    const { gateway, gatewayEnv: withGateway } = gatewayEnv([
      { ...answer("First."), pause: { at: 2, until: gate.promise } },
      answer("Once settled."),
    ]);
    const running = draftOn(withGateway, sealed);
    while (gateway.requests.length === 0) {
      // oxlint-disable-next-line no-await-in-loop -- until the first request is out
      await scheduler.wait(10);
    }
    // The first still holds what it reserved: no room for a second now.
    const racing = await callOn(withGateway, sealed, "assist.draft");
    const seenByApp = await callOn(withGateway, sealed, "assist.attempt");
    gate.resolve(null);
    const first = await running;
    // Once the first settled at what it used, there is room again.
    const after = await draftOn(withGateway, sealed);
    expect({
      first,
      racing: racing.ok
        ? racing.value
        : {
            code: racing.error.code,
            retryable: racing.error.retryable,
            details: racing.error.details,
          },
      seenByApp: outcomeOf(seenByApp),
      after,
      sent: gateway.requests.length,
    }).toStrictEqual({
      first: "First.",
      // A binding's scopes are shared by everyone the App acts for: a
      // fixed wait, never one that tells when others' requests were sent.
      racing: {
        code: "resource.budget_busy",
        retryable: true,
        details: { retryAfterSeconds: 60 },
      },
      seenByApp: "resource.budget_busy|60",
      after: "Once settled.",
      sent: 2,
    });
  });

  it("tell an App its provider's rate limit from a used-up budget, each with when to try again", async () => {
    const sealed = await sealedApp(modelFiles(nearCentBound));
    await approveWriter(sealed, { perDay: 0.01 });
    const { gatewayEnv: withGateway } = gatewayEnv([
      // Refused for its rate, retries and all, the provider asking for a
      // second and a half.
      ...Array.from({ length: 3 }, () => ({
        status: 429,
        errorType: "rate_limit_error",
        headers: { "retry-after-ms": "1500" },
      })),
      longAnswer,
    ]);
    const rateLimited = outcomeOf(
      await callOn(withGateway, sealed, "assist.attempt")
    );
    // Most of the day's cent spent: the next request has no room until
    // the day is over.
    const spent = await draftOn(withGateway, sealed);
    const usedUp = outcomeOf(
      await callOn(withGateway, sealed, "assist.attempt")
    );
    const [code, wait] = (typeof usedUp === "string" ? usedUp : "").split("|");
    expect({
      rateLimited,
      spent,
      usedUp: code,
      untilTheDayIsOver: Number(wait) > 0 && Number(wait) <= 24 * 60 * 60,
    }).toStrictEqual({
      rateLimited: "resource.rate_limited|2",
      spent: "Long.",
      usedUp: "resource.budget_exhausted",
      untilTheDayIsOver: true,
    });
  });

  it("apply a budget approved again to the next request, keeping what was spent", async () => {
    const sealed = await sealedApp(modelFiles(nearCentBound));
    await approveWriter(sealed, { perMonth: 0.01 });
    const { gateway, gatewayEnv: withGateway } = gatewayEnv([
      longAnswer,
      answer("Raised."),
      answer("Never sent."),
    ]);
    const first = await draftOn(withGateway, sealed);
    const spent = await draftOn(withGateway, sealed);
    await approveWriter(sealed, { perMonth: 0.05 });
    const raised = await draftOn(withGateway, sealed);
    // Lowered below what was spent and a request's reservation: one
    // request alone would fit it, had approving again started afresh.
    await approveWriter(sealed, { perMonth: 0.012, alertAt: 50 });
    const lowered = await draftOn(withGateway, sealed);
    const [listed] = await listResourceBindings(env, sealed.owner, sealed.app);
    const approved = await auditedFor(
      "app.resource_binding.approved",
      sealed.app
    );
    const budgetsAudited = approved.map(({ detail }) => [
      detail?.budgetPerRequest,
      detail?.budgetPerDay,
      detail?.budgetPerMonth,
      detail?.budgetAlertAt,
    ]);
    expect({
      outcomes: [first, spent, raised, lowered],
      sent: gateway.requests.length,
      shown: [listed?.budget, listed?.budgetDamaged],
      audited: budgetsAudited.at(-1),
    }).toStrictEqual({
      outcomes: [
        "Long.",
        { failed: "resource.budget_exhausted" },
        "Raised.",
        { failed: "resource.budget_exhausted" },
      ],
      sent: 2,
      shown: [{ perMonth: 0.012, alertAt: 50 }, false],
      audited: [null, null, 0.012, 50],
    });
  });

  it("record that a binding approved without a budget has none", async () => {
    const sealed = await sealedApp(modelFiles());
    const binding = await approveWriter(sealed);
    const [approved] = await auditedFor(
      "app.resource_binding.approved",
      sealed.app
    );
    expect({
      budget: binding.budget,
      audited: [
        approved?.detail?.budgetPerRequest,
        approved?.detail?.budgetPerDay,
        approved?.detail?.budgetPerMonth,
        approved?.detail?.budgetAlertAt,
      ],
    }).toStrictEqual({ budget: null, audited: [null, null, null, null] });
  });

  it("are set for a model binding only, with at least one cap", async () => {
    const sealed = await sealedApp(letterFiles());
    const admin = await person("admin");
    const refused = {
      template: await failure(
        async () =>
          await approveResourceBinding(env, admin, {
            ...letterApproval(sealed, crypto.randomUUID(), 1),
            budget: { perDay: 1 },
          })
      ),
      noCap: await failure(
        async () =>
          await approveResourceBinding(env, admin, {
            ...writerApproval(sealed),
            budget: { alertAt: 50 },
          })
      ),
    };
    expect(refused).toStrictEqual({
      template: "resource.binding_invalid",
      noCap: "resource.binding_invalid",
    });
  });

  it("serve nothing through a binding whose budget is stored damaged, and say so", async () => {
    const sealed = await sealedApp(modelFiles());
    const binding = await approveWriter(sealed, { perDay: 1 });
    await drizzle(env.DB)
      .update(appResourceBindings)
      .set({ budget: JSON.stringify({ perDay: "lots" }) })
      .where(eq(appResourceBindings.id, binding.id));
    const { gateway, gatewayEnv: withGateway } = gatewayEnv([
      answer("Uncapped."),
    ]);
    const outcome = await draftOn(withGateway, sealed);
    const [listed] = await listResourceBindings(env, sealed.owner, sealed.app);
    expect({
      outcome,
      sent: gateway.requests.length,
      shown: [listed?.budget, listed?.budgetDamaged],
    }).toStrictEqual({
      outcome: { failed: "resource.unavailable" },
      sent: 0,
      shown: [null, true],
    });
  });
});

/**
 * What a binding spent today, as it stands to a cent a day alerted at
 * 80%: the capped writer's.
 */
const standing = (amount: number): string | number => {
  if (amount >= 0.008 && amount < 0.01) {
    return "past the alert";
  }
  return amount > 0 && amount < 0.008 ? "under the alert" : amount;
};

/** A listed binding's spend, today's as it `standing`s, and its month as against its day. */
const spent = (listed: ModelBindingSpend | undefined) =>
  listed === undefined
    ? undefined
    : {
        ...listed,
        today: standing(listed.today),
        thisMonth:
          listed.thisMonth === listed.today ? "today's" : listed.thisMonth,
      };

/** App `app`'s active binding's row, to damage what it stores. */
const active = (app: string) =>
  and(
    eq(appResourceBindings.appId, app),
    eq(appResourceBindings.status, "active")
  );

describe("model binding spend", { timeout: 120_000 }, () => {
  const idp = mockIdp();

  /** The model bindings the models settings list, as `role` reads them on `day`. */
  const bindingsOn = async (day: string, role: "admin" | "builder") => {
    const { session } = await signedInWithRole(idp, role);
    const { core } = await openRpc(session, {
      coreEnv: { ...env, MODEL_BUDGET_DAY: day },
    });
    return await core.authenticate().models.settings();
  };

  it("list each App's model bindings with their caps, today's and this month's spend and alert, to admins only", async () => {
    // Named to sort first, ahead of this file's other Apps.
    const capped = await sealedApp(modelFiles(nearCentBound), "0 Capped");
    const free = await sealedApp(modelFiles(), "0 Free");
    await approveWriter(capped, { perDay: 0.01 });
    const freeBinding = await approveWriter(free);
    const { gatewayEnv: withGateway } = gatewayEnv([
      longAnswer,
      answer("Free."),
    ]);
    const first = "2031-02-01";
    // Past 80% of the capped writer's cent a day.
    await draftOn(withGateway, capped, first);
    await draftOn(withGateway, free, first);

    const ours = ({ appId }: { appId: string }): boolean =>
      appId === capped.app || appId === free.app;
    const thatDay = await bindingsOn(first, "admin");
    const nextDay = await bindingsOn("2031-02-02", "admin");
    const [cappedThen, freeThen] = thatDay.bindings.listed.filter(ours);
    const cappedNext = nextDay.bindings.listed.find(ours);
    expect({
      day: thatDay.day,
      capped: spent(cappedThen),
      free: spent(freeThen),
      // Another day starts the day afresh; the month keeps it.
      next: [
        cappedNext?.today,
        cappedNext?.thisMonth === cappedThen?.thisMonth,
        cappedNext?.alert,
      ],
      more: thatDay.bindings.more,
    }).toStrictEqual({
      day: first,
      capped: {
        appId: capped.app,
        appName: "0 Capped",
        alias: "writer",
        model: allowedModel,
        budget: { perDay: 0.01, alertAt: 80 },
        budgetDamaged: false,
        today: "past the alert",
        thisMonth: "today's",
        alert: "alerted",
      },
      free: {
        appId: free.app,
        appName: "0 Free",
        alias: "writer",
        model: allowedModel,
        budget: null,
        budgetDamaged: false,
        today: "under the alert",
        thisMonth: "today's",
        // Counted all the same, with no cap to alert on.
        alert: "none",
      },
      next: [0, true, "none"],
      more: false,
    });

    // A revoked binding isn't listed; one whose caps or target can't be
    // read is, as such, and never hides the others.
    const garbled = await sealedApp(modelFiles(), "0 Garbled");
    await approveWriter(garbled, { perMonth: 3 });
    await revokeResourceBinding(env, await person("admin"), freeBinding.id);
    await drizzle(env.DB)
      .update(appResourceBindings)
      .set({ budget: JSON.stringify({ perDay: "lots" }) })
      .where(active(capped.app));
    await drizzle(env.DB)
      .update(appResourceBindings)
      .set({ target: "{not json" })
      .where(active(garbled.app));
    const later = await bindingsOn(first, "admin");
    expect(
      later.bindings.listed
        .filter(
          ({ appId }) =>
            appId === capped.app || appId === free.app || appId === garbled.app
        )
        .map(({ appId, model, budget, budgetDamaged, alert }) => ({
          appId,
          model,
          budget,
          budgetDamaged,
          alert,
        }))
    ).toStrictEqual([
      {
        appId: capped.app,
        model: allowedModel,
        budget: null,
        budgetDamaged: true,
        alert: "none",
      },
      {
        appId: garbled.app,
        model: null,
        budget: { perMonth: 3, alertAt: 80 },
        budgetDamaged: false,
        alert: "none",
      },
    ]);

    await expect(
      failure(async () => await bindingsOn(first, "builder"))
    ).resolves.toBe("role.forbidden");
  });
});

/**
 * An App whose actions use a model (unless `withWriter` is false), two
 * Knowledge collections and a template of `contract`.
 */
const deskFiles = (
  contract: string,
  withWriter = true
): Record<string, string> => ({
  "schema.ts": modelFiles()["schema.ts"] ?? "",
  "operations/desk.ts": `import { resource, v } from "@grasp-os/sdk";
import { action } from "#grasp/server";

${withWriter ? `export const writer = resource.model("writer", { maxOutputTokens: 300 });` : ""}

export const help = resource.knowledge("help", {
  operations: ["search"],
  collections: ["handbook", "salaries"],
});

export const letter = resource.template("letter", { contract: ${JSON.stringify(contract)} });

${
  withWriter
    ? `export const draft = action({
  args: { prompt: v.string().min(1) },
  returns: v.string(),
  uses: [writer],
  handler: async (ctx, args) => await ctx.resources.writer.generate({ prompt: args.prompt }),
});`
    : ""
}

export const find = action({
  args: { text: v.string().min(1) },
  returns: v.array(v.object({ title: v.string(), excerpt: v.string() })).max(20),
  uses: [help],
  handler: async (ctx, args) => await ctx.resources.help.search({ text: args.text }),
});

export const read = action({
  args: {},
  returns: v.number(),
  uses: [letter],
  handler: async (ctx) => {
    const template = await ctx.resources.letter.read();
    return template.version;
  },
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { ${withWriter ? "draft, writer, " : ""}find, help, letter, read } from "./operations/desk.ts";
import schema from "./schema.ts";

export default app({
  name: "Desk",
  schema,
  access: { tables: { notes: { read: "owner", write: "owner" } } },
  operations: { desk: { ${withWriter ? "draft, " : ""}find, read } },
  internalOperations: {},
  screens: [],
  uses: [${withWriter ? "writer, " : ""}help, letter],
});
`,
});

/** An App whose actions search knowledge `aliases`, each of `names`. */
const manyCollectionFiles = (
  aliases: readonly string[],
  names: readonly string[]
): Record<string, string> => ({
  "schema.ts": modelFiles()["schema.ts"] ?? "",
  "operations/shelves.ts": `import { resource, v } from "@grasp-os/sdk";
import { action } from "#grasp/server";

${aliases
  .map(
    (alias) => `export const ${alias} = resource.knowledge("${alias}", {
  operations: ["search"],
  collections: ${JSON.stringify(names)},
});

export const find_${alias} = action({
  args: { text: v.string().min(1) },
  returns: v.array(v.object({ title: v.string(), excerpt: v.string() })).max(20),
  uses: [${alias}],
  handler: async (ctx, args) => await ctx.resources.${alias}.search({ text: args.text }),
});
`
  )
  .join("\n")}`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { ${aliases.flatMap((alias) => [alias, `find_${alias}`]).join(", ")} } from "./operations/shelves.ts";
import schema from "./schema.ts";

export default app({
  name: "Shelves",
  schema,
  access: { tables: { notes: { read: "owner", write: "owner" } } },
  operations: { shelves: { ${aliases.map((alias) => `find_${alias}`).join(", ")} } },
  internalOperations: {},
  screens: [],
  uses: [${aliases.join(", ")}],
});
`,
});

/** A template contract of the test's own: templates are the organization's. */
const ownContract = (): string =>
  `grasp.desk-${crypto.randomUUID().slice(0, 8)}@1`;

/**
 * The Desk App, sealed and current, granted to read one collection, with a
 * version of its template's contract and one of another contract published.
 */
const deskApp = async () => {
  const contract = ownContract();
  const sealed = await sealedApp(deskFiles(contract));
  const admin = await person("admin");
  const handbook = await createCollection(env, admin, {
    name: "Handbook",
    access: "everyone",
  });
  const permission = await grantedCollection(
    sealed,
    admin,
    handbook.id,
    "HANDBOOK"
  );
  const template = await publishTemplate(env, admin, {
    contract,
    content: { greeting: "Dear" },
  });
  await publishTemplate(env, admin, {
    contract: ownContract(),
    content: { greeting: "Other" },
  });
  return { contract, sealed, admin, handbook, permission, template };
};

type Desk = Awaited<ReturnType<typeof deskApp>>;

/** Binds each of the Desk's resources, as its admin, to what it is offered. */
const bindDesk = async ({ sealed, admin, permission, template }: Desk) => {
  const approve = async (alias: string, target: object) =>
    await approveResourceBinding(env, admin, {
      app: sealed.app,
      alias,
      target,
      reviewed: { version: 1 },
    });
  await approve("writer", { kind: "model", model: allowedModel });
  await approve("help", {
    kind: "knowledge",
    collections: { handbook: permission, salaries: permission },
  });
  await approve("letter", {
    kind: "template",
    templateId: template.templateId,
    version: template.version,
  });
};

/**
 * A copy of the App's permission `id` that holds in one chat only, as a
 * chat's agent asks for one: it never serves a binding.
 */
const chatScopedCopy = async (id: string): Promise<void> => {
  const db = drizzle(env.DB);
  const row = await db
    .select()
    .from(permissionRows)
    .where(eq(permissionRows.id, id))
    .get();
  if (row === undefined) {
    throw new Error(`No permission ${id}`);
  }
  await db
    .insert(permissionRows)
    .values({ ...row, id: crypto.randomUUID(), chatId: crypto.randomUUID() });
};

/** Each declared resource's state, by alias, as a review answers it. */
const statesOf = (review: ResourceBindingsReview): Record<string, string> =>
  Object.fromEntries(
    review.resources.map(({ alias, state }) => [alias, state])
  );

describe("an App's resource review", { timeout: 120_000 }, () => {
  it("lists what the current version declares, and offers an admin only what may serve it", async () => {
    const { sealed, admin, contract, handbook, permission, template } =
      await deskApp();
    // Neither another App's grant nor one held in a chat only is offered.
    await deskApp();
    await chatScopedCopy(permission);
    const review = await reviewResourceBindings(env, admin, sealed.app);
    expect(review).toStrictEqual({
      app: sealed.app,
      version: 1,
      undeclared: [],
      truncated: false,
      resources: [
        {
          alias: "help",
          kind: "knowledge",
          contract: null,
          actions: [],
          operations: ["search"],
          collections: ["handbook", "salaries"],
          maxOutputTokens: null,
          structuredOutput: false,
          usedBy: ["desk.find"],
          state: "unbound",
          binding: null,
          // The App's own grant to read, and no other collection.
          choices: {
            kind: "knowledge",
            permissions: [
              {
                permissionId: permission,
                collectionId: handbook.id,
                name: "Handbook",
              },
            ],
            truncated: false,
          },
        },
        {
          alias: "letter",
          kind: "template",
          contract,
          actions: [],
          operations: [],
          collections: [],
          maxOutputTokens: null,
          structuredOutput: false,
          usedBy: ["desk.read"],
          state: "unbound",
          binding: null,
          // Versions of the declared contract only.
          choices: {
            kind: "template",
            versions: [template],
            truncated: false,
          },
        },
        {
          alias: "writer",
          kind: "model",
          contract: null,
          actions: [],
          operations: [],
          collections: [],
          maxOutputTokens: 300,
          structuredOutput: false,
          usedBy: ["desk.draft"],
          state: "unbound",
          binding: null,
          choices: {
            kind: "model",
            models: [allowedModel],
            truncated: false,
          },
        },
      ],
    });
  });

  it("offers an admin only the models that can give a model resource's longest request", async () => {
    // Llama 3.3 answers at most 6,000 tokens; GPT-5.4 68,000. The text
    // writer asks for all 6,001 at once, the structured tagger for half.
    const sealed = await sealedApp(modelFiles(6001, 12_000));
    const { gatewayEnv: withGateway } = gatewayEnv(
      [],
      [allowedModel, "openai/gpt-5.4"]
    );
    const review = await reviewResourceBindings(
      withGateway,
      await person("admin"),
      sealed.app
    );
    expect(
      Object.fromEntries(
        review.resources.map(({ alias, choices }) => [alias, choices])
      )
    ).toMatchObject({
      writer: { kind: "model", models: ["openai/gpt-5.4"] },
      tagger: { kind: "model", models: [allowedModel, "openai/gpt-5.4"] },
    });
  });

  it("says a resource is served exactly when its next request is", async () => {
    const desk = await deskApp();
    const unbound = await call(env, desk.sealed, "desk.read", {});
    await bindDesk(desk);
    const review = await reviewResourceBindings(
      env,
      desk.admin,
      desk.sealed.app
    );
    const bound = await call(env, desk.sealed, "desk.read", {});
    const letter = review.resources.find(({ alias }) => alias === "letter");
    // Revoked: unbound again, and the next request is refused.
    await revokeResourceBinding(env, desk.admin, letter?.binding?.id);
    const revoked = await reviewResourceBindings(
      env,
      desk.admin,
      desk.sealed.app
    );
    const afterRevoke = await call(env, desk.sealed, "desk.read", {});
    expect({
      unbound: outcomeOf(unbound),
      states: statesOf(review),
      bound: outcomeOf(bound),
      revoked: statesOf(revoked),
      afterRevoke: outcomeOf(afterRevoke),
      letter: letter?.binding?.target,
    }).toStrictEqual({
      unbound: { failed: "resource.unavailable" },
      states: { help: "served", letter: "served", writer: "served" },
      bound: 1,
      revoked: { help: "served", letter: "unbound", writer: "served" },
      afterRevoke: { failed: "resource.unavailable" },
      letter: {
        kind: "template",
        templateId: desk.template.templateId,
        version: 1,
      },
    });
  });

  it("says why a binding no longer serves: a lost grant, or a changed declaration", async () => {
    const desk = await deskApp();
    const { sealed, admin, permission } = desk;
    await bindDesk(desk);
    // The collection grant is revoked, and the deployment stops allowing
    // the model: both targets are lost.
    await revokePermission(env, admin, permission);
    const { gatewayEnv: narrowed } = gatewayEnv([], []);
    const lost = await reviewResourceBindings(narrowed, admin, sealed.app);
    const found = await call(env, sealed, "desk.find", { text: "leave" });
    // A version that declares a template of another contract, and no
    // model at all.
    const next = await nextVersion(sealed, deskFiles(ownContract(), false), 2);
    const changed = await reviewResourceBindings(env, admin, sealed.app);
    const read = await call(env, next, "desk.read", {});
    expect({
      lost: statesOf(lost),
      found: outcomeOf(found),
      changed: statesOf(changed),
      undeclared: changed.undeclared.map(({ alias }) => alias),
      read: outcomeOf(read),
    }).toStrictEqual({
      lost: { help: "grant_lost", letter: "served", writer: "grant_lost" },
      found: { failed: "resource.unavailable" },
      changed: { help: "grant_lost", letter: "declaration_changed" },
      undeclared: ["writer"],
      read: { failed: "resource.unavailable" },
    });
  });

  it("shows a model binding's budget, and a damaged one as serving nothing", async () => {
    const { sealed, admin } = await deskApp();
    const capped = await approveResourceBinding(env, admin, {
      app: sealed.app,
      alias: "writer",
      target: { kind: "model", model: allowedModel },
      reviewed: { version: 1 },
      budget: { perDay: 1 },
    });
    const writerIn = async () => {
      const review = await reviewResourceBindings(env, admin, sealed.app);
      const writer = review.resources.find(({ alias }) => alias === "writer");
      return {
        state: writer?.state,
        perDay: writer?.binding?.budget?.perDay ?? null,
        damaged: writer?.binding?.budgetDamaged,
      };
    };
    const intact = await writerIn();
    await drizzle(env.DB)
      .update(appResourceBindings)
      .set({ budget: JSON.stringify({ perDay: "lots" }) })
      .where(eq(appResourceBindings.id, capped.id));
    const { gateway, gatewayEnv: withGateway } = gatewayEnv([
      answer("Uncapped."),
    ]);
    const drafted = await call(withGateway, sealed, "desk.draft", {
      prompt: "Hi",
    });
    expect({
      intact,
      damaged: await writerIn(),
      drafted: outcomeOf(drafted),
      sent: gateway.requests.length,
    }).toStrictEqual({
      intact: { state: "served", perDay: 1, damaged: false },
      damaged: { state: "budget_damaged", perDay: null, damaged: true },
      drafted: { failed: "resource.unavailable" },
      sent: 0,
    });
  });

  it("names bound collections past D1's 100 bound parameters", async () => {
    // Four knowledge resources of 26 collections each, every one bound to
    // a collection of its own: 104 permissions and collections to name.
    const aliases = ["k1", "k2", "k3", "k4"];
    const names = Array.from({ length: 26 }, (_, index) => `c${index}`);
    const sealed = await sealedApp(manyCollectionFiles(aliases, names));
    const admin = await person("admin");
    const first = await createCollection(env, admin, {
      name: "Shelf 0",
      access: "everyone",
    });
    const granted = await grantedCollection(sealed, admin, first.id, "SHELF");
    const db = drizzle(env.DB);
    const row = await db
      .select()
      .from(permissionRows)
      .where(eq(permissionRows.id, granted))
      .get();
    if (row === undefined) {
      throw new Error("Expected the grant");
    }
    const bound: Record<string, Record<string, string>> = {};
    for (const [aliasIndex, alias] of aliases.entries()) {
      const collectionsOf: Record<string, string> = {};
      for (const [nameIndex, name] of names.entries()) {
        const number = aliasIndex * names.length + nameIndex;
        // oxlint-disable-next-line no-await-in-loop -- one shelf at a time
        const shelf = await createCollection(env, admin, {
          name: `Shelf ${number}`,
          access: "everyone",
        });
        const id = crypto.randomUUID();
        // oxlint-disable-next-line no-await-in-loop -- one grant at a time
        await db.insert(permissionRows).values({
          ...row,
          id,
          objectId: shelf.id,
          binding: `SHELF_${number}`,
        });
        collectionsOf[name] = id;
      }
      bound[alias] = collectionsOf;
      // oxlint-disable-next-line no-await-in-loop -- one alias at a time
      await approveResourceBinding(env, admin, {
        app: sealed.app,
        alias,
        target: { kind: "knowledge", collections: collectionsOf },
        reviewed: { version: 1 },
      });
    }
    const review = await reviewResourceBindings(env, sealed.owner, sealed.app);
    const labelled = review.resources.flatMap(({ binding }) =>
      Object.values(binding?.label.collections ?? {})
    );
    expect({
      states: statesOf(review),
      labelled: labelled.length,
      unnamed: labelled.filter((name) => name === null).length,
      first: review.resources[0]?.binding?.label.collections.c0,
    }).toStrictEqual({
      states: { k1: "served", k2: "served", k3: "served", k4: "served" },
      labelled: 104,
      unnamed: 0,
      first: "Shelf 0",
    });
  });

  it("shows the App's builders its bindings with nothing to choose, and nobody else", async () => {
    const desk = await deskApp();
    await bindDesk(desk);
    const builders = await reviewResourceBindings(
      env,
      desk.sealed.owner,
      desk.sealed.app
    );
    // Grasp staff build as admins do, but never decide a binding.
    const staff = await reviewResourceBindings(
      env,
      { ...(await person("admin")), staff: true },
      desk.sealed.app
    );
    const member = await person("user");
    // A builder, of an App of their own, but not of this one.
    const { owner: otherBuilder } = await appWith(deskFiles(ownContract()));
    expect({
      states: statesOf(builders),
      choices: builders.resources.map(({ choices }) => choices),
      // The bound target named, for builders too: only the collection bound.
      labels: builders.resources.map(({ binding }) => binding?.label),
      staff: staff.resources.map(({ choices }) => choices),
      member: await failure(
        async () => await reviewResourceBindings(env, member, desk.sealed.app)
      ),
      otherBuilder: await failure(
        async () =>
          await reviewResourceBindings(env, otherBuilder, desk.sealed.app)
      ),
    }).toStrictEqual({
      states: { help: "served", letter: "served", writer: "served" },
      choices: [null, null, null],
      labels: [
        {
          connection: null,
          collections: { handbook: "Handbook", salaries: "Handbook" },
        },
        { connection: null, collections: {} },
        { connection: null, collections: {} },
      ],
      staff: [null, null, null],
      member: "app.not_found",
      otherBuilder: "app.not_found",
    });
  });
});
