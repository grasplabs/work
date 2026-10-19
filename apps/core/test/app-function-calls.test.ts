import type { AuditEvent } from "@grasp-os/shared/audit";
import {
  appIdSchema,
  chatIdSchema,
  runIdSchema,
  workflowIdSchema,
  workspaceIdSchema,
} from "@grasp-os/shared/ids";
import type { Authority } from "@grasp-os/shared/permissions";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import { executionErrors } from "@grasp-os/shared/workflows";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { actionInvocation, invocationName } from "../src/action-invocation.ts";
import {
  callAppFunction,
  callRunFunction,
  readFunctionRequest,
} from "../src/app-functions.ts";
import type { RunCaller } from "../src/app-functions.ts";
import { addMember } from "../src/app-members.ts";
import type { Release } from "../src/app-releases.ts";
import { loadRelease } from "../src/app-releases.ts";
import { bindWorkflowToApp } from "../src/app-workflow-bindings.ts";
import { appFor, commitFiles, setCurrentVersion } from "../src/apps.ts";
import { requireResourceRole } from "../src/permission-resources.ts";
import { grantPermission, requestPermission } from "../src/permissions.ts";
import {
  approveResourceBinding,
  reviewResourceBindings,
  revokeResourceBinding,
} from "../src/resource-bindings.ts";
import { isRestricted, restrict } from "../src/restricted.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
import { release } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { endLiveRuns, finished, leave } from "./runs.ts";
import { appWith, failure, person, seal } from "./sealed-apps.ts";
import type { Fixture } from "./sealed-apps.ts";
import { signedInApi } from "./sign-in.ts";

// Another App's public functions through an app resource an App's actions
// declare (`resource.app`), which reaches nothing until an admin binds it
// to an App serving each function exactly as declared (resource-apps.ts).
// The ways it can fail come first: a declaration that grants itself, or a
// binding to the App itself or to one that doesn't serve it; a call that
// runs as the called App's owner, or for someone without a role in it; a
// contract the called App changed still served; calls between Apps going
// round or too deep; a withdrawn caller still committing; restricted data
// crossing unmarked; and calls nobody can trace.

const idp = mockIdp();

/** The CRM: notes each person keeps, and a function only it calls. */
const crmFiles = (
  mineReturns = "v.array(v.string())",
  // What `mine` answers, as its contract (`mineReturns`) types it.
  mineAnswer = '(await ctx.db.query("notes").take(100)).map(({ text }) => text)'
) => ({
  "schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({ notes: defineTable({ text: v.string() }) });
`,
  "operations/crm.ts": `import { resource, v } from "@grasp-os/sdk";
import { action, internalQuery, mutation, query } from "#grasp/server";

export const followUp = resource.workflow("followUp", {
  input: v.object({ who: v.string() }),
  output: v.object({ status: v.string() }),
});

/** Starts the CRM's follow-up: what the start answered, or why it refused. */
export const kick = action({
  args: {},
  returns: v.string(),
  uses: [followUp],
  handler: async (ctx) => {
    try {
      await ctx.startWorkflow(followUp, { who: "Ada" });
      return "started";
    } catch (error) {
      return "error:" + String(Reflect.get(Object(error), "code"));
    }
  },
});

/** Stages the CRM's follow-up with a note. */
export const kickLater = mutation({
  args: {},
  returns: v.null(),
  uses: [followUp],
  handler: async (ctx) => {
    await ctx.db.insert("notes", { text: "kicked" });
    await ctx.afterCommit.start(followUp, { who: "Ada" });
    return null;
  },
});

export const add = mutation({
  args: { text: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("notes", { text: args.text });
    return null;
  },
});

/** Waits a while, then keeps a note: a cancel meanwhile must stop it. */
export const later = action({
  args: { text: v.string() },
  returns: v.null(),
  uses: [add],
  handler: async (ctx, args) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await ctx.runMutation(add, { text: args.text });
    return null;
  },
});

export const mine = query({
  args: {},
  returns: ${mineReturns},
  handler: async (ctx) => ${mineAnswer},
});

export const shout = action({
  args: { text: v.string() },
  returns: v.string(),
  handler: async (_ctx, args) => args.text.toUpperCase(),
});

export const hidden = internalQuery({ args: {}, returns: v.number(), handler: () => 1 });
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { add, followUp, hidden, kick, kickLater, later, mine, shout } from "./operations/crm.ts";
import schema from "./schema.ts";

export default app({
  name: "CRM",
  schema,
  access: { tables: { notes: { read: "owner", write: "owner" } } },
  operations: { notes: { add, mine, shout, kick, kickLater, later } },
  internalOperations: { notes: { hidden } },
  screens: [],
  uses: [followUp],
});
`,
});

/** What a call answered, as JSON, or why it failed: its code and the App's. */
const attempt = `const attempt = async (work: () => Promise<unknown>): Promise<string> => {
  try {
    return JSON.stringify(await work());
  } catch (error) {
    const details = Object(Reflect.get(Object(error), "details"));
    return ["error", Reflect.get(Object(error), "code"), Reflect.get(details, "code") ?? Reflect.get(details, "limit")]
      .filter((part) => part !== undefined)
      .map(String)
      .join(":");
  }
};`;

/** The Desk: it calls the CRM's notes through `crm`. */
const deskFiles = (extra = ""): Record<string, string> => ({
  "schema.ts": `import { defineSchema } from "@grasp-os/sdk";

export default defineSchema({});
`,
  "operations/desk.ts": `import { resource, v } from "@grasp-os/sdk";
import { action } from "#grasp/server";

export const crm = resource.app("crm", {
  functions: {
    "notes.add": { kind: "mutation", args: { text: v.string() }, returns: v.null() },
    "notes.mine": { kind: "query", args: {}, returns: v.array(v.string()) },
    "notes.shout": { kind: "action", args: { text: v.string() }, returns: v.string() },
    "notes.kick": { kind: "action", args: {}, returns: v.string() },
    "notes.kickLater": { kind: "mutation", args: {}, returns: v.null() },
    "notes.later": { kind: "action", args: { text: v.string() }, returns: v.null() },
  },
});

${attempt}

export const add = action({
  args: { text: v.string() },
  returns: v.string(),
  uses: [crm],
  handler: async (ctx, args) => await attempt(() => ctx.resources.crm.call("notes.add", { text: args.text })),
});

export const mine = action({
  args: {},
  returns: v.string(),
  uses: [crm],
  handler: async (ctx) => await attempt(() => ctx.resources.crm.call("notes.mine", {})),
});

export const shout = action({
  args: { text: v.string() },
  returns: v.string(),
  uses: [crm],
  handler: async (ctx, args) => await attempt(() => ctx.resources.crm.call("notes.shout", { text: args.text })),
});

export const kick = action({
  args: {},
  returns: v.string(),
  uses: [crm],
  handler: async (ctx) => await attempt(() => ctx.resources.crm.call("notes.kick", {})),
});

export const kickLater = action({
  args: {},
  returns: v.string(),
  uses: [crm],
  handler: async (ctx) => await attempt(() => ctx.resources.crm.call("notes.kickLater", {})),
});

export const later = action({
  args: { text: v.string() },
  returns: v.string(),
  uses: [crm],
  handler: async (ctx, args) => await attempt(() => ctx.resources.crm.call("notes.later", { text: args.text })),
});
${extra}`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { add, crm, kick, kickLater, later, mine, shout } from "./operations/desk.ts";
import schema from "./schema.ts";

export default app({
  name: "Desk",
  schema,
  access: { tables: {} },
  operations: { desk: { add, mine, shout, kick, kickLater, later } },
  internalOperations: {},
  screens: [],
  uses: [crm],
});
`,
});

/** A relay: `relay.go` calls the next App's `relay.go`, and says how far it got. */
const relayFiles: Record<string, string> = {
  "schema.ts": `import { defineSchema } from "@grasp-os/sdk";

export default defineSchema({});
`,
  "operations/relay.ts": `import { resource, v } from "@grasp-os/sdk";
import { action } from "#grasp/server";

export const next = resource.app("next", {
  functions: { "relay.go": { kind: "action", args: {}, returns: v.string() } },
});

export const go = action({
  args: {},
  returns: v.string(),
  uses: [next],
  handler: async (ctx) => {
    try {
      return "+" + (await ctx.resources.next.call("relay.go", {}));
    } catch (error) {
      const details = Object(Reflect.get(Object(error), "details"));
      return "+error:" + String(Reflect.get(Object(error), "code")) + ":" + String(Reflect.get(details, "limit"));
    }
  },
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { go, next } from "./operations/relay.ts";
import schema from "./schema.ts";

export default app({
  name: "Relay",
  schema,
  access: { tables: {} },
  operations: { relay: { go } },
  internalOperations: {},
  screens: [],
  uses: [next],
});
`,
};

/**
 * A fan: `fan.go` with depth 0 answers "1"; deeper, it calls the next
 * App's `fan.go` `width` times, one depth less, and answers how many
 * leaves answered, and the first refusal it met.
 */
const fanFiles: Record<string, string> = {
  "schema.ts": `import { defineSchema } from "@grasp-os/sdk";

export default defineSchema({});
`,
  "operations/fan.ts": `import { resource, v } from "@grasp-os/sdk";
import { action } from "#grasp/server";

export const next = resource.app("next", {
  functions: {
    "fan.go": { kind: "action", args: { width: v.number(), depth: v.number() }, returns: v.string() },
  },
});

export const go = action({
  args: { width: v.number(), depth: v.number() },
  returns: v.string(),
  uses: [next],
  handler: async (ctx, args) => {
    if (args.depth === 0) {
      return "1";
    }
    let leaves = 0;
    let refused = "";
    for (let call = 0; call < args.width; call += 1) {
      try {
        const answer = await ctx.resources.next.call("fan.go", { width: args.width, depth: args.depth - 1 });
        const [count, inner] = answer.split(";");
        leaves += Number(count);
        refused ||= inner ?? "";
      } catch (error) {
        const details = Object(Reflect.get(Object(error), "details"));
        refused ||= String(Reflect.get(Object(error), "code")) + ":" + String(Reflect.get(details, "limit") ?? Reflect.get(details, "code"));
      }
    }
    return String(leaves) + ";" + refused;
  },
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { go, next } from "./operations/fan.ts";
import schema from "./schema.ts";

export default app({
  name: "Fan",
  schema,
  access: { tables: {} },
  operations: { fan: { go } },
  internalOperations: {},
  screens: [],
  uses: [next],
});
`,
};

/** The Inviter: one action that invites a guest through its `guests`. */
const inviterFiles: Record<string, string> = {
  "schema.ts": `import { defineSchema } from "@grasp-os/sdk";

export default defineSchema({});
`,
  "operations/inviter.ts": `import { resource, v } from "@grasp-os/sdk";
import { action } from "#grasp/server";

export const guests = resource.guests("guests", { operations: ["invite"] });

export const invite = action({
  args: {},
  returns: v.string(),
  uses: [guests],
  handler: async (ctx) => {
    try {
      const chat = await ctx.resources.guests.invite({ name: "Anna", skill: "interview-a-stakeholder" });
      return chat.link.length > 0 ? "invited" : "no link";
    } catch (error) {
      return "error:" + String(Reflect.get(Object(error), "code"));
    }
  },
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { guests, invite } from "./operations/inviter.ts";
import schema from "./schema.ts";

export default app({
  name: "Inviter",
  schema,
  access: { tables: {} },
  operations: { inviter: { invite } },
  internalOperations: {},
  screens: [],
  uses: [guests],
});
`,
};

/**
 * An App that calls another's `name.fn` action (no arguments, a string
 * back) through its `next`, from `asker.go`, answering what it got.
 */
const askerFiles = (fn: string): Record<string, string> => ({
  "schema.ts": `import { defineSchema } from "@grasp-os/sdk";

export default defineSchema({});
`,
  "operations/asker.ts": `import { resource, v } from "@grasp-os/sdk";
import { action } from "#grasp/server";

export const next = resource.app("next", {
  functions: { "${fn}": { kind: "action", args: {}, returns: v.string() } },
});

export const go = action({
  args: {},
  returns: v.string(),
  uses: [next],
  handler: async (ctx) => {
    try {
      return await ctx.resources.next.call("${fn}", {});
    } catch (error) {
      return "refused:" + String(Reflect.get(Object(error), "code"));
    }
  },
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { go, next } from "./operations/asker.ts";
import schema from "./schema.ts";

export default app({
  name: "Asker",
  schema,
  access: { tables: {} },
  operations: { asker: { go } },
  internalOperations: {},
  screens: [],
  uses: [next],
});
`,
});

/** A workflow `id` whose one step calls its App's `asker.go`. */
const askingWorkflow = (id: string): Record<string, string> => ({
  [`workflows/${id}.ts`]: `import { type Json, workflow, z } from "@grasp-os/sdk/workflow";

export default workflow("${id}", { params: {}, input: z.unknown() }, async (step, { env }) =>
  await step.do("ask", { description: "Ask", sideEffect: true, input: null, retries: { limit: 0 } }, async () =>
    (await env.APP.callFunction(${JSON.stringify({ contractId: "asker.go", kind: "action" })}, {})) as Json
  )
);
`,
  [`workflows/${id}.workflow-tests.ts`]: `import { workflowTests } from "@grasp-os/sdk/testing";

import definition from "./${id}.ts";

export default workflowTests(definition, [{ name: "runs", mocks: { ask: null }, expect: {} }]);
`,
});

type Sealed = Fixture & { release: Release };

const objectSchema = (properties: Record<string, unknown>) => ({
  format: "json",
  document: {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  },
});

/** A greeting workflow's definition, named `name`. */
const definitionOf = (name: string): string =>
  JSON.stringify({
    document: {
      dsl: "1.0.3",
      namespace: workflowNamespace,
      name,
      version: "1.0.0",
      title: name,
      metadata: {
        grasp: { profile: "grasp-open-workflow/1", params: {}, bindings: {} },
      },
    },
    input: { schema: objectSchema({ who: { type: "string" } }) },
    output: { schema: objectSchema({ status: { type: "string" } }) },
    do: [{ greet: { set: { status: "done" } } }],
  });

/**
 * A workflow the CRM's owner publishes and binds to its `followUp`, which
 * an admin lets it start: so the CRM's own starts go through.
 */
const bindFollowUp = async (admin: Person, crm: Sealed): Promise<void> => {
  const workflow = await createWorkflowResource(
    env,
    crm.owner,
    `follow-up-${crypto.randomUUID().slice(0, 8)}`
  );
  await publishWorkflowVersion(env, crm.owner, workflow.id, {
    definition: definitionOf(workflow.name),
    basedOn: null,
  });
  await bindWorkflowToApp(env, crm.owner, workflow.id, {
    app: crm.app,
    alias: "followUp",
    version: 1,
  });
  const asked = await requestPermission(
    env,
    crm.owner,
    {
      subject: { type: "app", appId: crm.app },
      object: { type: "workflow", workflowId: workflow.id },
      actions: ["start"],
      binding: "FOLLOW_UP",
    },
    {
      app: async (named, role) => await appFor(env, crm.owner, named, role),
      resource: async (ref, needed) => {
        await requireResourceRole(env, crm.owner, ref, needed);
      },
    }
  );
  await grantPermission(env, admin, asked.id, {
    version: crm.release.manifest.resourceVersion,
  });
};

/** An App with `files`, sealed and current. */
const sealedApp = async (
  files: Record<string, string>,
  name?: string
): Promise<Sealed> => {
  const fixture = await appWith(files, name);
  const sealed = await seal(fixture);
  await setCurrentVersion(env, fixture.owner, fixture.app, 1);
  return { ...fixture, release: sealed };
};

/** Commits `files` as the App's version `version`, seals it and makes it current. */
const nextVersion = async (
  sealed: Sealed,
  files: Record<string, string>,
  version: number
): Promise<Sealed> => {
  await commitFiles(env, sealed.owner, sealed.app, files, "Next version");
  const next = await seal(sealed, version);
  await setCurrentVersion(env, sealed.owner, sealed.app, version);
  return { ...sealed, release: next };
};

type Person = Awaited<ReturnType<typeof person>>;

/** What `by` gets calling `path` of `sealed`'s current release, as a screen calls it. */
const call = async (
  by: Person,
  sealed: Sealed,
  path: string,
  input: unknown = {},
  stillAllowed?: () => Promise<void>
): Promise<unknown> => {
  const { release: current } = sealed;
  const operation = current.app.operations[path];
  const answer = await callAppFunction(
    env,
    by,
    sealed.app,
    JSON.stringify({
      reference: {
        resourceId: current.manifest.resourceId,
        resourceVersion: current.manifest.resourceVersion,
        contractId: path,
        fingerprint: current.fingerprints[path] ?? "",
        kind: operation?.kind ?? "query",
      },
      input,
    }),
    Date.now() + 30_000,
    stillAllowed
  );
  if (!answer.result.ok) {
    return `refused:${answer.result.error.code}`;
  }
  const { value } = answer.result;
  if (typeof value !== "string") {
    return value;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed;
  } catch {
    // An answer that isn't JSON: as it came.
    return value;
  }
};

/**
 * The action `path` of `sealed`'s current release, started for `by` as a
 * screen sends it, under an idempotency key: through its action
 * invocation object (action-invocation.ts), not `callAppFunction`. Its
 * object's name, and what it answers.
 */
const startScreenAction = async (
  by: Person,
  sealed: Sealed,
  path: string,
  input: unknown
): Promise<{ name: string; result: Promise<unknown> }> => {
  const { release: current } = sealed;
  const key = crypto.randomUUID();
  const request = readFunctionRequest(
    JSON.stringify({
      reference: {
        resourceId: current.manifest.resourceId,
        resourceVersion: current.manifest.resourceVersion,
        contractId: path,
        fingerprint: current.fingerprints[path] ?? "",
        kind: "action",
      },
      input,
      idempotencyKey: key,
    })
  );
  const app = appIdSchema.parse(sealed.app);
  const name = await invocationName(by.userId, app, request, key, false);
  const frames = await actionInvocation(env, name).open({
    by,
    access: "the person's",
    app,
    name,
    call: request,
    streaming: false,
    attach: false,
  });
  const result = (async () => {
    const text = await new Response(frames).text();
    return z.object({ result: z.unknown() }).parse(JSON.parse(text)).result;
  })();
  return { name, result };
};

/** What `by` gets running the action `path` of `sealed` as a screen sends it. */
const screenAction = async (
  by: Person,
  sealed: Sealed,
  path: string,
  input: unknown
): Promise<unknown> => {
  const { result } = await startScreenAction(by, sealed, path, input);
  return await result;
};

/** The admin's binding of `caller`'s `alias` to App `appId`. */
const bind = async (
  admin: Person,
  caller: Sealed,
  appId: string,
  alias = "crm"
) =>
  await approveResourceBinding(env, admin, {
    app: caller.app,
    alias,
    target: { kind: "app", appId },
    reviewed: { version: caller.release.manifest.resourceVersion },
  });

/** `sealed`'s own authority, as its restricted mode reads it. */
const authorityOf = (sealed: Sealed): Authority => ({
  subject: { type: "app", appId: appIdSchema.parse(sealed.app) },
  onBehalfOf: sealed.owner.userId,
  mode: "interactive",
  appVersion: 1,
});

/** `sealed`'s own work context. */
const contextOf = (sealed: Sealed) =>
  ({ type: "app", appId: appIdSchema.parse(sealed.app) }) as const;

/** The audit log's `app.call` events to App `callee`. */
const callsTo = (events: readonly AuditEvent[], callee: string) =>
  events
    .filter(
      ({ action, target }) => action === "app.call" && target?.id === callee
    )
    .map(({ actor, detail }) => ({
      actor,
      function: detail.function,
      onBehalfOf: detail.onBehalfOf,
      ...(detail.refused === undefined ? {} : { refused: detail.refused }),
    }));

describe("an App calling another App's functions", { timeout: 60_000 }, () => {
  it("reaches them only once an admin binds them, as the person calling, under the other App's roles", async () => {
    const admin = await person("admin");
    const crm = await sealedApp(crmFiles(), "CRM");
    const desk = await sealedApp(deskFiles(), "Desk");
    const relay = await sealedApp(relayFiles, "Relay");
    const unbound = await call(admin, desk, "desk.shout", { text: "hi" });
    // What an admin may bind it to: Apps that serve it exactly, the CRM
    // among them; never Desk itself, nor the relay, which serves nothing
    // Desk declares.
    const review = await reviewResourceBindings(env, admin, desk.app);
    const choices = review.resources.find(
      ({ alias }) => alias === "crm"
    )?.choices;
    const offered =
      choices?.kind === "app" ? choices.apps.map(({ appId }) => appId) : [];
    // Neither the App itself nor one that doesn't serve the declaration.
    const itself = await failure(async () => await bind(admin, desk, desk.app));
    const notServing = await failure(
      async () => await bind(admin, desk, relay.app)
    );
    // A builder may not approve one.
    const byBuilder = await failure(
      async () => await bind(desk.owner, desk, crm.app)
    );
    await bind(admin, desk, crm.app);
    // Desk's owner has no role in the CRM: the CRM refuses them.
    const noRole = await call(desk.owner, desk, "desk.add", { text: "mine" });
    await addMember(env, crm.owner, crm.app, {
      type: "person",
      id: desk.owner.userId,
      role: "user",
    });
    const added = await call(desk.owner, desk, "desk.add", { text: "mine" });
    expect({
      offered: {
        crm: offered.includes(crm.app),
        desk: offered.includes(desk.app),
        relay: offered.includes(relay.app),
      },
      unbound,
      itself,
      notServing,
      byBuilder,
      noRole,
      added,
      // The note is Desk's owner's in the CRM, never the CRM owner's.
      deskOwnerReads: await call(desk.owner, desk, "desk.mine"),
      crmOwnerReads: await call(crm.owner, crm, "notes.mine"),
      adminReads: await call(admin, desk, "desk.mine"),
      // An action of the CRM's, run for the person.
      shouted: await call(admin, desk, "desk.shout", { text: "hi" }),
      audited: callsTo(await allEvents(), crm.app),
    }).toStrictEqual({
      offered: { crm: true, desk: false, relay: false },
      unbound: "error:resource.unavailable",
      itself: "resource.target_invalid",
      notServing: "resource.target_invalid",
      byBuilder: "role.forbidden",
      noRole: "error:resource.unavailable",
      added: null,
      deskOwnerReads: ["mine"],
      crmOwnerReads: [],
      adminReads: [],
      shouted: "HI",
      // Each call the binding served, as the calling App, for its person;
      // the one the CRM refused once more, with why.
      audited: [
        {
          actor: { type: "app", appId: desk.app, part: "server" },
          function: "notes.add",
          onBehalfOf: desk.owner.userId,
        },
        {
          actor: { type: "app", appId: desk.app, part: "server" },
          function: "notes.add",
          onBehalfOf: desk.owner.userId,
          refused: "app.not_found",
        },
        {
          actor: { type: "app", appId: desk.app, part: "server" },
          function: "notes.add",
          onBehalfOf: desk.owner.userId,
        },
        {
          actor: { type: "app", appId: desk.app, part: "server" },
          function: "notes.mine",
          onBehalfOf: desk.owner.userId,
        },
        {
          actor: { type: "app", appId: desk.app, part: "server" },
          function: "notes.mine",
          onBehalfOf: admin.userId,
        },
        {
          actor: { type: "app", appId: desk.app, part: "server" },
          function: "notes.shout",
          onBehalfOf: admin.userId,
        },
      ],
    });
  });

  it("reach them from a screen's keyed action, as the browser sends it", async () => {
    const admin = await person("admin");
    const crm = await sealedApp(crmFiles(), "CRM");
    const desk = await sealedApp(deskFiles(), "Desk");
    await bind(admin, desk, crm.app);
    await expect(
      screenAction(admin, desk, "desk.shout", { text: "hi" })
      // Desk's answer: the CRM's, as JSON.
    ).resolves.toStrictEqual({ ok: true, value: '"HI"' });
  });

  it("stop calling another App once the person cancels the screen's action", async () => {
    const admin = await person("admin");
    const crm = await sealedApp(crmFiles(), "CRM");
    const desk = await sealedApp(deskFiles(), "Desk");
    await bind(admin, desk, crm.app);
    // The CRM's action waits before it keeps its note; the person cancels
    // Desk's action meanwhile.
    const { name, result } = await startScreenAction(
      admin,
      desk,
      "desk.later",
      { text: "after the cancel" }
    );
    await scheduler.wait(500);
    const cancelled = await actionInvocation(env, name).cancel(admin.userId);
    await result;
    // Past when the CRM's action would have kept it.
    await scheduler.wait(2500);
    expect({
      cancelled,
      crmNotes: await call(admin, crm, "notes.mine"),
    }).toStrictEqual({ cancelled: true, crmNotes: [] });
  });

  it("serves only another App's public functions, and stops once it changes a contract or the binding is revoked", async () => {
    const admin = await person("admin");
    const crm = await sealedApp(crmFiles(), "CRM");
    const desk = await sealedApp(deskFiles(), "Desk");
    // A declaration of the CRM's internal function: no App serves it.
    const prying = await sealedApp(
      {
        ...deskFiles(),
        "operations/desk.ts": (deskFiles()["operations/desk.ts"] ?? "").replace(
          '"notes.shout": { kind: "action", args: { text: v.string() }, returns: v.string() },',
          '"notes.shout": { kind: "action", args: { text: v.string() }, returns: v.string() },\n    "notes.hidden": { kind: "query", args: {}, returns: v.number() },'
        ),
      },
      "Prying desk"
    );
    const internal = await failure(
      async () => await bind(admin, prying, crm.app)
    );
    const binding = await bind(admin, desk, crm.app);
    const before = await call(admin, desk, "desk.shout", { text: "hi" });
    // The CRM's `notes.mine` answers another shape now.
    await nextVersion(
      crm,
      crmFiles("v.number()", '(await ctx.db.query("notes").take(100)).length'),
      2
    );
    const drifted = await call(admin, desk, "desk.shout", { text: "hi" });
    const { resources } = await reviewResourceBindings(env, admin, desk.app);
    const state = resources.find(({ alias }) => alias === "crm")?.state;
    const again = await failure(async () => await bind(admin, desk, crm.app));
    // Back as declared, and served again; then revoked.
    await nextVersion(crm, crmFiles(), 3);
    const restored = await call(admin, desk, "desk.shout", { text: "hi" });
    await revokeResourceBinding(env, admin, binding.id);
    expect({
      internal,
      before,
      drifted,
      state,
      again,
      restored,
      revoked: await call(admin, desk, "desk.shout", { text: "hi" }),
    }).toStrictEqual({
      internal: "resource.target_invalid",
      before: "HI",
      drifted: "error:resource.unavailable",
      state: "grant_lost",
      again: "resource.target_invalid",
      restored: "HI",
      revoked: "error:resource.unavailable",
    });
  });

  it("go on down a chain of Apps, never round and never more than three calls deep", async () => {
    const admin = await person("admin");
    const [first, second, third, fourth, fifth] = await Promise.all(
      ["First", "Second", "Third", "Fourth", "Fifth"].map(
        async (name) => await sealedApp(relayFiles, name)
      )
    );
    if (
      first === undefined ||
      second === undefined ||
      third === undefined ||
      fourth === undefined ||
      fifth === undefined
    ) {
      throw new Error("Five relays");
    }
    // A relay serves exactly what it declares: still never bound to itself.
    const itself = await failure(
      async () => await bind(admin, first, first.app, "next")
    );
    // First to fifth: three calls deep, the fourth may not call the fifth.
    await bind(admin, first, second.app, "next");
    await bind(admin, second, third.app, "next");
    await bind(admin, third, fourth.app, "next");
    await bind(admin, fourth, fifth.app, "next");
    const deep = await call(admin, first, "relay.go");
    // Fifth back to third: the third, already in the chain, isn't called.
    await bind(admin, fifth, third.app, "next");
    const round = await call(admin, fifth, "relay.go");
    expect({ itself, deep, round }).toStrictEqual({
      itself: "resource.target_invalid",
      deep: "++++error:resource.limit_reached:depth",
      round: "+++error:resource.limit_reached:cycle",
    });
  });

  it("commits nothing in the other App once the calling App's own authority is withdrawn mid-call", async () => {
    const admin = await person("admin");
    const crm = await sealedApp(crmFiles(), "CRM");
    const desk = await sealedApp(deskFiles(), "Desk");
    await bind(admin, desk, crm.app);
    // What admitted Desk's call holds as it starts and as its request is
    // admitted, then is withdrawn: the CRM's mutation commits nothing.
    let checks = 0;
    const answered = await call(
      admin,
      desk,
      "desk.add",
      { text: "late" },
      async () => {
        checks += 1;
        if (checks > 2) {
          throw new Error("Withdrawn");
        }
        await Promise.resolve();
      }
    );
    expect({
      refused: typeof answered === "string" && answered.startsWith("error:"),
      crmSees: await call(admin, crm, "notes.mine"),
    }).toStrictEqual({ refused: true, crmSees: [] });
  });

  it("make no more calls between Apps than one call may, down every branch", async () => {
    const admin = await person("admin");
    const [top, middle, leaf] = await Promise.all(
      ["Top fan", "Middle fan", "Leaf fan"].map(
        async (name) => await sealedApp(fanFiles, name)
      )
    );
    if (top === undefined || middle === undefined || leaf === undefined) {
      throw new Error("Three fans");
    }
    await bind(admin, top, middle.app, "next");
    await bind(admin, middle, leaf.app, "next");
    // Six to the middle, six from each to a leaf: 42 calls asked for.
    const answer = await call(admin, top, "fan.go", { width: 6, depth: 2 });
    const [leaves, refused] = String(answer).split(";");
    expect({ leaves: Number(leaves), refused }).toStrictEqual({
      // 32 in all: five to the middle, and 27 of the leaves.
      leaves: 27,
      refused: "resource.limit_reached:calls",
    });
  });

  it("stop a call between Apps once its binding is revoked during it", async () => {
    const admin = await person("admin");
    const crm = await sealedApp(crmFiles(), "CRM");
    const desk = await sealedApp(deskFiles(), "Desk");
    const binding = await bind(admin, desk, crm.app);
    // Desk's call starts and its request is admitted; then, as the CRM's
    // function is admitted, the binding is revoked.
    let checks = 0;
    const answered = await call(
      admin,
      desk,
      "desk.add",
      { text: "late" },
      async () => {
        checks += 1;
        if (checks === 3) {
          await revokeResourceBinding(env, admin, binding.id);
        }
      }
    );
    expect({
      answered,
      crmSees: await call(admin, crm, "notes.mine"),
    }).toStrictEqual({
      answered: "error:resource.unavailable",
      crmSees: [],
    });
  });

  it("call nothing for a person who left during the call, and record nothing of it", async () => {
    const admin = await person("admin");
    const leaver = await person("admin");
    const crm = await sealedApp(crmFiles(), "CRM");
    const desk = await sealedApp(deskFiles(), "Desk");
    await bind(admin, desk, crm.app);
    // The person leaves once Desk's request is admitted.
    let checks = 0;
    const answered = await call(
      leaver,
      desk,
      "desk.shout",
      { text: "hi" },
      async () => {
        checks += 1;
        if (checks === 2) {
          await leave(leaver.userId);
        }
      }
    );
    expect({
      answered,
      recorded: callsTo(await allEvents(), crm.app).filter(
        ({ onBehalfOf }) => onBehalfOf === leaver.userId
      ),
    }).toStrictEqual({
      answered: "error:resource.unavailable",
      recorded: [],
    });
  });

  it("carry the agent a call came from down the chain, to each App's call and its record", async () => {
    const admin = await person("admin");
    const [first, second, third] = await Promise.all(
      ["Agent first", "Agent second", "Agent third"].map(
        async (name) => await sealedApp(relayFiles, name)
      )
    );
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error("Three relays");
    }
    await bind(admin, first, second.app, "next");
    await bind(admin, second, third.app, "next");
    const agent = {
      agentId: `agent-${crypto.randomUUID()}`,
      workspaceId: workspaceIdSchema.parse(crypto.randomUUID()),
      chatId: chatIdSchema.parse(crypto.randomUUID()),
    };
    const { release: current } = first;
    await callAppFunction(
      env,
      admin,
      first.app,
      JSON.stringify({
        reference: {
          resourceId: current.manifest.resourceId,
          resourceVersion: current.manifest.resourceVersion,
          contractId: "relay.go",
          fingerprint: current.fingerprints["relay.go"] ?? "",
          kind: "action",
        },
        input: {},
      }),
      Date.now() + 30_000,
      undefined,
      undefined,
      agent
    );
    const events = await allEvents();
    const agentOf = (callee: string) =>
      events
        .filter(
          ({ action, target, detail }) =>
            action === "app.call" &&
            target?.id === callee &&
            detail.refused === undefined
        )
        .map(({ detail }) => detail.agent ?? null);
    // Both hops name the agent: the second App's call was the agent's too.
    expect({
      second: agentOf(second.app),
      third: agentOf(third.app),
    }).toStrictEqual({ second: [agent.agentId], third: [agent.agentId] });
  });

  it("carries restricted mode both ways, before the data moves", async () => {
    const admin = await person("admin");
    const crm = await sealedApp(crmFiles(), "CRM");
    const desk = await sealedApp(deskFiles(), "Desk");
    const other = await sealedApp(deskFiles(), "Other desk");
    const crm2 = await sealedApp(crmFiles(), "Second CRM");
    await bind(admin, desk, crm.app);
    await bind(admin, other, crm2.app);
    const restricted = async (sealed: Sealed) =>
      await isRestricted(env, authorityOf(sealed), contextOf(sealed));
    // The CRM read restricted data: Desk reading from it is restricted too.
    await restrict(env, authorityOf(crm), contextOf(crm), ["test"]);
    const deskBefore = await restricted(desk);
    await call(desk.owner, desk, "desk.shout", { text: "hi" });
    // A restricted caller restricts the App it calls.
    await restrict(env, authorityOf(other), contextOf(other), ["test"]);
    const crm2Before = await restricted(crm2);
    await call(other.owner, other, "desk.shout", { text: "hi" });
    expect({
      deskBefore,
      deskAfter: await restricted(desk),
      crm2Before,
      crm2After: await restricted(crm2),
    }).toStrictEqual({
      deskBefore: false,
      deskAfter: true,
      crm2Before: false,
      crm2After: true,
    });
  });
});

/** The value of a function's answer, as a step got it, if it answered. */
const valueOf = (answer: unknown): unknown =>
  z.object({ ok: z.literal(true), value: z.string() }).safeParse(answer).data
    ?.value;

describe("a run calling another App's functions", { timeout: 90_000 }, () => {
  afterEach(async () => {
    await endLiveRuns();
  });

  it("starts no workflow of the App a run calls, in an action or after a commit", async () => {
    const builder = await signedInApi(idp, "builder");
    const admin = await person("admin");
    const crm = await sealedApp(crmFiles(), "CRM");
    await addMember(env, crm.owner, crm.app, {
      type: "person",
      id: builder.userId,
      role: "user",
    });
    const kick = JSON.stringify({ contractId: "desk.kick", kind: "action" });
    const later = JSON.stringify({
      contractId: "desk.kickLater",
      kind: "action",
    });
    const { id } = await builder.api.apps.create({ name: "Kicking desk" });
    await release(builder, id, {
      ...deskFiles(),
      "workflows/kicker.ts": `import { type Json, workflow, z } from "@grasp-os/sdk/workflow";

export default workflow("kicker", { params: {}, input: z.unknown() }, async (step, { env }) =>
  await step.do("kick", { description: "Kick", sideEffect: true, input: null, retries: { limit: 0 } }, async () => ({
    now: (await env.APP.callFunction(${kick}, {})) as Json,
    later: (await env.APP.callFunction(${later}, {})) as Json,
  }))
);
`,
      "workflows/kicker.workflow-tests.ts": `import { workflowTests } from "@grasp-os/sdk/testing";

import definition from "./kicker.ts";

export default workflowTests(definition, [{ name: "runs", mocks: { kick: null }, expect: {} }]);
`,
    });
    await approveResourceBinding(env, admin, {
      app: id,
      alias: "crm",
      target: { kind: "app", appId: crm.app },
      reviewed: { version: 1 },
    });
    await bindFollowUp(admin, crm);
    const run = await builder.api.workflows.start(id, "kicker");
    await finished(run.id);
    const ended = await builder.api.workflows.status(run.id);
    const output = z
      .object({ now: z.unknown(), later: z.unknown() })
      .parse(ended.output);
    const intents = await env.DB.prepare(
      "SELECT count(*) AS count FROM workflow_start_receipts WHERE invoker_type = 'app' AND invoker_id = ?"
    )
      .bind(crm.app)
      .first<{ count: number }>();
    // The same call from a screen starts the CRM's follow-up.
    const deskApp = appIdSchema.parse(id);
    const deskRelease = await loadRelease(env, deskApp, 1);
    const fromScreen = await call(
      { ...admin, userId: builder.userId, role: "builder", teams: [] },
      { ...crm, app: deskApp, release: deskRelease },
      "desk.kick"
    );
    const afterScreen = await env.DB.prepare(
      "SELECT count(*) AS count FROM workflow_start_receipts WHERE invoker_type = 'app' AND invoker_id = ?"
    )
      .bind(crm.app)
      .first<{ count: number }>();
    expect({
      status: ended.status,
      now: valueOf(output.now),
      later: valueOf(output.later),
      started: intents?.count,
      fromScreen,
      afterScreen: afterScreen?.count,
    }).toStrictEqual({
      status: "completed",
      now: '"error:resource.unavailable"',
      later: "error:resource.unavailable",
      started: 0,
      fromScreen: "started",
      afterScreen: 1,
    });
  });

  it("never invite a guest through another App, from a screen's call or a run's", async () => {
    const builder = await signedInApi(idp, "builder");
    const admin = await person("admin");
    const inviter = await sealedApp(inviterFiles, "Inviter");
    // The Inviter's own permission to invite guests, bound to its `guests`.
    const asked = await requestPermission(
      env,
      inviter.owner,
      {
        subject: { type: "app", appId: inviter.app },
        object: { type: "platform" },
        actions: ["guests"],
        binding: "GUESTS",
      },
      {
        app: async (named, role) =>
          await appFor(env, inviter.owner, named, role),
        resource: async (ref, needed) => {
          await requireResourceRole(env, inviter.owner, ref, needed);
        },
      }
    );
    await grantPermission(env, admin, asked.id, { version: 1 });
    await approveResourceBinding(env, admin, {
      app: inviter.app,
      alias: "guests",
      target: { kind: "guests", permissionId: asked.id },
      reviewed: { version: 1 },
    });
    await addMember(env, inviter.owner, inviter.app, {
      type: "person",
      id: builder.userId,
      role: "user",
    });
    // The Asker calls the Inviter's invite, from a screen and from a run.
    const { id } = await builder.api.apps.create({ name: "Asker" });
    await release(builder, id, {
      ...askerFiles("inviter.invite"),
      ...askingWorkflow("asking"),
    });
    await approveResourceBinding(env, admin, {
      app: id,
      alias: "next",
      target: { kind: "app", appId: inviter.app },
      reviewed: { version: 1 },
    });
    const asker = appIdSchema.parse(id);
    const askerSealed = {
      ...inviter,
      app: asker,
      release: await loadRelease(env, asker, 1),
    };
    const asBuilder = {
      ...admin,
      userId: builder.userId,
      role: "builder" as const,
      teams: [],
    };
    const direct = await call(asBuilder, inviter, "inviter.invite");
    const fromScreen = await call(asBuilder, askerSealed, "asker.go");
    const run = await builder.api.workflows.start(id, "asking");
    await finished(run.id);
    const ended = await builder.api.workflows.status(run.id);
    expect({
      // The person's own call invites.
      direct,
      fromScreen,
      fromRun: valueOf(ended.output),
    }).toStrictEqual({
      direct: "invited",
      fromScreen: "error:resource.not_allowed",
      fromRun: "error:resource.not_allowed",
    });
  });

  it("starts no workflow two Apps down a run's chain either", async () => {
    const builder = await signedInApi(idp, "builder");
    const admin = await person("admin");
    const crm = await sealedApp(crmFiles(), "CRM");
    const desk = await sealedApp(deskFiles(), "Desk");
    for (const sealed of [crm, desk]) {
      // oxlint-disable-next-line no-await-in-loop -- one App after the other
      await addMember(env, sealed.owner, sealed.app, {
        type: "person",
        id: builder.userId,
        role: "user",
      });
    }
    await bind(admin, desk, crm.app);
    await bindFollowUp(admin, crm);
    // A run of the Asker calls Desk's `desk.kick`, which calls the CRM's.
    const { id } = await builder.api.apps.create({ name: "Asker" });
    await release(builder, id, {
      ...askerFiles("desk.kick"),
      ...askingWorkflow("asking"),
    });
    await approveResourceBinding(env, admin, {
      app: id,
      alias: "next",
      target: { kind: "app", appId: desk.app },
      reviewed: { version: 1 },
    });
    const run = await builder.api.workflows.start(id, "asking");
    await finished(run.id);
    const ended = await builder.api.workflows.status(run.id);
    const receipts = async () => {
      const row = await env.DB.prepare(
        "SELECT count(*) AS count FROM workflow_start_receipts WHERE invoker_type = 'app' AND invoker_id = ?"
      )
        .bind(crm.app)
        .first<{ count: number }>();
      return row?.count;
    };
    const fromRun = await receipts();
    // From a screen, the same chain starts the CRM's follow-up.
    const asker = appIdSchema.parse(id);
    const fromScreen = await call(
      { ...admin, userId: builder.userId, role: "builder", teams: [] },
      { ...crm, app: asker, release: await loadRelease(env, asker, 1) },
      "asker.go"
    );
    expect({
      ran: valueOf(ended.output),
      fromRun,
      fromScreen,
      afterScreen: await receipts(),
    }).toStrictEqual({
      ran: '"error:resource.unavailable"',
      fromRun: 0,
      fromScreen: "started",
      afterScreen: 1,
    });
  });

  it("commits nothing in the App a run calls once the run's step lets go of its lease", async () => {
    const admin = await person("admin");
    const crm = await sealedApp(crmFiles(), "CRM");
    const desk = await sealedApp(deskFiles(), "Desk");
    await bind(admin, desk, crm.app);
    const lease = { holds: true };
    let reads = 0;
    // A run of Desk's, as its engine keeps it, still going.
    const runId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO workflow_runs (id, app_id, workflow_id, version, started_by, status, created_at, ended_at) VALUES (?, ?, 'noter', 1, ?, 'running', ?, NULL)"
    )
      .bind(runId, desk.app, admin.userId, Date.now())
      .run();
    const caller: RunCaller = {
      run: {
        app: appIdSchema.parse(desk.app),
        workflow: workflowIdSchema.parse("noter"),
        runId: runIdSchema.parse(runId),
        version: 1,
        shareSubject: admin.userId,
        authority: {
          subject: { type: "app", appId: appIdSchema.parse(desk.app) },
          onBehalfOf: admin.userId,
          mode: "workflow",
          appVersion: 1,
        },
      },
      requestId: crypto.randomUUID(),
      deadline: Date.now() + 30_000,
      // The step's lease is let go of as the CRM's function is admitted,
      // after Desk's own gate read: only the commit's check sees it.
      stillCurrent: async () => {
        reads += 1;
        if (reads === 3) {
          lease.holds = false;
        }
        await Promise.resolve();
      },
      requireHolds: () => {
        if (!lease.holds) {
          throw executionErrors.create("execution.stale_attempt");
        }
      },
      held: () => {
        throw new Error("Nothing is held here");
      },
    };
    const answered = await callRunFunction(
      env,
      caller,
      { contractId: "desk.add", kind: "action" },
      { text: "stale" },
      `step:${crypto.randomUUID()}`
    );
    expect({
      answered: answered.ok ? answered.value : answered.error.code,
      crmSees: await call(admin, crm, "notes.mine"),
    }).toStrictEqual({
      answered: "error:execution.stale_attempt",
      crmSees: [],
    });
  });

  it("changes the other App once however often its step runs again", async () => {
    const builder = await signedInApi(idp, "builder");
    const admin = await person("admin");
    const crm = await sealedApp(crmFiles(), "CRM");
    await addMember(env, crm.owner, crm.app, {
      type: "person",
      id: builder.userId,
      role: "user",
    });
    const reference = JSON.stringify({
      contractId: "desk.add",
      kind: "action",
    });
    const { id } = await builder.api.apps.create({ name: "Retrying desk" });
    await release(builder, id, {
      ...deskFiles(),
      "workflows/retry.ts": `import { workflow, z } from "@grasp-os/sdk/workflow";

export default workflow("retry", { params: {}, input: z.unknown() }, async (step, { env }) =>
  await step.do("note", { description: "Note", sideEffect: true, input: null, timeout: "1 second", retries: { limit: 1, delay: "1 second" } }, async () => {
    await env.APP.callFunction(${reference}, { text: "once" });
    // Every attempt runs out of time after its call: retried once.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    return null;
  })
);
`,
      "workflows/retry.workflow-tests.ts": `import { workflowTests } from "@grasp-os/sdk/testing";

import definition from "./retry.ts";

export default workflowTests(definition, [{ name: "runs", mocks: { note: null }, expect: {} }]);
`,
    });
    await approveResourceBinding(env, admin, {
      app: id,
      alias: "crm",
      target: { kind: "app", appId: crm.app },
      reviewed: { version: 1 },
    });
    const run = await builder.api.workflows.start(id, "retry");
    await finished(run.id);
    const ended = await builder.api.workflows.status(run.id);
    expect({
      status: ended.status,
      // Two attempts called, under the step's key: one note.
      notes: await call(
        { ...admin, userId: builder.userId, role: "builder", teams: [] },
        crm,
        "notes.mine"
      ),
      calls: callsTo(await allEvents(), crm.app).filter(
        ({ onBehalfOf }) => onBehalfOf === builder.userId
      ).length,
    }).toStrictEqual({ status: "failed", notes: ["once"], calls: 2 });
  });

  it("calls as the person the run acts for, audited as the run", async () => {
    const builder = await signedInApi(idp, "builder");
    const admin = await person("admin");
    const crm = await sealedApp(crmFiles(), "CRM");
    await addMember(env, crm.owner, crm.app, {
      type: "person",
      id: builder.userId,
      role: "user",
    });
    const reference = JSON.stringify({
      contractId: "desk.add",
      kind: "action",
    });
    const { id } = await builder.api.apps.create({ name: "Run desk" });
    await release(builder, id, {
      ...deskFiles(),
      "workflows/noter.ts": `import { type Json, workflow, z } from "@grasp-os/sdk/workflow";

export default workflow("noter", { params: {}, input: z.unknown() }, async (step, { env }) =>
  await step.do("note", { description: "Note", sideEffect: true, input: null, retries: { limit: 0 } }, async () =>
    (await env.APP.callFunction(${reference}, { text: "from the run" })) as Json
  )
);
`,
      "workflows/noter.workflow-tests.ts": `import { workflowTests } from "@grasp-os/sdk/testing";

import definition from "./noter.ts";

export default workflowTests(definition, [{ name: "runs", mocks: { note: null }, expect: {} }]);
`,
    });
    await approveResourceBinding(env, admin, {
      app: id,
      alias: "crm",
      target: { kind: "app", appId: crm.app },
      reviewed: { version: 1 },
    });
    const run = await builder.api.workflows.start(id, "noter");
    await finished(run.id);
    const ended = await builder.api.workflows.status(run.id);
    const asBuilder = {
      userId: builder.userId,
      role: "builder" as const,
      teams: [],
    };
    expect({
      status: ended.status,
      output: ended.output,
      builderReads: await call({ ...admin, ...asBuilder }, crm, "notes.mine"),
      audited: callsTo(await allEvents(), crm.app),
    }).toStrictEqual({
      status: "completed",
      output: { ok: true, value: "null" },
      builderReads: ["from the run"],
      audited: [
        {
          actor: {
            type: "workflow",
            appId: id,
            workflowId: "noter",
            runId: run.id,
          },
          function: "notes.add",
          onBehalfOf: builder.userId,
        },
      ],
    });
  });
});
