import type { AuditEvent } from "@grasp-os/shared/audit";
import type { Json } from "@grasp-os/shared/json";
import { knowledgeSearchMaxLength } from "@grasp-os/shared/operation-limits";
import type { OperationResult } from "@grasp-os/shared/operations";
import { permissionErrors } from "@grasp-os/shared/permissions";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { callAppFunction } from "../src/app-functions.ts";
import type { FunctionAnswer } from "../src/app-functions.ts";
import type { Release } from "../src/app-releases.ts";
import { appFor, commitFiles, setCurrentVersion } from "../src/apps.ts";
import { appMembers, appResourceBindings } from "../src/db/core/schema.ts";
import { createCollection } from "../src/knowledge/collections.ts";
import { saveDocument } from "../src/knowledge/documents.ts";
import {
  grantPermission,
  requestPermission,
  revokePermission,
} from "../src/permissions.ts";
import { revokeRelease } from "../src/release-retention.ts";
import {
  approveResourceBinding,
  listResourceBindings,
  revokeResourceBinding,
} from "../src/resource-bindings.ts";
import { isRestricted } from "../src/restricted.ts";
import { fakeGateway } from "./ai-gateway.ts";
import type { GatewayReply } from "./ai-gateway.ts";
import { allEvents } from "./audit-events.ts";
import { appWith, failure, person, seal } from "./sealed-apps.ts";
import type { Fixture } from "./sealed-apps.ts";

// An App's declared resources reach real providers only through bindings
// an admin approved, and the live grant each names, through core's
// operation host (spec 12, 32.3). Each request resolves its binding again,
// so revoking it, changing the declaration or losing the target stops the
// next one; the model gateway is the real one, with only AI Gateway behind
// the AI binding faked.

/** The model the tests' deployment allows. */
const allowedModel = "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** An App whose actions use a text model and a structured one. */
const modelFiles = (maxOutputTokens = 300): Record<string, string> => ({
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
  maxOutputTokens: 200,
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
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { draft, label, labeler, probe, tag, tagger, twice, writer } from "./operations/assist.ts";
import schema from "./schema.ts";

export default app({
  name: "Assistant",
  schema,
  access: { tables: { notes: { read: "owner", write: "owner" } } },
  operations: { assist: { draft, tag, twice, probe, label } },
  internalOperations: {},
  screens: [],
  uses: [writer, tagger, labeler],
});
`,
});

type Sealed = Fixture & { release: Release };

/** An App with `files`, sealed and current. */
const sealedApp = async (files: Record<string, string>): Promise<Sealed> => {
  const fixture = await appWith(files);
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
    async (app, role) => await appFor(env, sealed.owner, app, role)
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
    const sealed = await sealedApp(modelFiles(100_000));
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
});
