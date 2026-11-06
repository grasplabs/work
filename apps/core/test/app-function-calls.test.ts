import type { AuditEvent } from "@grasp-os/shared/audit";
import {
  appIdSchema,
  chatIdSchema,
  workspaceIdSchema,
} from "@grasp-os/shared/ids";
import type { Authority } from "@grasp-os/shared/permissions";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { actionInvocation, invocationName } from "../src/action-invocation.ts";
import { callAppFunction, readFunctionRequest } from "../src/app-functions.ts";
import { addMember } from "../src/app-members.ts";
import type { Release } from "../src/app-releases.ts";
import { loadRelease } from "../src/app-releases.ts";
import { appFor, commitFiles, setCurrentVersion } from "../src/apps.ts";
import { requireResourceRole } from "../src/permission-resources.ts";
import { grantPermission, requestPermission } from "../src/permissions.ts";
import {
  approveResourceBinding,
  reviewResourceBindings,
  revokeResourceBinding,
} from "../src/resource-bindings.ts";
import { isRestricted, restrict } from "../src/restricted.ts";
import { appDefinition } from "./app-definitions.ts";
import { published, release } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { fakeProvider } from "./model-provider.ts";
import { leave } from "./runs.ts";
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
// crossing unmarked; and calls nobody can trace. Gone with App workflows,
// whose runs called other Apps through `env.APP.callFunction`: a run's
// calls starting no workflow of the App called, committing nothing once
// its step let go of its lease, and calling as the person the run acts
// for. Whether a JSON run calls App functions, and so needs these, is
// GRA-1586.

const idp = mockIdp();

/** The CRM: notes each person keeps, and a function only it calls. */
const crmFiles = (
  mineReturns = "v.array(v.string())",
  // What `mine` answers, as its contract (`mineReturns`) types it.
  mineAnswer = '(await ctx.db.query("notes").take(100)).map(({ text }) => text)'
) => ({
  ...appDefinition({
    name: "CRM",
    tables: {
      notes: {
        fields: { text: "v.string()" },
        access: { read: "owner", write: "owner" },
      },
    },
    permissions: [
      'permission.workflow("followUp", {\n  input: v.object({ who: v.string() }),\n  output: v.object({ status: v.string() }),\n})',
    ],
  }),
  "server/notes.ts": `import { v } from "@grasp-os/sdk";
import { action, internalQuery, mutation, query } from "@server/_generated/server";
import { permissions } from "../grasp.config.ts";

export const followUp = permissions.followUp;

/** Starts the CRM's follow-up: what the start answered, or why it refused. */
export const kick = action({
  args: {},
  returns: v.string(),
  uses: [followUp],
  handler: async (ctx) => {
    try {
      await ctx.workflows.followUp.start({ who: "Ada" });
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
    await ctx.afterCommit.workflows.followUp.start({ who: "Ada" });
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
/** The CRM's functions the Desk declares it calls. */
const crmFunctions = [
  '"notes.add": { kind: "mutation", args: { text: v.string() }, returns: v.null() }',
  '"notes.mine": { kind: "query", args: {}, returns: v.array(v.string()) }',
  '"notes.shout": { kind: "action", args: { text: v.string() }, returns: v.string() }',
  '"notes.kick": { kind: "action", args: {}, returns: v.string() }',
  '"notes.kickLater": { kind: "mutation", args: {}, returns: v.null() }',
  '"notes.later": { kind: "action", args: { text: v.string() }, returns: v.null() }',
];

const deskFiles = (
  extra = "",
  functions: readonly string[] = crmFunctions
): Record<string, string> => ({
  ...appDefinition({
    name: "Desk",
    permissions: [
      `permission.app("crm", { functions: { ${functions.join(", ")} } })`,
    ],
  }),
  "server/desk.ts": `import { v } from "@grasp-os/sdk";
import { action } from "@server/_generated/server";
import { permissions } from "../grasp.config.ts";

export const crm = permissions.crm;

${attempt}

export const add = action({
  args: { text: v.string() },
  returns: v.string(),
  uses: [crm],
  handler: async (ctx, args) => await attempt(() => ctx.apps.crm.call("notes.add", { text: args.text })),
});

export const mine = action({
  args: {},
  returns: v.string(),
  uses: [crm],
  handler: async (ctx) => await attempt(() => ctx.apps.crm.call("notes.mine", {})),
});

export const shout = action({
  args: { text: v.string() },
  returns: v.string(),
  uses: [crm],
  handler: async (ctx, args) => await attempt(() => ctx.apps.crm.call("notes.shout", { text: args.text })),
});

export const kick = action({
  args: {},
  returns: v.string(),
  uses: [crm],
  handler: async (ctx) => await attempt(() => ctx.apps.crm.call("notes.kick", {})),
});

export const kickLater = action({
  args: {},
  returns: v.string(),
  uses: [crm],
  handler: async (ctx) => await attempt(() => ctx.apps.crm.call("notes.kickLater", {})),
});

export const later = action({
  args: { text: v.string() },
  returns: v.string(),
  uses: [crm],
  handler: async (ctx, args) => await attempt(() => ctx.apps.crm.call("notes.later", { text: args.text })),
});
${extra}`,
});

/** A relay: `relay.go` calls the next App's `relay.go`, and says how far it got. */
const relayFiles: Record<string, string> = {
  ...appDefinition({
    name: "Relay",
    tables: {},
    permissions: [
      'permission.app("next", {\n  functions: { "relay.go": { kind: "action", args: {}, returns: v.string() } },\n})',
    ],
  }),
  "server/relay.ts": `import { v } from "@grasp-os/sdk";
import { action } from "@server/_generated/server";
import { permissions } from "../grasp.config.ts";

export const next = permissions.next;

export const go = action({
  args: {},
  returns: v.string(),
  uses: [next],
  handler: async (ctx) => {
    try {
      return "+" + (await ctx.apps.next.call("relay.go", {}));
    } catch (error) {
      const details = Object(Reflect.get(Object(error), "details"));
      return "+error:" + String(Reflect.get(Object(error), "code")) + ":" + String(Reflect.get(details, "limit"));
    }
  },
});
`,
};

/**
 * A fan: `fan.go` with depth 0 answers "1"; deeper, it calls the next
 * App's `fan.go` `width` times, one depth less, and answers how many
 * leaves answered, and the first refusal it met.
 */
const fanFiles: Record<string, string> = {
  ...appDefinition({
    name: "Fan",
    tables: {},
    permissions: [
      'permission.app("next", {\n  functions: {\n    "fan.go": { kind: "action", args: { width: v.number(), depth: v.number() }, returns: v.string() },\n  },\n})',
    ],
  }),
  "server/fan.ts": `import { v } from "@grasp-os/sdk";
import { action } from "@server/_generated/server";
import { permissions } from "../grasp.config.ts";

export const next = permissions.next;

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
        const answer = await ctx.apps.next.call("fan.go", { width: args.width, depth: args.depth - 1 });
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
};

/** The Inviter: one action that invites a guest through its `guests`. */
const inviterFiles: Record<string, string> = {
  ...appDefinition({
    name: "Inviter",
    tables: {},
    permissions: ['permission.guests({ operations: ["invite"] })'],
  }),
  "server/inviter.ts": `import { v } from "@grasp-os/sdk";
import { action } from "@server/_generated/server";
import { permissions } from "../grasp.config.ts";

export const guests = permissions.guests;

export const invite = action({
  args: {},
  returns: v.string(),
  uses: [guests],
  handler: async (ctx) => {
    try {
      const chat = await ctx.guests.invite({ name: "Anna", skill: "interview-a-stakeholder" });
      return chat.link.length > 0 ? "invited" : "no link";
    } catch (error) {
      return "error:" + String(Reflect.get(Object(error), "code"));
    }
  },
});
`,
};

/**
 * An App that calls another's `name.fn` action (no arguments, a string
 * back) through its `next`, from `asker.go`, answering what it got.
 */
const askerFiles = (fn: string): Record<string, string> => ({
  ...appDefinition({
    name: "Asker",
    tables: {},
    permissions: [
      `permission.app("next", {
  functions: { "${fn}": { kind: "action", args: {}, returns: v.string() } },
})`,
    ],
  }),
  "server/asker.ts": `import { v } from "@grasp-os/sdk";
import { action } from "@server/_generated/server";
import { permissions } from "../grasp.config.ts";

export const next = permissions.next;

export const go = action({
  args: {},
  returns: v.string(),
  uses: [next],
  handler: async (ctx) => {
    try {
      return await ctx.apps.next.call("${fn}", {});
    } catch (error) {
      return "refused:" + String(Reflect.get(Object(error), "code"));
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

/** What `by` gets calling `path` of `sealed`'s current release, as a page calls it. */
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
      reference: { name: path, kind: operation?.kind ?? "query" },
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
 * page sends it, under an idempotency key: through its action
 * invocation object (action-invocation.ts), not `callAppFunction`. Its
 * object's name, and what it answers.
 */
const startPageAction = async (
  by: Person,
  sealed: Sealed,
  path: string,
  input: unknown
): Promise<{ name: string; result: Promise<unknown> }> => {
  const key = crypto.randomUUID();
  const request = readFunctionRequest(
    JSON.stringify({
      reference: { name: path, kind: "action" },
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

/** What `by` gets running the action `path` of `sealed` as a page sends it. */
const pageAction = async (
  by: Person,
  sealed: Sealed,
  path: string,
  input: unknown
): Promise<unknown> => {
  const { result } = await startPageAction(by, sealed, path, input);
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

  it("reach them from a page's keyed action, as the browser sends it", async () => {
    const admin = await person("admin");
    const crm = await sealedApp(crmFiles(), "CRM");
    const desk = await sealedApp(deskFiles(), "Desk");
    await bind(admin, desk, crm.app);
    await expect(
      pageAction(admin, desk, "desk.shout", { text: "hi" })
      // Desk's answer: the CRM's, as JSON.
    ).resolves.toStrictEqual({ ok: true, value: '"HI"' });
  });

  it("stop calling another App once the person cancels the page's action", async () => {
    const admin = await person("admin");
    const crm = await sealedApp(crmFiles(), "CRM");
    const desk = await sealedApp(deskFiles(), "Desk");
    await bind(admin, desk, crm.app);
    // The CRM's action waits before it keeps its note; the person cancels
    // Desk's action meanwhile.
    const { name, result } = await startPageAction(admin, desk, "desk.later", {
      text: "after the cancel",
    });
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
      deskFiles("", [
        ...crmFunctions,
        '"notes.hidden": { kind: "query", args: {}, returns: v.number() }',
      ]),
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
    await callAppFunction(
      env,
      admin,
      first.app,
      JSON.stringify({
        reference: { name: "relay.go", kind: "action" },
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

  it("never invite a guest through another App from a page's call", async () => {
    // The company connected an AI provider: a guest chat needs a model.
    await fakeProvider();
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
    // The Asker calls the Inviter's invite, from a page.
    const { id } = await builder.api.apps.create({ name: "Asker" });
    await published(id);
    await release(builder, id, askerFiles("inviter.invite"));
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
    const fromPage = await call(asBuilder, askerSealed, "asker.go");
    expect({
      // The person's own call invites.
      direct,
      fromPage,
    }).toStrictEqual({
      direct: "invited",
      fromPage: "error:resource.not_allowed",
    });
  });
});
