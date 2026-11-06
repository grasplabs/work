import type { AuditEvent } from "@grasp-os/shared/audit";
import type { Json } from "@grasp-os/shared/json";
import { knowledgeSearchMaxLength } from "@grasp-os/shared/operation-limits";
import type { OperationResult } from "@grasp-os/shared/operations";
import { permissionErrors } from "@grasp-os/shared/permissions";
import type { ResourceBindingsReview } from "@grasp-os/shared/resource-bindings";
import { valueDepth } from "@grasp-os/shared/value-depth";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vite-plus/test";
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
import { createCollection } from "../src/knowledge/collection-rules.ts";
import { saveDocument } from "../src/knowledge/person-writes.ts";
import {
  grantPermission,
  requestPermission,
  revokePermission,
} from "../src/permissions.ts";
import { revokeRelease } from "../src/release-retention.ts";
import {
  approveResourceBinding,
  listResourceBindings,
  reviewResourceBindings,
  revokeResourceBinding,
} from "../src/resource-bindings.ts";
import { publishTemplate } from "../src/resource-templates.ts";
import { isRestricted } from "../src/restricted.ts";
import { appDefinition } from "./app-definitions.ts";
import type { AppSpec } from "./app-definitions.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { fakeProviderFor } from "./model-provider.ts";
import type { FakeProvider, ProviderReply } from "./model-provider.ts";
import { appWith, failure, person, seal } from "./sealed-apps.ts";
import type { Fixture } from "./sealed-apps.ts";
import { openRpc, signedInWithRole } from "./sign-in.ts";

// An App's declared resources reach real providers only through bindings
// an admin approved, and the live grant each names, through core's
// operation host (spec 12, 32.3). Each request resolves its binding again,
// so revoking it, changing the declaration or losing the target stops the
// next one; the model gateway is the real one, with only the model
// provider behind connect faked.

/** The model the organization chose, which answers at most 65,536 tokens. */
const chosenModel = "mistral/mistral-large-latest";

/**
 * An App whose actions ask its `ai` for text and for values, each within
 * `maxOutputTokens`.
 */
/** The notes each of these Apps keeps, each its owner's. */
const notesTable = {
  notes: {
    fields: { title: "v.string()" },
    access: { read: "owner", write: "owner" },
  },
} satisfies AppSpec["tables"];

const modelFiles = (maxOutputTokens = 300): Record<string, string> => ({
  ...appDefinition({
    name: "Assistant",
    tables: notesTable,
    permissions: [`permission.ai({ maxOutputTokens: ${maxOutputTokens} })`],
  }),
  "server/assist.ts": `import { v } from "@grasp-os/sdk";
import { action } from "@server/_generated/server";
import { permissions } from "../grasp.config.ts";

export const ai = permissions.ai;

export const label = action({
  args: { text: v.string().min(1) },
  returns: v.object({ label: v.string(), status: v.string() }),
  uses: [ai],
  handler: async (ctx, args) =>
    await ctx.ai.generate({
      prompt: args.text,
      output: v.object({ label: v.string(), status: v.string().default("draft") }),
    }),
});

export const draft = action({
  args: { prompt: v.string().min(1) },
  returns: v.string(),
  uses: [ai],
  handler: async (ctx, args) =>
    await ctx.ai.generate({ prompt: args.prompt, instructions: "Be brief." }),
});

export const tag = action({
  args: { text: v.string().min(1) },
  returns: v.object({ tags: v.array(v.string()) }),
  uses: [ai],
  handler: async (ctx, args) =>
    await ctx.ai.generate({
      prompt: args.text,
      output: v.object({ tags: v.array(v.string().trim().min(1)).max(5) }),
    }),
});

/** Everything App code can see of its model client, and what it answered. */
export const probe = action({
  args: {},
  returns: v.string(),
  uses: [ai],
  handler: async (ctx) => {
    const client = ctx.ai;
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
  uses: [ai],
  handler: async (ctx) => {
    const first = await ctx.ai.generate({ prompt: "one" });
    try {
      await ctx.ai.generate({ prompt: "two" });
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
  uses: [ai],
  handler: async (ctx) => {
    try {
      return await ctx.ai.generate({ prompt: "Hi" });
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

/** The request a page sends to call `path` of `release`. */
const requestFor = (release: Release, path: string, input: unknown): string => {
  const operation = release.app.operations[path];
  if (operation === undefined) {
    throw new Error(`No ${path}`);
  }
  return JSON.stringify({
    reference: { name: path, kind: operation.kind },
    input,
  });
};

/**
 * Core's env, the organization having chosen `models`, whose provider
 * answers `replies` in turn.
 */
const providerEnv = async (
  replies: ProviderReply[],
  models: string[] = [chosenModel]
) => {
  const provider = await fakeProviderFor(models, ...replies);
  return { provider, providerEnv: env };
};

/**
 * The organization chooses the model the tests bind, as an admin binds
 * only a model it chose, with a provider that answers nothing: a test
 * whose calls reach it connects its own (`providerEnv`).
 */
const chooseModel = async (): Promise<void> => {
  await fakeProviderFor([chosenModel]);
};

const answer = (text: string): ProviderReply => ({
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

/** An admin's approval of the App's `ai` to the chosen model. */
const approveModel = async (
  sealed: Sealed,
  version = sealed.release.manifest.resourceVersion
) =>
  await approveResourceBinding(env, await person("admin"), {
    app: sealed.app,
    alias: "ai",
    target: { kind: "model", model: chosenModel },
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

/** The provider's request `index`, as JSON text. */
const sentText = (provider: FakeProvider, index: number): string =>
  JSON.stringify(provider.requests[index]?.body ?? null);

/** An approval of the App's `ai` to the chosen model, as a client sends it. */
const writerApproval = (sealed: Sealed) => ({
  app: sealed.app,
  alias: "ai",
  target: { kind: "model", model: chosenModel },
  reviewed: { version: 1 },
});

/** An App whose actions search and read two of the Brain's collections. */
const knowledgeFiles = (): Record<string, string> => ({
  ...appDefinition({
    name: "Help",
    tables: notesTable,
    permissions: [
      'permission.brain({ operations: ["search", "read"], collections: ["handbook", "salaries"] })',
      "permission.ai({ maxOutputTokens: 300 })",
    ],
  }),
  "server/help.ts": `import { v } from "@grasp-os/sdk";
import { action } from "@server/_generated/server";
import { permissions } from "../grasp.config.ts";

export const brain = permissions.brain;

export const find = action({
  args: { text: v.string().min(1) },
  returns: v.array(v.object({ title: v.string(), excerpt: v.string() })).max(20),
  uses: [brain],
  handler: async (ctx, args) => await ctx.brain.search({ text: args.text, limit: 5 }),
});

export const open = action({
  args: { id: v.string().min(1) },
  returns: v.object({ title: v.string(), text: v.string() }),
  uses: [brain],
  handler: async (ctx, args) => await ctx.brain.read({ id: args.id }),
});

export const ai = permissions.ai;

/** Reads a document, then has the model summarize it. */
export const summarize = action({
  args: { id: v.string().min(1) },
  returns: v.string(),
  uses: [brain, ai],
  handler: async (ctx, args) => {
    const document = await ctx.brain.read({ id: args.id });
    return await ctx.ai.generate({ prompt: document.text });
  },
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
    alias: "brain",
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

describe("resource bindings", { timeout: 120_000 }, () => {
  beforeEach(chooseModel);

  it("refuse a model an action declares until an admin binds it", async () => {
    const sealed = await sealedApp(modelFiles());
    const { provider, providerEnv: withProvider } = await providerEnv([
      answer("A short draft."),
    ]);
    const unbound = await call(withProvider, sealed, "assist.draft", {
      prompt: "Hi",
    });
    const sentUnbound = provider.requests.length;
    await approveModel(sealed);
    const bound = await call(withProvider, sealed, "assist.draft", {
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
    await approveModel(sealed);
    const { provider, providerEnv: withProvider } = await providerEnv([
      answer("A short draft."),
    ]);
    await call(withProvider, sealed, "assist.draft", { prompt: "Hi" });
    const [sent] = provider.requests;
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
      detail: { purpose: "app.resource" },
    });
  });

  it("bind a model only when it can give each request's share of the declared bound", async () => {
    // Mistral Large answers at most a quarter of its 262,144-token window,
    // 65,536 tokens. A request for text asks for the whole bound at once;
    // one for a value for half of it each time, as it may ask again.
    const tooLong = await sealedApp(modelFiles(65_537));
    const admin = await person("admin");
    const refused = await failure(
      async () =>
        await approveResourceBinding(env, admin, writerApproval(tooLong))
    );
    const sealed = await sealedApp(modelFiles(65_536));
    await approveModel(sealed);
    const { provider, providerEnv: withProvider } = await providerEnv([
      answer('{"tags": ["launch"]}'),
    ]);
    const tagged = await call(withProvider, sealed, "assist.tag", {
      text: "Notes",
    });
    const bindings = await listResourceBindings(env, admin, tooLong.app);
    expect({
      refused,
      bound: bindings.length,
      tagged: outcomeOf(tagged),
      sent: provider.requests.map(({ body }) => body),
    }).toStrictEqual({
      refused: "resource.model_too_small",
      bound: 0,
      tagged: { tags: ["launch"] },
      sent: [expect.objectContaining({ max_completion_tokens: 32_768 })],
    });
  });

  it("send an App's request the whole bound a model can answer", async () => {
    const sealed = await sealedApp(modelFiles(65_536));
    await approveModel(sealed);
    const { provider, providerEnv: withProvider } = await providerEnv([
      answer("A long draft."),
    ]);
    const drafted = await call(withProvider, sealed, "assist.draft", {
      prompt: "Hi",
    });
    expect({
      drafted: outcomeOf(drafted),
      sent: provider.requests.map(({ body }) => body),
    }).toStrictEqual({
      drafted: "A long draft.",
      sent: [expect.objectContaining({ max_completion_tokens: 65_536 })],
    });
  });

  it("enforce the value a request asks for, asking again once", async () => {
    const sealed = await sealedApp(modelFiles());
    await approveModel(sealed);
    const { provider, providerEnv: withProvider } = await providerEnv([
      answer('{"tags": ["  padded  "]}'),
      answer('{"tags": ["launch", "plans"]}'),
      answer("not json"),
      answer('{"tags": [""]}'),
    ]);
    const fitted = await call(withProvider, sealed, "assist.tag", {
      text: "Notes",
    });
    const neverFitted = await call(withProvider, sealed, "assist.tag", {
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
    // The declared 300 tokens bound the App's request as a whole: each of
    // its two attempts may take half.
    const ceilings = provider.requests
      .slice(0, 2)
      .map(
        ({ body }) =>
          z.object({ max_completion_tokens: z.number() }).parse(body)
            .max_completion_tokens
      );
    expect(ceilings).toStrictEqual([150, 150]);
    // The model was told the descriptor's JSON Schema, and why its first
    // answer didn't fit: not in its exact form.
    expect([sentText(provider, 0), sentText(provider, 1)]).toStrictEqual([
      expect.stringContaining(String.raw`\"maxItems\":5`),
      expect.stringContaining("exact form"),
    ]);
  });

  it("stop a binding revoked between two requests of one call", async () => {
    const sealed = await sealedApp(modelFiles());
    const binding = await approveModel(sealed);
    const gate = Promise.withResolvers<unknown>();
    const { provider, providerEnv: withProvider } = await providerEnv([
      { ...answer("first"), pause: { at: 2, until: gate.promise } },
      answer("never sent"),
    ]);
    const running = call(withProvider, sealed, "assist.twice", {});
    while (provider.requests.length === 0) {
      // oxlint-disable-next-line no-await-in-loop -- until the first request is out
      await scheduler.wait(10);
    }
    await revokeResourceBinding(env, await person("admin"), binding.id);
    gate.resolve(null);
    const result = await running;
    expect({
      outcome: outcomeOf(result),
      sent: provider.requests.length,
    }).toStrictEqual({ outcome: "first|resource.unavailable", sent: 1 });
  });

  it("serve only the declaration an admin approved", async () => {
    const sealed = await sealedApp(modelFiles());
    await approveModel(sealed);
    // The next version asks for longer answers: the binding no longer
    // matches what was reviewed.
    const widened = await nextVersion(sealed, modelFiles(5000), 2);
    const { provider, providerEnv: withProvider } = await providerEnv([
      answer("Longer."),
    ]);
    const before = await call(withProvider, widened, "assist.draft", {
      prompt: "Hi",
    });
    const sentBefore = provider.requests.length;
    await approveModel(widened, 2);
    const after = await call(withProvider, widened, "assist.draft", {
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

  it("stop a model the organization no longer chooses", async () => {
    const sealed = await sealedApp(modelFiles());
    await approveModel(sealed);
    const { provider, providerEnv: withProvider } = await providerEnv(
      [answer("Hidden.")],
      ["openai/gpt-5.4"]
    );
    const result = await call(withProvider, sealed, "assist.draft", {
      prompt: "Hi",
    });
    expect({
      outcome: outcomeOf(result),
      sent: provider.requests.length,
    }).toStrictEqual({ outcome: { failed: "resource.unavailable" }, sent: 0 });
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
        target: { kind: "guests", permissionId: crypto.randomUUID() },
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

  it("leave out a binding whose target no longer parses, as one to another App an older version wrote", async () => {
    const sealed = await sealedApp(modelFiles());
    const admin = await person("admin");
    const binding = await approveResourceBinding(
      env,
      admin,
      writerApproval(sealed)
    );
    // Written by the version before, while this one deployed: past the
    // migration that removed the rest.
    const stale = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO app_resource_bindings (id, app_id, alias, kind, target,
        declaration_hash, contract_id, fingerprint, reviewed_version, status,
        approved_by, approved_at)
       VALUES (?, ?, 'crm', 'app', ?, 'hash', 'app:crm', 'fingerprint', 1, 'active', ?, 0)`
    )
      .bind(
        stale,
        sealed.app,
        JSON.stringify({ kind: "app", appId: "crm" }),
        admin.userId
      )
      .run();
    const listed = await listResourceBindings(env, admin, sealed.app);
    const review = await reviewResourceBindings(env, admin, sealed.app);
    expect({
      listed: listed.map(({ id }) => id),
      undeclared: review.undeclared.map(({ id }) => id),
      revoked: await failure(
        async () => await revokeResourceBinding(env, admin, stale)
      ),
    }).toStrictEqual({
      listed: [binding.id],
      undeclared: [],
      revoked: "resource.binding_not_found",
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
    await approveModel(sealed);
    const { provider, providerEnv: withProvider } = await providerEnv([
      answer("Plain text."),
    ]);
    const result = await call(withProvider, sealed, "assist.probe", {});
    const seen =
      result.ok && typeof result.value === "string" ? result.value : "";
    // Every secret core holds, and the provider's key its requests carry.
    const secrets = [
      env.CAPABILITY_SIGNING_KEY,
      env.BETTER_AUTH_SECRET,
      env.ROUTER_SECRET,
      provider.key,
      "Bearer",
    ];
    expect({
      answered: seen.startsWith("Plain text."),
      leaked: secrets.filter((secret) => seen.includes(secret)),
    }).toStrictEqual({ answered: true, leaked: [] });
  });

  it("serve one App's binding to that App only", async () => {
    const sealed = await sealedApp(modelFiles());
    const other = await sealedApp(modelFiles());
    await approveModel(sealed);
    const { provider, providerEnv: withProvider } = await providerEnv([
      answer("Mine."),
    ]);
    // The same declaration, in another App with no binding of its own.
    const result = await call(withProvider, other, "assist.draft", {
      prompt: "Hi",
    });
    expect({
      outcome: outcomeOf(result),
      sent: provider.requests.length,
    }).toStrictEqual({ outcome: { failed: "resource.unavailable" }, sent: 0 });
  });

  it("keep one active binding when two approvals of an alias race", async () => {
    const sealed = await sealedApp(modelFiles());
    const [one, two] = await Promise.allSettled([
      approveModel(sealed),
      approveModel(sealed),
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
    await approveModel(sealed);
    const { provider, providerEnv: withProvider } = await providerEnv([
      answer('{"label": "Launch", "status": "draft"}'),
    ]);
    const result = await call(withProvider, sealed, "assist.label", {
      text: "Notes",
    });
    expect({
      outcome: outcomeOf(result),
      sent: provider.requests.length,
      told: sentText(provider, 0).includes(
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
    await approveModel(sealed);
    const gate = Promise.withResolvers<unknown>();
    const { provider, providerEnv: withProvider } = await providerEnv([
      { ...answer("first"), pause: { at: 2, until: gate.promise } },
      answer("never sent"),
    ]);
    const running = call(withProvider, sealed, "assist.twice", {});
    while (provider.requests.length === 0) {
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
      sent: provider.requests.length,
    }).toStrictEqual({ outcome: "first|version.revoked", sent: 1 });
  });

  it("stop a page caller whose App role is removed between two requests", async () => {
    const sealed = await sealedApp(modelFiles());
    await approveModel(sealed);
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
    const { provider, providerEnv: withProvider } = await providerEnv([
      { ...answer("first"), pause: { at: 2, until: gate.promise } },
      answer("never sent"),
    ]);
    const running = callAppFunction(
      withProvider,
      user,
      sealed.app,
      requestFor(sealed.release, "assist.twice", {})
    );
    while (provider.requests.length === 0) {
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
      sent: provider.requests.length,
    }).toStrictEqual({ outcome: "first|app.not_found", sent: 1 });
  });

  it("stop a call once what admitted its caller no longer holds, between two requests", async () => {
    const sealed = await sealedApp(modelFiles());
    await approveModel(sealed);
    const { provider, providerEnv: withProvider } = await providerEnv([
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
      withProvider,
      sealed.owner,
      sealed.app,
      requestFor(sealed.release, "assist.twice", {}),
      Date.now() + 60_000,
      stillAllowed
    );
    expect({
      outcome: outcomeOf(answered.result),
      sent: provider.requests.length,
    }).toStrictEqual({ outcome: "first|permission.denied", sent: 1 });
  });

  it("answer two racing revocations with the binding as it is", async () => {
    const sealed = await sealedApp(modelFiles());
    const binding = await approveModel(sealed);
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
            alias: "brain",
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
});

/** An admin's approval of the App's `writer`. */
const approveWriter = async (sealed: Sealed) =>
  await approveResourceBinding(
    env,
    await person("admin"),
    writerApproval(sealed)
  );

/** Calls `path` of the App through `callEnv`. */
const callOn = async (
  callEnv: Env,
  sealed: Sealed,
  path: string
): Promise<OperationResult> =>
  await call(callEnv, sealed, path, { prompt: "Hi" });

/** Calls the App's `draft` through `callEnv`: its outcome. */
const draftOn = async (callEnv: Env, sealed: Sealed): Promise<Json> =>
  outcomeOf(await callOn(callEnv, sealed, "assist.draft"));

/** App `app`'s active binding's row, to damage what it stores. */
const active = (app: string) =>
  and(
    eq(appResourceBindings.appId, app),
    eq(appResourceBindings.status, "active")
  );

describe("model binding spend", { timeout: 120_000 }, () => {
  beforeEach(chooseModel);

  const idp = mockIdp();

  /** The model bindings the models settings list, as `role` reads them. */
  const bindings = async (role: "admin" | "builder") => {
    const { session } = await signedInWithRole(idp, role);
    const { core } = await openRpc(session, { coreEnv: env });
    return await core.authenticate().models.settings();
  };

  it("tell an App its provider's rate limit, with when to try again", async () => {
    const sealed = await sealedApp(modelFiles());
    await approveWriter(sealed);
    const { providerEnv: withProvider } = await providerEnv(
      // Refused for its rate, retries and all, the provider asking for a
      // second and a half.
      Array.from({ length: 3 }, () => ({
        status: 429,
        errorType: "rate_limit_error",
        headers: { "retry-after-ms": "1500" },
      }))
    );
    expect(
      outcomeOf(await callOn(withProvider, sealed, "assist.attempt"))
    ).toBe("resource.rate_limited|2");
  });

  it("list each App's model bindings with this month's spend, each App's apart, to admins only", async () => {
    // Named to sort first, ahead of this file's other Apps.
    const one = await sealedApp(modelFiles(), "0 A One");
    const other = await sealedApp(modelFiles(), "0 B Other");
    const idle = await sealedApp(modelFiles(), "0 C Idle");
    await approveWriter(one);
    await approveWriter(other);
    const idleBinding = await approveWriter(idle);
    const { providerEnv: withProvider } = await providerEnv([
      answer("One."),
      answer("Again."),
      answer("Other."),
    ]);
    await draftOn(withProvider, one);
    await draftOn(withProvider, one);
    await draftOn(withProvider, other);

    const ours = ({ appId }: { appId: string }): boolean =>
      appId === one.app || appId === other.app || appId === idle.app;
    const read = await bindings("admin");
    const listed = read.bindings.listed.filter(ours);
    const [oneSpent, otherSpent, idleSpent] = listed.map(
      ({ thisMonth }) => thisMonth
    );
    expect({
      listed: listed.map(({ appId, appName, alias, model }) => ({
        appId,
        appName,
        alias,
        model,
      })),
      // The same request twice costs twice one; nothing for the idle one.
      twice:
        oneSpent !== undefined && otherSpent !== undefined
          ? Math.abs(oneSpent - 2 * otherSpent) < 1e-9 && otherSpent > 0
          : false,
      idle: idleSpent,
      month: read.month,
    }).toStrictEqual({
      listed: [
        {
          appId: one.app,
          appName: "0 A One",
          alias: "ai",
          model: chosenModel,
        },
        {
          appId: other.app,
          appName: "0 B Other",
          alias: "ai",
          model: chosenModel,
        },
        {
          appId: idle.app,
          appName: "0 C Idle",
          alias: "ai",
          model: chosenModel,
        },
      ],
      twice: true,
      idle: 0,
      month: read.month,
    });

    // A revoked binding isn't listed; one whose target can't be read is,
    // as such, and never hides the others.
    await revokeResourceBinding(env, await person("admin"), idleBinding.id);
    await drizzle(env.DB)
      .update(appResourceBindings)
      .set({ target: "{not json" })
      .where(active(other.app));
    const later = await bindings("admin");
    expect(
      later.bindings.listed
        .filter(ours)
        .map(({ appId, model }) => ({ appId, model }))
    ).toStrictEqual([
      { appId: one.app, model: chosenModel },
      { appId: other.app, model: null },
    ]);

    await expect(failure(async () => await bindings("builder"))).resolves.toBe(
      "role.forbidden"
    );
  });
});

/**
 * An App whose actions use its `ai` (unless `withWriter` is false), with
 * `maxOutputTokens`, and the Brain's `collections` (unless `withBrain` is
 * false); with `sneak`, one more action that reaches for the Brain past
 * its types without listing it.
 */
const deskFiles = ({
  withWriter = true,
  withBrain = true,
  maxOutputTokens = 300,
  collections = ["handbook", "salaries"],
  sneak = false,
}: {
  withWriter?: boolean;
  withBrain?: boolean;
  maxOutputTokens?: number;
  collections?: readonly string[];
  sneak?: boolean;
} = {}): Record<string, string> => ({
  ...appDefinition({
    name: "Desk",
    tables: notesTable,
    permissions: [
      ...(withWriter
        ? [`permission.ai({ maxOutputTokens: ${maxOutputTokens} })`]
        : []),
      ...(withBrain
        ? [
            `permission.brain({ operations: ["search"], collections: ${JSON.stringify(collections)} })`,
          ]
        : []),
    ],
  }),
  "server/desk.ts": `import { v } from "@grasp-os/sdk";
import { action } from "@server/_generated/server";
${withWriter || withBrain ? 'import { permissions } from "../grasp.config.ts";' : ""}

${withWriter ? "export const ai = permissions.ai;" : ""}

${
  withBrain
    ? `export const brain = permissions.brain;

export const find = action({
  args: { text: v.string().min(1) },
  returns: v.array(v.object({ title: v.string(), excerpt: v.string() })).max(20),
  uses: [brain],
  handler: async (ctx, args) => await ctx.brain.search({ text: args.text }),
});`
    : ""
}

${
  withWriter
    ? `export const draft = action({
  args: { prompt: v.string().min(1) },
  returns: v.string(),
  uses: [ai],
  handler: async (ctx, args) => await ctx.ai.generate({ prompt: args.prompt }),
});`
    : ""
}

${
  sneak
    ? `export const sneak = action({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    const client: unknown = Reflect.get(ctx, "brain");
    return client === undefined ? "absent" : JSON.stringify(Object.keys(Object(client)));
  },
});`
    : ""
}
`,
});

/** The Desk App, sealed and current, granted to read one collection. */
const deskApp = async () => {
  const sealed = await sealedApp(deskFiles());
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
  return { sealed, admin, handbook, permission };
};

type Desk = Awaited<ReturnType<typeof deskApp>>;

/** Binds each of the Desk's permissions, as its admin, to what it is offered. */
const bindDesk = async ({ sealed, admin, permission }: Desk) => {
  const approve = async (alias: string, target: object) =>
    await approveResourceBinding(env, admin, {
      app: sealed.app,
      alias,
      target,
      reviewed: { version: 1 },
    });
  await approve("ai", { kind: "model", model: chosenModel });
  await approve("brain", {
    kind: "knowledge",
    collections: { handbook: permission, salaries: permission },
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
  beforeEach(chooseModel);

  it("lists what the current version declares, and offers an admin only what may serve it", async () => {
    const { sealed, admin, handbook, permission } = await deskApp();
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
          alias: "ai",
          kind: "model",
          contract: null,
          actions: [],
          operations: [],
          collections: [],
          maxOutputTokens: 300,
          usedBy: ["desk.draft"],
          state: "unbound",
          binding: null,
          choices: {
            kind: "model",
            models: [chosenModel],
            truncated: false,
          },
        },
        {
          alias: "brain",
          kind: "knowledge",
          contract: null,
          actions: [],
          operations: ["search"],
          collections: ["handbook", "salaries"],
          maxOutputTokens: null,
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
      ],
    });
  });

  it("offers an admin only the models that can give the longest request", async () => {
    // Mistral Large answers at most 65,536 tokens; GPT-5.4 68,000. A
    // request for text asks for all 65,537 at once.
    const sealed = await sealedApp(modelFiles(65_537));
    const { providerEnv: withProvider } = await providerEnv(
      [],
      [chosenModel, "openai/gpt-5.4"]
    );
    const review = await reviewResourceBindings(
      withProvider,
      await person("admin"),
      sealed.app
    );
    expect(
      review.resources.map(({ alias, choices }) => [alias, choices])
    ).toStrictEqual([
      ["ai", { kind: "model", models: ["openai/gpt-5.4"], truncated: false }],
    ]);
  });

  it("says a permission is served exactly when its next request is", async () => {
    const desk = await deskApp();
    const unbound = await call(env, desk.sealed, "desk.find", {
      text: "leave",
    });
    await bindDesk(desk);
    const review = await reviewResourceBindings(
      env,
      desk.admin,
      desk.sealed.app
    );
    const bound = await call(env, desk.sealed, "desk.find", { text: "leave" });
    const brain = review.resources.find(({ alias }) => alias === "brain");
    // Revoked: unbound again, and the next request is refused.
    await revokeResourceBinding(env, desk.admin, brain?.binding?.id);
    const revoked = await reviewResourceBindings(
      env,
      desk.admin,
      desk.sealed.app
    );
    const afterRevoke = await call(env, desk.sealed, "desk.find", {
      text: "leave",
    });
    expect({
      unbound: outcomeOf(unbound),
      states: statesOf(review),
      bound: outcomeOf(bound),
      revoked: statesOf(revoked),
      afterRevoke: outcomeOf(afterRevoke),
    }).toStrictEqual({
      unbound: { failed: "resource.unavailable" },
      states: { ai: "served", brain: "served" },
      bound: [],
      revoked: { ai: "served", brain: "unbound" },
      afterRevoke: { failed: "resource.unavailable" },
    });
  });

  it("says why a binding no longer serves: a lost grant, or a changed declaration", async () => {
    const desk = await deskApp();
    const { sealed, admin, permission } = desk;
    await bindDesk(desk);
    // The collection grant is revoked, and the organization chooses
    // another model: both targets are lost.
    await revokePermission(env, admin, permission);
    const { providerEnv: narrowed } = await providerEnv([], ["openai/gpt-5.4"]);
    const lost = await reviewResourceBindings(narrowed, admin, sealed.app);
    const found = await call(env, sealed, "desk.find", { text: "leave" });
    // A version that reads one collection less, and no AI at all.
    const next = await nextVersion(
      sealed,
      deskFiles({ withWriter: false, collections: ["handbook"] }),
      2
    );
    const changed = await reviewResourceBindings(env, admin, sealed.app);
    const read = await call(env, next, "desk.find", { text: "leave" });
    expect({
      lost: statesOf(lost),
      found: outcomeOf(found),
      changed: statesOf(changed),
      undeclared: changed.undeclared.map(({ alias }) => alias),
      read: outcomeOf(read),
    }).toStrictEqual({
      lost: { ai: "grant_lost", brain: "grant_lost" },
      found: { failed: "resource.unavailable" },
      changed: { brain: "declaration_changed" },
      undeclared: ["ai"],
      read: { failed: "resource.unavailable" },
    });
  });

  it("lists every binding a version can reach, and refuses a request through any it doesn't list as served", async () => {
    // The attack: a binding an admin approved for one version reaches a
    // later one the review shows otherwise. Version 2 widens `ai`; version
    // 3 declares it as approved again and drops `brain`, whose binding
    // stays active, keeping code that reaches for it.
    const desk = await deskApp();
    const { sealed, admin } = desk;
    await bindDesk(desk);
    const next = await nextVersion(
      sealed,
      deskFiles({ withWriter: true, maxOutputTokens: 400, sneak: true }),
      2
    );
    const { provider, providerEnv: withProvider } = await providerEnv([
      answer("Never sent."),
    ]);
    // Its `ai` widened past what was approved: a request reaches nothing.
    const widened = await call(withProvider, next, "desk.draft", {
      prompt: "Hi",
    });
    const dropped = await nextVersion(
      next,
      deskFiles({ withBrain: false, sneak: true }),
      3
    );
    const review = await reviewResourceBindings(env, admin, sealed.app);
    const brainBinding = review.undeclared.find(
      ({ alias }) => alias === "brain"
    );
    expect({
      // Version 3: its own declarations, each with how it is bound, and
      // every other active binding listed as serving nothing.
      declared: review.resources.map(({ alias, state }) => [alias, state]),
      undeclared: review.undeclared.map(({ alias }) => alias),
      brainStillActive: brainBinding?.status,
      widened: outcomeOf(widened),
      sent: provider.requests.length,
      // Code that reaches for a permission its version doesn't list has
      // nothing to reach it with, though the binding is still active.
      sneak: outcomeOf(await call(env, dropped, "desk.sneak", {})),
      // Nor does a call through the last version's reference to the
      // function that read through it reach the binding.
      find: outcomeOf(await call(env, next, "desk.find", { text: "leave" })),
    }).toStrictEqual({
      declared: [["ai", "served"]],
      undeclared: ["brain"],
      brainStillActive: "active",
      widened: { failed: "resource.unavailable" },
      sent: 0,
      sneak: "absent",
      find: { failed: "operation.not_found" },
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
    const { owner: otherBuilder } = await appWith(deskFiles());
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
      states: { ai: "served", brain: "served" },
      choices: [null, null],
      labels: [
        { connection: null, collections: {} },
        {
          connection: null,
          collections: { handbook: "Handbook", salaries: "Handbook" },
        },
      ],
      staff: [null, null],
      member: "app.not_found",
      otherBuilder: "app.not_found",
    });
  });
});
