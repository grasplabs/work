import { peopleReferences } from "@grasp-os/sdk/host";
import { appVisitorApiPath } from "@grasp-os/shared/app-visitors";
import { errorPayloadSchema } from "@grasp-os/shared/errors";
import { appIdSchema, chatIdSchema } from "@grasp-os/shared/ids";
import {
  appFunctionPath,
  pageLeaseHeader,
  pageLimits,
  pageVisitorHeader,
} from "@grasp-os/shared/pages";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { visitorInvocation } from "../src/app-functions.ts";
import { loadRelease } from "../src/app-releases.ts";
import { deliveredToVisitor } from "../src/app-visitors.ts";
import { appHost } from "../src/durable-objects.ts";
import { onboardingStore } from "../src/onboarding/store.ts";
import { leasedBuild, leaseFor } from "../src/page-delivery.ts";
import { revokeRelease } from "../src/release-retention.ts";
import { appDefinition } from "./app-definitions.ts";
import { published } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { captureMail } from "./mail-capture.ts";
import type { CapturedMail } from "./mail-capture.ts";
import { person as actingPerson } from "./sealed-apps.ts";
import { clientOrigin } from "./sign-in-config.ts";
import {
  auditedDuring,
  openRpc,
  outcome,
  routed,
  signedIn,
  signedInApi,
  staffPerson,
  unique,
} from "./sign-in.ts";

// A visitor's calls of a published App's functions, as the App itself
// (app-visitor-grants.ts, through page-calls.ts), from its threat model: calling what wasn't
// granted, or an action; reaching a member's data, or another visitor's;
// escalating through a workflow or a resource; keeping a grant after it
// was taken away, by fewer grants, a new version or unpublishing;
// spending past the visitor's or the App's limit; grants set by someone
// who doesn't build the App; and any of it unaudited.

const idp = mockIdp();

type Person = Awaited<ReturnType<typeof signedInApi>>;

/**
 * The Portal App: notes each caller keeps for themselves (`owner`),
 * members' secrets (`appMembers`), a mutation that starts a workflow after
 * it commits, and an action.
 */
const portalFiles = (marker = "1"): Record<string, string> => ({
  ...appDefinition({
    name: "Portal",
    tables: {
      notes: {
        fields: { text: "v.string()" },
        access: { read: "owner", write: "owner" },
      },
      secrets: {
        fields: { text: "v.string()" },
        access: { read: "appMembers", write: "appMembers" },
      },
    },
    permissions: [
      'permission.workflow("followUp", {\n  input: v.object({ who: v.string() }),\n  output: v.object({ status: v.string() }),\n})',
    ],
  }),
  "server/portal.ts": `import { v } from "@grasp-os/sdk";
import { action, mutation, query } from "@server/_generated/server";
import { permissions } from "../grasp.config.ts";

export const followUp = permissions.followUp;

export const add = mutation({
  args: { text: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("notes", { text: args.text });
    return null;
  },
});

export const mine = query({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => (await ctx.db.query("notes").take(100)).map(({ text }) => text),
});

export const keep = mutation({
  args: { text: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("secrets", { text: args.text });
    return null;
  },
});

export const secrets = query({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => (await ctx.db.query("secrets").take(100)).map(({ text }) => text),
});

/** Keeps a note, then starts the follow-up once it commits. */
export const kick = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await ctx.db.insert("notes", { text: "kicked" });
    await ctx.afterCommit.workflows.followUp.start({ who: "Ada" });
    return null;
  },
});

/** Who calls, as the function sees it. */
export const who = query({
  args: {},
  returns: v.string(),
  handler: async (ctx) => JSON.stringify(await ctx.auth.getUser()),
});

/** A search of the organization's people, or the code it was refused with. */
export const look = query({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    try {
      return JSON.stringify(await ctx.people.search("a"));
    } catch (error) {
      return String(Reflect.get(Object(error), "code"));
    }
  },
});

export const shout = action({
  args: { text: v.string() },
  returns: v.string(),
  handler: async (_ctx, args) => args.text.toUpperCase() + "${marker}",
});
`,

  "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";
function Portal() {
  return <p>Portal</p>;
}

export const Route = createFileRoute("/")({ component: Portal });
`,
});

/** 50 more queries' names, as long as names get. */
const manyNames = Array.from(
  { length: 50 },
  (_, index) =>
    `notesKeptForTheVisitorsOfThisPortalNumber${String(index).padStart(2, "0")}`
);

/** Their paths. */
const manyPaths = manyNames.map((name) => `portal.${name}`);

/** The Portal App with the 50 queries of `manyNames` beside its own. */
const manyFiles = (): Record<string, string> => {
  const files = portalFiles();
  const queries = manyNames
    .map(
      (name) => `
export const ${name} = query({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => (await ctx.db.query("notes").take(1)).map(({ text }) => text),
});
`
    )
    .join("");
  return {
    ...files,
    "server/portal.ts": `${files["server/portal.ts"] ?? ""}${queries}`,
  };
};

/** Commits `files` as the App's current version. */
const released = async (
  builder: Person,
  app: string,
  files: Record<string, string>
): Promise<number> => {
  const { version } = await builder.api.apps.files.commit(app, files, "Next");
  await builder.api.apps.versions.setCurrent(app, version);
  return version;
};

/** A published Portal at its own link, visited by anyone at `domain`. */
const portal = async (domain: string) => {
  const builder = await signedInApi(idp, "builder");
  const { id } = await builder.api.apps.create({ name: "Portal" });
  const link = `portal-${unique()}`;
  await builder.api.apps.setLink(id, link);
  await builder.api.apps.setVisitors(id, [{ kind: "domain", value: domain }]);
  const version = await released(builder, id, portalFiles());
  await published(id);
  return { builder, app: id, link, version };
};

/** Posts a visitor's request, as their page does. */
const post = async (body: unknown): Promise<Response> =>
  await routed(appVisitorApiPath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** A mail's one recipient, as an address. */
const toOf = (message: EmailMessageBuilder): string => {
  const [to] = [message.to].flat();
  return typeof to === "string" ? to : (to?.email ?? "");
};

const visitSchema = z.object({
  app: z.string(),
  page: z.object({ lease: z.string() }).loose().nullable(),
});

const sessionSchema = z.object({ token: z.string() });

/** A visitor signed in, as their page holds them. */
interface Visitor {
  token: string;
  lease: string;
  /** The App their session opens. */
  app: string;
}

/**
 * Signs `address` in as a visitor of the App at `link`, mailed a code at
 * `mail`, and opens the App: their session's token and their page's lease.
 */
const visitor = async (
  mail: CapturedMail,
  link: string,
  address: string
): Promise<Visitor> => {
  await post({ action: "ask", link, address });
  const code = await vi.waitFor(() => {
    const message = mail.sent.findLast((each) => toOf(each) === address);
    const found = /(?<code>\d{4} \d{4})/u.exec(message?.text ?? "")?.groups
      ?.code;
    if (found === undefined) {
      throw new Error(`No code went to ${address}`);
    }
    return found.replace(" ", "");
  });
  const signedInAs = await post({ action: "sign_in", link, address, code });
  const { token } = sessionSchema.parse(await signedInAs.json());
  const opened = await post({ action: "open", token });
  const { app, page } = visitSchema.parse(await opened.json());
  return { token, lease: page?.lease ?? "", app };
};

const answerSchema = z.object({
  result: z.union([
    z.object({ ok: z.literal(true), value: z.unknown() }),
    z.object({ ok: z.literal(false), error: z.object({ code: z.string() }) }),
  ]),
});

/**
 * A visitor's page's call, `request`, of `app` (theirs unless said): on
 * every page's call path (page-calls.ts), their session's token in its
 * header, their lease in its own.
 */
const postCall = async (
  who: Pick<Visitor, "token" | "lease" | "app">,
  request: string,
  app = who.app
): Promise<Response> =>
  await routed(`${appFunctionPath}/${app}`, {
    method: "POST",
    headers: {
      origin: clientOrigin,
      "content-type": "application/json",
      [pageVisitorHeader]: who.token,
      [pageLeaseHeader]: who.lease,
    },
    body: request,
  });

/** What a call answered: its value, or the code it was refused with. */
const answered = async (response: Response): Promise<unknown> => {
  if (!response.ok) {
    return errorPayloadSchema.parse(await response.json()).code;
  }
  const { result } = answerSchema.parse(await response.json());
  return result.ok ? result.value : result.error.code;
};

/**
 * What a visitor's call of `path` answers: its value, or the code it was
 * refused with, at the HTTP level or in the result.
 */
const call = async (
  app: string,
  version: number,
  who: Visitor,
  path: string,
  input: unknown = {}
): Promise<unknown> => {
  const release = await loadRelease(env, appIdSchema.parse(app), version);
  const request = JSON.stringify({
    reference: {
      name: path,
      kind: release.app.operations[path]?.kind ?? "query",
    },
    input,
  });
  return await answered(await postCall(who, request, app));
};

/**
 * What a visitor's page reads through `useUser` or `usePeople`
 * (`reference`) answers: its value, or the code it was refused with.
 */
const read = async (
  who: Visitor,
  reference: (typeof peopleReferences)[keyof typeof peopleReferences],
  input: unknown
): Promise<unknown> =>
  await answered(
    await postCall(
      who,
      JSON.stringify({
        reference: { name: reference.name, kind: "query" },
        input,
      })
    )
  );

/** A call of `portal.add` with `text`, as a visitor's page writes it. */
const add = (text: string): string =>
  JSON.stringify({
    reference: { name: "portal.add", kind: "mutation" },
    input: { text },
  });

/** A visitor caller a function answered as JSON text, its session left out. */
const visitorCallerOf = (answer: unknown): unknown => {
  const parsed: unknown =
    typeof answer === "string" && answer.startsWith("{")
      ? JSON.parse(answer)
      : answer;
  if (typeof parsed !== "object" || parsed === null) {
    return parsed;
  }
  const caller = z
    .strictObject({
      id: z.string(),
      name: z.string(),
      email: z.string(),
      roles: z.array(z.string()),
    })
    .parse(parsed);
  return { ...caller, id: caller.id.replace(/:.*$/u, ":") };
};

/** The visitor's ID a function or page was told, or null. */
const visitorIdOf = (answer: unknown): string | null => {
  const parsed: unknown =
    typeof answer === "string" && answer.startsWith("{")
      ? JSON.parse(answer)
      : answer;
  const found = z.object({ id: z.string() }).safeParse(parsed);
  return found.success ? found.data.id : null;
};

/** Whether a call was refused, by any code, or answered. */
const refusal = (answer: unknown): string =>
  typeof answer === "string" ? "refused" : "answered";

/** A domain no other test has. */
const newDomain = (): string => `visitors-${unique()}.test`;

/** Captures what core mails from now on. */
const mailbox = async (): Promise<CapturedMail> =>
  await captureMail(onboardingStore(env));

describe("a visitor's calls", { timeout: 180_000 }, () => {
  it("run only the functions the App's version grants, and never an action", async () => {
    const domain = newDomain();
    const { builder, app, link, version } = await portal(domain);
    const mail = await mailbox();
    const ana = await visitor(mail, link, `ana@${domain}`);

    const beforeAny = await call(app, version, ana, "portal.mine");
    const granted = await builder.api.apps.setVisitorGrants(app, [
      "portal.add",
      "portal.mine",
    ]);
    const added = await call(app, version, ana, "portal.add", { text: "hi" });
    const mine = await call(app, version, ana, "portal.mine");
    const notGranted = await call(app, version, ana, "portal.secrets");
    const action = await call(app, version, ana, "portal.shout", {
      text: "x",
    });
    const grantAction = await outcome(
      builder.api.apps.setVisitorGrants(app, ["portal.shout"])
    );
    const grantNothing = await outcome(
      builder.api.apps.setVisitorGrants(app, ["portal.nope"])
    );

    expect({
      beforeAny,
      granted,
      added,
      mine,
      notGranted,
      action,
      grantAction,
      grantNothing,
    }).toStrictEqual({
      // A version starts granting nothing.
      beforeAny: "visitor.not_granted",
      granted: { version, functions: ["portal.add", "portal.mine"] },
      added: null,
      mine: ["hi"],
      notGranted: "visitor.not_granted",
      action: "visitor.not_granted",
      grantAction: "visitor.invalid",
      grantNothing: "visitor.invalid",
    });
  });

  it("reach no member's data, and no other visitor's: members' tables refuse them, and owner rows are each visitor's own", async () => {
    const domain = newDomain();
    const { builder, app, link, version } = await portal(domain);
    const mail = await mailbox();
    await builder.api.apps.setVisitorGrants(app, [
      "portal.add",
      "portal.mine",
      "portal.secrets",
      "portal.keep",
    ]);
    const [ana, ben] = [
      await visitor(mail, link, `ana@${domain}`),
      await visitor(mail, link, `ben@${domain}`),
    ];

    await call(app, version, ana, "portal.add", { text: "ana's" });
    expect({
      anaSees: await call(app, version, ana, "portal.mine"),
      benSees: await call(app, version, ben, "portal.mine"),
      // A members' table: refused to read, and to write.
      secrets: refusal(await call(app, version, ana, "portal.secrets")),
      keep: refusal(
        await call(app, version, ana, "portal.keep", { text: "x" })
      ),
    }).toStrictEqual({
      anaSees: ["ana's"],
      benSees: [],
      secrets: "refused",
      keep: "refused",
    });
  });

  it("are told who they are, and refused the organization's people, from the server and the page, each refusal audited", async () => {
    const domain = newDomain();
    const { builder, app, link, version } = await portal(domain);
    const mail = await mailbox();
    await builder.api.apps.setVisitorGrants(app, ["portal.who", "portal.look"]);
    const ana = await visitor(mail, link, `ana@${domain}`);

    let server: unknown;
    let looked: unknown;
    let page: { caller: unknown; search: unknown } | undefined;
    const events = await auditedDuring(async () => {
      server = await call(app, version, ana, "portal.who");
      looked = await call(app, version, ana, "portal.look");
      page = {
        caller: await read(ana, peopleReferences.user, {}),
        search: await read(ana, peopleReferences.search, { query: "a" }),
      };
    });
    expect({
      server: visitorCallerOf(server),
      looked,
      page: page && {
        caller: visitorCallerOf(page.caller),
        search: page.search,
      },
      sameVisitor:
        visitorIdOf(server) !== null &&
        visitorIdOf(server) === visitorIdOf(page?.caller),
      refused: events
        .filter(({ action }) => action === "app.visitor_refused")
        .map(({ detail }) => detail),
    }).toStrictEqual({
      server: {
        id: "visitor:",
        name: `ana@${domain}`,
        email: `ana@${domain}`,
        roles: [],
      },
      looked: "visitor.not_granted",
      sameVisitor: true,
      page: {
        caller: {
          id: "visitor:",
          name: `ana@${domain}`,
          email: `ana@${domain}`,
          roles: [],
        },
        search: "visitor.not_granted",
      },
      refused: [
        expect.objectContaining({ function: "people.search" }),
        expect.objectContaining({ function: "people.search" }),
      ],
    });
  });

  it("escalate through nothing: a function that starts a workflow commits nothing, and the call holds no resource at all", async () => {
    const domain = newDomain();
    const { builder, app, link, version } = await portal(domain);
    const mail = await mailbox();
    await builder.api.apps.setVisitorGrants(app, [
      "portal.kick",
      "portal.mine",
    ]);
    const ana = await visitor(mail, link, `ana@${domain}`);

    const kicked = await call(app, version, ana, "portal.kick");
    const notes = await call(app, version, ana, "portal.mine");
    const invocation = await visitorInvocation(
      env,
      await loadRelease(env, appIdSchema.parse(app), version),
      {
        app: appIdSchema.parse(app),
        version,
        principal: "visitor:test",
        email: "test@example.test",
        actor: { type: "visitor", appId: appIdSchema.parse(app) },
        stillAllowed: async () => {
          await Promise.resolve();
        },
        notGranted: async () => {
          await Promise.resolve();
          throw new Error("Not granted");
        },
        admitted: async () => {
          await Promise.resolve();
        },
      },
      "portal.mine",
      crypto.randomUUID(),
      Date.now() + 1000
    );

    expect({
      kicked: typeof kicked === "string" ? kicked : "ran",
      notes,
      bound: {
        resources: invocation.resources,
        workflows: invocation.workflows,
        notifications: invocation.notifications,
      },
      roles: await invocation.authorize(),
    }).toStrictEqual({
      kicked: "resource.unavailable",
      // Its note never committed.
      notes: [],
      bound: {
        resources: undefined,
        workflows: undefined,
        notifications: undefined,
      },
      roles: { appMember: false, appBuilder: false },
    });
  });

  it("keep no grant once it is taken away: fewer grants, another version, the list or unpublishing", async () => {
    const domain = newDomain();
    const { builder, app, link, version } = await portal(domain);
    const mail = await mailbox();
    await builder.api.apps.setVisitorGrants(app, ["portal.mine"]);
    const ana = await visitor(mail, link, `ana@${domain}`);

    const granted = await call(app, version, ana, "portal.mine");
    await builder.api.apps.setVisitorGrants(app, []);
    const withdrawn = await call(app, version, ana, "portal.mine");
    await builder.api.apps.setVisitorGrants(app, ["portal.mine"]);
    const next = await released(builder, app, portalFiles("2"));
    // The new version grants nothing until granted again.
    const newVersion = await call(app, next, ana, "portal.mine");
    await builder.api.apps.setVisitorGrants(app, ["portal.mine"]);
    const regranted = await call(app, next, ana, "portal.mine");
    await builder.api.apps.setVisitors(app, []);
    const delisted = await call(app, next, ana, "portal.mine");
    await builder.api.apps.setVisitors(app, [
      { kind: "domain", value: domain },
    ]);
    const ben = await visitor(mail, link, `ben@${domain}`);
    await builder.api.apps.unpublish(app);
    const sessions = await env.DB.prepare(
      "SELECT count(*) AS left FROM app_visitor_sessions WHERE app_id = ?"
    )
      .bind(app)
      .first();
    const unpublished = await call(app, next, ben, "portal.mine");

    expect({
      granted,
      withdrawn,
      newVersion,
      regranted,
      delisted,
      sessions,
      unpublished,
    }).toStrictEqual({
      granted: [],
      withdrawn: "visitor.not_granted",
      newVersion: "visitor.not_granted",
      regranted: [],
      delisted: "visitor.signed_out",
      // Unpublishing ends every visitor's session.
      sessions: { left: 0 },
      unpublished: "visitor.signed_out",
    });
  });

  it("are limited per visitor and per App before anything runs", async () => {
    const domain = newDomain();
    const { builder, app, link, version } = await portal(domain);
    const mail = await mailbox();
    await builder.api.apps.setVisitorGrants(app, ["portal.mine"]);
    const ana = await visitor(mail, link, `ana@${domain}`);
    const ben = await visitor(mail, link, `ben@${domain}`);
    const host = appHost(env, appIdSchema.parse(app));
    const { burst } = pageLimits.requests;
    const session = async (token: string) =>
      await env.DB.prepare(
        "SELECT id FROM app_visitor_sessions WHERE app_id = ? ORDER BY created_at"
      )
        .bind(app)
        .all<{ id: string }>()
        .then(({ results }) => results.map(({ id }) => id))
        .then((ids) => (token === ana.token ? ids[0] : ids[1]));

    // Ana's own budget spent: she is refused, Ben is not.
    const anaId = await session(ana.token);
    await host.admitRequest(`visitor:${anaId ?? ""}`, burst);
    const anaSpent = await call(app, version, ana, "portal.mine");
    const benStill = await call(app, version, ben, "portal.mine");
    // Every visitor's budget spent: Ben is refused too.
    // Ben's one call is all that came out of it so far.
    await host.admitRequest("visitors", burst - 1);
    const appSpent = await call(app, version, ben, "portal.mine");

    expect({ anaSpent, benStill, appSpent }).toStrictEqual({
      anaSpent: "visitor.too_many",
      benStill: [],
      appSpent: "visitor.too_many",
    });
  });

  it("are audited as the visitor with the function and version, refusals too, and grants as the builder", async () => {
    const domain = newDomain();
    const { builder, app, link, version } = await portal(domain);
    const mail = await mailbox();
    const ana = await visitor(mail, link, `ana@${domain}`);

    const events = await auditedDuring(async () => {
      await builder.api.apps.setVisitorGrants(app, ["portal.mine"]);
      await call(app, version, ana, "portal.mine");
      await call(app, version, ana, "portal.secrets");
    });

    expect(
      events
        .filter(
          (event) =>
            event.target?.id === app &&
            (event.action === "app.visitor_called" ||
              event.action === "app.visitor_granted" ||
              (event.action === "app.visitor_refused" &&
                JSON.stringify(event.detail).includes("not_granted")))
        )
        .map(({ action, actor, detail }) => ({
          action,
          actor: actor.type,
          detail,
        }))
    ).toStrictEqual([
      {
        action: "app.visitor_granted",
        actor: "person",
        detail: { version, function: "portal.mine" },
      },
      {
        action: "app.visitor_called",
        actor: "visitor",
        detail: { function: "portal.mine", version },
      },
      {
        action: "app.visitor_refused",
        actor: "visitor",
        detail: { reason: "not_granted", function: "portal.secrets", version },
      },
    ]);
  });

  it("grant 50 long-named functions, and audit every one granted and taken away in full", async () => {
    const { builder, app } = await portal(newDomain());
    const version = await released(builder, app, manyFiles());
    const kept = manyPaths.slice(0, 25);
    const taken = manyPaths.slice(25);

    let granted: unknown;
    let narrowed: unknown;
    const events = await auditedDuring(async () => {
      granted = await builder.api.apps.setVisitorGrants(app, manyPaths);
      narrowed = await builder.api.apps.setVisitorGrants(app, kept);
    });
    const changes = (action: string) =>
      events
        .filter((event) => event.action === action && event.target?.id === app)
        .map((event) => JSON.stringify(event.detail))
        .toSorted();
    const asDetails = (paths: string[]) =>
      paths
        .map((path) => JSON.stringify({ function: path, version }))
        .toSorted();

    expect({
      granted,
      narrowed,
      added: changes("app.visitor_granted"),
      removed: changes("app.visitor_ungranted"),
    }).toStrictEqual({
      granted: { version, functions: manyPaths.toSorted() },
      narrowed: { version, functions: kept.toSorted() },
      added: asDetails(manyPaths),
      removed: asDetails(taken),
    });
  });

  it("refuse a grant save that raced another, so the audit names exactly what the winner replaced", async () => {
    const { builder, app } = await portal(newDomain());
    await builder.api.apps.setVisitorGrants(app, ["portal.mine"]);
    const sets = {
      // Adds `portal.add`, keeping `portal.mine`.
      grow: ["portal.add", "portal.mine"],
      // Takes `portal.mine` away, granting `portal.secrets`.
      swap: ["portal.secrets"],
    };

    let outcomes: unknown[] = [];
    const events = await auditedDuring(async () => {
      // At once: both read the grants as they were before either saves.
      outcomes = await Promise.all([
        outcome(builder.api.apps.setVisitorGrants(app, sets.grow)),
        outcome(builder.api.apps.setVisitorGrants(app, sets.swap)),
      ]);
    });
    const winner = outcomes[0] === "visitor.grants_changed" ? "swap" : "grow";
    const expected = {
      grow: { granted: ["portal.add"], ungranted: [] },
      swap: { granted: ["portal.secrets"], ungranted: ["portal.mine"] },
    }[winner];
    const named = (action: string) =>
      events
        .filter((event) => event.action === action && event.target?.id === app)
        .map(
          ({ detail }) =>
            z.object({ function: z.string() }).parse(detail).function
        )
        .toSorted();
    const { functions } = await builder.api.apps.visitorGrants(app);

    expect({
      refused: outcomes.filter((each) => each === "visitor.grants_changed"),
      functions,
      granted: named("app.visitor_granted"),
      ungranted: named("app.visitor_ungranted"),
    }).toStrictEqual({
      refused: ["visitor.grants_changed"],
      functions: sets[winner],
      granted: expected.granted,
      ungranted: expected.ungranted,
    });
  });

  it("refuse an action and core's own queries before anything runs, each refusal audited", async () => {
    const domain = newDomain();
    const { builder, app, link, version } = await portal(domain);
    const mail = await mailbox();
    const ana = await visitor(mail, link, `ana@${domain}`);
    await builder.api.apps.setVisitorGrants(app, ["portal.mine"]);
    const refusedPaths = [
      "portal.shout",
      "workflows.followUp.queries.runs",
      "preferences.get",
    ];

    let answers: unknown[] = [];
    const events = await auditedDuring(async () => {
      answers = await Promise.all(
        refusedPaths.map(
          async (path) => await call(app, version, ana, path, { text: "x" })
        )
      );
    });

    expect({
      answers,
      audited: events
        .filter(
          (event) =>
            event.target?.id === app && event.action === "app.visitor_refused"
        )
        .map(({ detail }) =>
          z.object({ function: z.string() }).loose().parse(detail)
        )
        .toSorted((one, other) => one.function.localeCompare(other.function)),
    }).toStrictEqual({
      answers: refusedPaths.map(() => "visitor.not_granted"),
      audited: refusedPaths.toSorted().map((path) => ({
        reason: "not_granted",
        function: path,
        version,
      })),
    });
  });

  it("take a call as large as a member's page may send, past the 4 KiB the other requests get", async () => {
    const domain = newDomain();
    const { builder, app, link, version } = await portal(domain);
    const mail = await mailbox();
    const ana = await visitor(mail, link, `ana@${domain}`);
    await builder.api.apps.setVisitorGrants(app, ["portal.add", "portal.mine"]);
    // Quotes, escaped once more in the body, make it larger still.
    const text = `"${"x".repeat(6000)}"`;

    expect({
      added: await call(app, version, ana, "portal.add", { text }),
      mine: await call(app, version, ana, "portal.mine"),
    }).toStrictEqual({ added: null, mine: [text] });
  });

  it("hand over neither answer nor error once the page's release is revoked while the call runs, and audit it", async () => {
    // Each on a fresh Portal: its release is revoked inside the run, after
    // it was admitted, so only the check before handing over can refuse
    // it.
    const revokedWhile = async (ends: "answer" | "error") => {
      const domain = newDomain();
      const { app, link, version } = await portal(domain);
      const admin = await actingPerson("admin");
      const mail = await mailbox();
      const ana = await visitor(mail, link, `ana@${domain}`);
      const sessions = await env.DB.prepare(
        "SELECT id FROM app_visitor_sessions WHERE app_id = ?"
      )
        .bind(app)
        .all<{ id: string }>();
      const sessionId = sessions.results[0]?.id ?? "";
      const appId = appIdSchema.parse(app);
      const build = await leasedBuild(
        env,
        `visitor:${sessionId}`,
        appId,
        ana.lease
      );
      let ran = false;
      let refused = "";
      const events = await auditedDuring(async () => {
        refused = await outcome(
          deliveredToVisitor(
            env,
            { app: appId, sessionId, build },
            async () => {
              ran = true;
              await revokeRelease(env, admin, { app: appId, version }, "Leaks");
              if (ends === "error") {
                throw new Error("what the App read");
              }
              return "the answer";
            }
          )
        );
      });
      return {
        leased: build !== undefined,
        ran,
        refused,
        audited: events
          .filter(
            (event) =>
              event.target?.id === app && event.action === "app.visitor_refused"
          )
          .map(({ detail }) => detail),
      };
    };
    const expected = {
      leased: true,
      ran: true,
      refused: "page.revoked",
      audited: [{ reason: "page_revoked", stage: "delivery" }],
    };

    expect({
      answer: await revokedWhile("answer"),
      error: await revokedWhile("error"),
    }).toStrictEqual({ answer: expected, error: expected });
  });

  it("never reach a builder's draft, another App or a stream on the path every page calls on", async () => {
    const domain = newDomain();
    const { builder, app, link, version } = await portal(domain);
    const mail = await mailbox();
    await builder.api.apps.setVisitorGrants(app, ["portal.add", "portal.mine"]);
    const ana = await visitor(mail, link, `ana@${domain}`);
    // The builder's preview of a draft of the App, and the lease it opened
    // with; and a draft's lease signed for ana's own session, as core
    // never signs one, should a bug of its ever do so.
    const chat = await builder.api.chats.forApp(app);
    const preview = await builder.api.chats.preview(chat.id, app);
    const sessions = await env.DB.prepare(
      "SELECT id FROM app_visitor_sessions WHERE app_id = ?"
    )
      .bind(app)
      .all<{ id: string }>();
    const forHer = await leaseFor(
      env,
      `visitor:${sessions.results[0]?.id ?? ""}`,
      appIdSchema.parse(app),
      {
        kind: "draft",
        artifact: preview.artifact,
        chatId: chatIdSchema.parse(chat.id),
      }
    );
    const other = await portal(newDomain());
    const streamed = await routed(`${appFunctionPath}/${app}/stream`, {
      method: "POST",
      headers: {
        origin: clientOrigin,
        "content-type": "application/json",
        [pageVisitorHeader]: ana.token,
        [pageLeaseHeader]: ana.lease,
      },
      body: add("streamed"),
    });

    expect({
      buildersDraft: await answered(
        await postCall({ ...ana, lease: preview.lease ?? "" }, add("draft"))
      ),
      draftForHer: await answered(
        await postCall({ ...ana, lease: forHer }, add("draft"))
      ),
      anotherApp: await answered(await postCall(ana, add("other"), other.app)),
      forgedToken: await answered(
        await postCall({ ...ana, token: "a".repeat(43) }, add("forged"))
      ),
      stream: await answered(streamed),
      mine: await call(app, version, ana, "portal.mine"),
    }).toStrictEqual({
      // Signed for the builder: no lease of hers, so code core didn't serve.
      buildersDraft: "page.unreviewed",
      draftForHer: "app.preview_side_effect",
      anotherApp: "visitor.signed_out",
      forgedToken: "visitor.signed_out",
      stream: "contract.invalid_request",
      mine: [],
    });
  });

  it("are granted only by the App's builders, never staff or its users", async () => {
    const domain = newDomain();
    const { builder, app } = await portal(domain);
    const user = await signedInApi(idp, "user");
    await builder.api.apps.members.add(app, {
      type: "person",
      id: user.userId,
      role: "user",
    });
    const { core } = await openRpc(
      await signedIn(idp, "grasp-staff", staffPerson())
    );
    const staff = core.authenticate();

    await expect(
      Promise.all([
        outcome(user.api.apps.setVisitorGrants(app, ["portal.mine"])),
        outcome(user.api.apps.visitorGrants(app)),
        outcome(staff.apps.setVisitorGrants(app, ["portal.mine"])),
      ])
    ).resolves.toStrictEqual([
      "role.forbidden",
      "role.forbidden",
      expect.any(String),
    ]);
  });
});
