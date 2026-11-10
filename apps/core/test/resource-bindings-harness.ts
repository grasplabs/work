import type { AuditEvent } from "@grasp-os/shared/audit";
import type { Json } from "@grasp-os/shared/json";
import type { OperationResult } from "@grasp-os/shared/operations";
import type { ResourceBindingsReview } from "@grasp-os/shared/resource-bindings";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { callAppFunction } from "../src/app-functions.ts";
import type { FunctionAnswer } from "../src/app-functions.ts";
import { publishVersion } from "../src/app-publish.ts";
import type { Release } from "../src/app-releases.ts";
import { appFor } from "../src/apps.ts";
import {
  appResourceBindings,
  permissions as permissionRows,
} from "../src/db/core/schema.ts";
import { createCollection } from "../src/knowledge/collection-rules.ts";
import { saveDocument } from "../src/knowledge/person-writes.ts";
import { grantPermission, requestPermission } from "../src/permissions.ts";
import { approveResourceBinding } from "../src/resource-bindings.ts";
import { testApp } from "./app-definitions.ts";
import type { AppSpec, TestApp, TestSource } from "./app-definitions.ts";
import { commitDefined } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { fakeProviderFor } from "./model-provider.ts";
import type { FakeProvider, ProviderReply } from "./model-provider.ts";
import { appWith, person, seal } from "./sealed-apps.ts";
import type { Fixture } from "./sealed-apps.ts";

// What resource-bindings*.test.ts share: the Apps whose resources an
// admin binds, and how they call them and read what was approved.

/** The model the organization chose, which answers at most 65,536 tokens. */
export const chosenModel = "mistral/mistral-large-latest";

/**
 * An App whose actions ask its `ai` for text and for values, each within
 * `maxOutputTokens`.
 */
/** The notes each of these Apps keeps, each its owner's. */
export const notesTable = {
  notes: {
    fields: { title: "v.string()" },
    access: { read: "owner", write: "owner" },
  },
} satisfies AppSpec["tables"];

export const modelFiles = (maxOutputTokens = 300): TestApp =>
  testApp(
    {
      name: "Assistant",
      tables: notesTable,
      permissions: [`permission.ai({ maxOutputTokens: ${maxOutputTokens} })`],
    },
    {
      "server/assist.ts": `import { v } from "@grasp-os/sdk";
import { action } from "@server/_generated/server";
import { permissions } from "../grasp.config.ts";

export const ai = permissions.ai;

export const label = action({
  args: { text: v.string().min(1) },
  returns: v.object({ label: v.string(), status: v.string() }),
  handler: async (ctx, args) =>
    await ctx.ai.generate({
      prompt: args.text,
      output: v.object({ label: v.string(), status: v.string().default("draft") }),
    }),
});

export const draft = action({
  args: { prompt: v.string().min(1) },
  returns: v.string(),
  handler: async (ctx, args) =>
    await ctx.ai.generate({ prompt: args.prompt, instructions: "Be brief." }),
});

export const tag = action({
  args: { text: v.string().min(1) },
  returns: v.object({ tags: v.array(v.string()) }),
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
    }
  );

export type Sealed = Fixture & { release: Release };

/** An App with `files`, sealed and current. */
export const sealedApp = async (
  files: TestSource,
  name?: string
): Promise<Sealed> => {
  const fixture = await appWith(files, name);
  const release = await seal(fixture);
  await publishVersion(env, fixture.owner, fixture.app, 1);
  return { ...fixture, release };
};

/** Commits `files` as the App's next version, seals it and makes it current. */
export const nextVersion = async (
  sealed: Sealed,
  files: TestSource,
  version: number
): Promise<Sealed> => {
  await commitDefined(env, sealed.owner, sealed.app, files, "Next version");
  const release = await seal(sealed, version);
  await publishVersion(env, sealed.owner, sealed.app, version);
  return { ...sealed, release };
};

/** The request a page sends to call `path` of `release`. */
export const requestFor = (
  release: Release,
  path: string,
  input: unknown
): string => {
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
export const providerEnv = async (
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
export const chooseModel = async (): Promise<void> => {
  await fakeProviderFor([chosenModel]);
};

export const answer = (text: string): ProviderReply => ({
  text,
  inputTokens: 100,
  outputTokens: 20,
});

/** Calls `path` of the App as its owner, through `callEnv`. */
export const call = async (
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
export const codeOfError = (error: unknown): string =>
  error instanceof Error ? String(Reflect.get(error, "code")) : "?";

/** Knowledge hits, as an action answers them. */
export const hitsSchema = z.array(
  z.strictObject({ title: z.string(), excerpt: z.string() })
);

/** What a call answered: its value, or its error's code. */
export const outcomeOf = (result: OperationResult): Json =>
  result.ok ? result.value : { failed: result.error.code };

/** An admin's approval of the App's `ai` to the chosen model. */
export const approveModel = async (
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
export const auditedFor = async (
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
export const sentText = (provider: FakeProvider, index: number): string =>
  JSON.stringify(provider.requests[index]?.body ?? null);

/** An approval of the App's `ai` to the chosen model, as a client sends it. */
export const writerApproval = (sealed: Sealed) => ({
  app: sealed.app,
  alias: "ai",
  target: { kind: "model", model: chosenModel },
  reviewed: { version: 1 },
});

/** An App whose actions search and read two of the Brain's collections. */
export const knowledgeFiles = (): TestApp =>
  testApp(
    {
      name: "Help",
      tables: notesTable,
      permissions: [
        'permission.brain({ operations: ["search", "read"], collections: ["handbook", "salaries"] })',
        "permission.ai({ maxOutputTokens: 300 })",
      ],
    },
    {
      "server/help.ts": `import { v } from "@grasp-os/sdk";
import { action } from "@server/_generated/server";
import { permissions } from "../grasp.config.ts";

export const brain = permissions.brain;

export const find = action({
  args: { text: v.string().min(1) },
  returns: v.array(v.object({ title: v.string(), excerpt: v.string() })).max(20),
  handler: async (ctx, args) => await ctx.brain.search({ text: args.text, limit: 5 }),
});

export const open = action({
  args: { id: v.string().min(1) },
  returns: v.object({ title: v.string(), text: v.string() }),
  handler: async (ctx, args) => await ctx.brain.read({ id: args.id }),
});

export const ai = permissions.ai;

/** Reads a document, then has the model summarize it. */
export const summarize = action({
  args: { id: v.string().min(1) },
  returns: v.string(),
  handler: async (ctx, args) => {
    const document = await ctx.brain.read({ id: args.id });
    return await ctx.ai.generate({ prompt: document.text });
  },
});
`,
    }
  );

/** A collection permission of the App, asked for by its owner and granted. */
export const grantedCollection = async (
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
export const knowledgeApp = async () => {
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
export const answerOf = async (
  { app, owner, release }: Sealed,
  path: string,
  input: unknown
): Promise<FunctionAnswer> =>
  await callAppFunction(env, owner, app, requestFor(release, path, input));

/** A search text of exactly `length` code units that still finds the leave policy. */
export const searchTextOf = (length: number): string =>
  "leave ".repeat(length).slice(0, length);

/** An admin's approval of the App's `writer`. */
export const approveWriter = async (sealed: Sealed) =>
  await approveResourceBinding(
    env,
    await person("admin"),
    writerApproval(sealed)
  );

/** Calls `path` of the App through `callEnv`. */
export const callOn = async (
  callEnv: Env,
  sealed: Sealed,
  path: string
): Promise<OperationResult> =>
  await call(callEnv, sealed, path, { prompt: "Hi" });

/** Calls the App's `draft` through `callEnv`: its outcome. */
export const draftOn = async (callEnv: Env, sealed: Sealed): Promise<Json> =>
  outcomeOf(await callOn(callEnv, sealed, "assist.draft"));

/** App `app`'s active binding's row, to damage what it stores. */
export const active = (app: string) =>
  and(
    eq(appResourceBindings.appId, app),
    eq(appResourceBindings.status, "active")
  );

/**
 * An App whose actions use its `ai` (unless `withWriter` is false), with
 * `maxOutputTokens`, and the Brain's `collections` (unless `withBrain` is
 * false); with `sneak`, one more action that reaches for the Brain past
 * its types without listing it.
 */
export const deskFiles = ({
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
} = {}): TestApp =>
  testApp(
    {
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
    },
    {
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
  handler: async (ctx, args) => await ctx.brain.search({ text: args.text }),
});`
    : ""
}

${
  withWriter
    ? `export const draft = action({
  args: { prompt: v.string().min(1) },
  returns: v.string(),
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
    }
  );

/** The Desk App, sealed and current, granted to read one collection. */
export const deskApp = async () => {
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

export type Desk = Awaited<ReturnType<typeof deskApp>>;

/** Binds each of the Desk's permissions, as its admin, to what it is offered. */
export const bindDesk = async ({ sealed, admin, permission }: Desk) => {
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
export const chatScopedCopy = async (id: string): Promise<void> => {
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
export const statesOf = (
  review: ResourceBindingsReview
): Record<string, string> =>
  Object.fromEntries(
    review.resources.map(({ alias, state }) => [alias, state])
  );
