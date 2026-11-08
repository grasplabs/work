import { errorPayloadSchema } from "@grasp-os/shared/errors";
import { functionRequestMaxBytes } from "@grasp-os/shared/function-limits";
import { appIdSchema } from "@grasp-os/shared/ids";
import { isRecord } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import {
  appFunctionPath,
  pageLeaseHeader,
  pageLimits,
  pagePersonHeader,
} from "@grasp-os/shared/pages";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { loadRelease } from "../src/app-releases.ts";
import { revokeRelease } from "../src/release-retention.ts";
import { appDefinition } from "./app-definitions.ts";
import { published } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { chatWithDraft, previewLease } from "./previews.ts";
import { person } from "./sealed-apps.ts";
import { clientOrigin } from "./sign-in-config.ts";
import {
  outcome,
  routed,
  signedIn,
  signedInApi,
  withSignIn,
} from "./sign-in.ts";

// A page calling one of its App's functions over core's
// plain request (page-calls.ts), from the page's side: a page
// with the lease core gave its build calls through, no admin approving
// it; one with no lease of core's, one with someone else's lease, another site, someone signed out or without
// a role, a session that is someone else's than the frame's, and a body
// larger than any request may be, are refused, the last before core reads
// past its bound. Then, from the one path's threat model (page-calls.ts),
// a builder's preview of a draft on that same path: its calls on its own
// store and never the App's, and another person's, a forged or another
// App's draft lease, someone who no longer builds the App and a flood all
// refused. A visitor's attacks on it are in app-visitor-calls.test.ts.

const idp = mockIdp();

const files: Record<string, string> = {
  ...appDefinition({
    name: "Notes",
    tables: {
      notes: {
        fields: { title: "v.string().min(1).max(200)" },
        access: { read: "appMembers", write: "appMembers" },
      },
    },
  }),
  "server/notes.ts": `import { v } from "@grasp-os/sdk";
import { action, mutation, query } from "@server/_generated/server";

export const create = mutation({
  args: { title: v.string().min(1).max(200) },
  returns: v.id("notes"),
  handler: async (ctx, args) => await ctx.db.insert("notes", args),
});

export const titles = query({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => (await ctx.db.query("notes").take(100)).map((note) => note.title),
});

/** Writes a note once a wait is over, telling how far it got. */
export const slow = action({
  args: { title: v.string(), pauseMs: v.number().integer().min(0) },
  returns: v.string(),
  stream: v.object({ step: v.number() }),
  handler: async (ctx, args) => {
    await ctx.emit({ step: 1 });
    await new Promise((resolve) => setTimeout(resolve, args.pauseMs));
    await ctx.runMutation(create, { title: args.title });
    return args.title;
  },
});
`,

  "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";
function Notes() {
  return <p>Notes</p>;
}

export const Route = createFileRoute("/")({ component: Notes });
`,
};

type Person = Awaited<ReturnType<typeof signedInApi>>;

const personApi = async (role: Role): Promise<Person> =>
  await signedInApi(idp, role);

/**
 * A builder's Notes App, activated, with the lease core gave its page's
 * build as the builder opened it: no admin approves a page's build.
 */
const servedApp = async () => {
  const builder = await personApi("builder");
  const { id } = await builder.api.apps.create({ name: "Notes" });
  await published(id);
  const { version } = await builder.api.apps.files.commit(id, files, "First");
  await builder.api.apps.versions.setCurrent(id, version);
  const { lease } = await builder.api.pages.open(id);
  const release = await loadRelease(env, id, version);
  return { builder, app: id, lease, release };
};

type Served = Awaited<ReturnType<typeof servedApp>>;

/**
 * `servedApp`, its data classified ordinary and shared with `other`: a
 * page of it runs without a lease of the caller's, so a lease signed
 * for the frame's person is no fence on its own.
 */
const sharedOrdinaryApp = async () => {
  const served = await servedApp();
  const admin = await personApi("admin");
  const { generation } = await admin.api.dataPolicy.read(served.app);
  await admin.api.dataPolicy.classify(served.app, "ordinary", generation);
  const other = await personApi("builder");
  await served.builder.api.apps.members.add(served.app, {
    type: "person",
    id: other.userId,
    role: "user",
  });
  return { served, other };
};

/** A call's request, as the page client writes it. */
const requestFor = (
  { release }: Served,
  path: string,
  input: Json,
  idempotencyKey?: string
): string =>
  JSON.stringify({
    reference: { name: path, kind: release.app.operations[path]?.kind },
    input,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  });

interface Sent {
  /** Who posts: their session cookie, and the person the page names. */
  as?: Pick<Person, "session" | "userId">;
  /** The person the page names, when not `as`'s; `null` names nobody. */
  named?: string | null;
  lease?: string;
  /** The page's origin; `null` sends no `Origin` at all. */
  origin?: string | null;
  contentType?: string;
  headers?: Record<string, string>;
}

/** Posts `body` to `app`'s function path, as the page does unless told otherwise. */
const post = async (
  app: string,
  body: BodyInit,
  {
    as,
    named = as?.userId,
    lease,
    origin = clientOrigin,
    contentType = "application/json",
    headers = {},
  }: Sent
): Promise<Response> =>
  await routed(`${appFunctionPath}/${app}`, {
    method: "POST",
    headers: {
      ...headers,
      ...(origin === null ? {} : { origin }),
      "content-type": contentType,
      ...(as === undefined ? {} : { cookie: as.session }),
      ...(named === undefined || named === null
        ? {}
        : { [pagePersonHeader]: named }),
      ...(lease === undefined ? {} : { [pageLeaseHeader]: lease }),
    },
    body,
  });

/** The status and error code of a refused request. */
const refusalOf = async (response: Response) => ({
  status: response.status,
  code: errorPayloadSchema.parse(await response.json()).code,
});

/** The result of a call that was answered. */
const resultOf = async (response: Response): Promise<unknown> => {
  expect(response.status).toBe(200);
  const answer: unknown = await response.json();
  return typeof answer === "object" && answer !== null
    ? Reflect.get(answer, "result")
    : undefined;
};

/** The notes the App holds, as its builder's page reads them. */
const titlesOf = async (served: Served): Promise<unknown> =>
  await resultOf(
    await post(served.app, requestFor(served, "notes.titles", {}), {
      as: served.builder,
      lease: served.lease,
    })
  );

describe("a page calling its App's functions", { timeout: 120_000 }, () => {
  it("calls through for the build core leased, as the person signed in", async () => {
    const served = await servedApp();
    const created = await resultOf(
      await post(
        served.app,
        requestFor(served, "notes.create", { title: "Launch" }),
        { as: served.builder, lease: served.lease }
      )
    );
    expect(created).toMatchObject({ ok: true });
    await expect(titlesOf(served)).resolves.toStrictEqual({
      ok: true,
      value: ["Launch"],
    });
  });

  it("refuses a call with no lease of core's, or another App's, before it runs", async () => {
    const served = await servedApp();
    const other = await servedApp();
    const create = requestFor(served, "notes.create", { title: "Leaked" });
    const as = served.builder;
    expect({
      noLease: await refusalOf(await post(served.app, create, { as })),
      forged: await refusalOf(
        await post(served.app, create, {
          as,
          lease: `${"a".repeat(64)}.x`,
        })
      ),
      anotherApps: await refusalOf(
        await post(served.app, create, { as, lease: other.lease })
      ),
    }).toStrictEqual({
      noLease: { status: 403, code: "page.unreviewed" },
      forged: { status: 403, code: "page.unreviewed" },
      anotherApps: { status: 403, code: "page.unreviewed" },
    });
    await expect(titlesOf(served)).resolves.toStrictEqual({
      ok: true,
      value: [],
    });
  });

  it("refuses a call whose session is someone else's than the frame's, or that names nobody, before it runs", async () => {
    const { served, other } = await sharedOrdinaryApp();
    // The frame's person, and its save under a key whose answer was lost,
    // sent again once someone else's cookie is the browser's.
    const save = requestFor(
      served,
      "notes.create",
      { title: "Mine" },
      crypto.randomUUID()
    );
    const sentAs = async (
      as: Sent["as"],
      named?: string | null
    ): Promise<Response> =>
      await post(served.app, save, {
        as,
        lease: served.lease,
        ...(named === undefined ? {} : { named }),
      });
    expect({
      someoneElse: await refusalOf(await sentAs(other, served.builder.userId)),
      nobodyNamed: await refusalOf(await sentAs(other, null)),
    }).toStrictEqual({
      someoneElse: { status: 401, code: "auth.principal_changed" },
      // A page older than the header: out of date, not someone else.
      nobodyNamed: { status: 403, code: "page.reload_required" },
    });
    await expect(titlesOf(served)).resolves.toStrictEqual({
      ok: true,
      value: [],
    });
    // The same person on a new session is still the frame's: their save goes
    // through, once.
    const again = await signedIn(idp, "microsoft", served.builder.person, {
      coreEnv: withSignIn({ admins: [served.builder.person.email] }),
    });
    const sameUser = { session: again, userId: served.builder.userId };
    await expect(resultOf(await sentAs(sameUser))).resolves.toMatchObject({
      ok: true,
    });
    await expect(resultOf(await sentAs(served.builder))).resolves.toMatchObject(
      { ok: true }
    );
    await expect(titlesOf(served)).resolves.toStrictEqual({
      ok: true,
      value: ["Mine"],
    });
  });

  it("counts no call refused for its person against anyone's requests", async () => {
    // As in the rate test below: the clock stopped, so what is admitted is
    // exact.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    try {
      const { served, other } = await sharedOrdinaryApp();
      const titles = requestFor(served, "notes.titles", {});
      const { lease } = served;
      const statuses = async (sent: Sent, count: number): Promise<number[]> => {
        const seen: number[] = [];
        for (let call = 0; call < count; call += 1) {
          // oxlint-disable-next-line no-await-in-loop -- one request after another, as a page sends them
          const response = await post(served.app, titles, sent);
          seen.push(response.status);
          // oxlint-disable-next-line no-await-in-loop -- each body read so its request ends
          await response.body?.cancel();
        }
        return seen;
      };
      const { burst } = pageLimits.requests;
      const refused = {
        someoneElse: await statuses(
          { as: other, named: served.builder.userId, lease },
          burst
        ),
        nobodyNamed: await statuses(
          { as: served.builder, named: null, lease },
          burst
        ),
      };
      expect(refused).toStrictEqual({
        someoneElse: Array.from({ length: burst }, () => 401),
        nobodyNamed: Array.from({ length: burst }, () => 403),
      });
      // Each still has their whole budget: the builder's open of the
      // page counted one.
      expect({
        other: await statuses({ as: other, lease }, burst),
        builder: await statuses({ as: served.builder, lease }, burst - 1),
      }).toStrictEqual({
        other: Array.from({ length: burst }, () => 200),
        builder: Array.from({ length: burst - 1 }, () => 200),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses another site, a body that isn't JSON, someone signed out and someone without a role", async () => {
    const served = await servedApp();
    const stranger = await personApi("builder");
    const create = requestFor(served, "notes.create", { title: "Forged" });
    const { lease } = served;
    const as = served.builder;
    expect({
      site: await refusalOf(
        await post(served.app, create, {
          as,
          lease,
          origin: "https://elsewhere.test",
        })
      ),
      form: await refusalOf(
        await post(served.app, create, {
          as,
          lease,
          contentType: "text/plain",
        })
      ),
      signedOut: await refusalOf(await post(served.app, create, { lease })),
      stranger: await refusalOf(
        await post(served.app, create, { as: stranger, lease })
      ),
    }).toStrictEqual({
      site: { status: 403, code: "request.forbidden" },
      form: { status: 403, code: "request.forbidden" },
      signedOut: { status: 401, code: "auth.unauthenticated" },
      stranger: { status: 403, code: "app.not_found" },
    });
    await expect(titlesOf(served)).resolves.toStrictEqual({
      ok: true,
      value: [],
    });
  });

  it("refuses a request with no Origin, an opaque one, or a subdomain's", async () => {
    const served = await servedApp();
    const create = requestFor(served, "notes.create", { title: "Forged" });
    const sent = { as: served.builder, lease: served.lease };
    const subdomain = new URL(clientOrigin);
    subdomain.hostname = `evil.${subdomain.hostname}`;
    await expect(
      Promise.all(
        [null, "null", subdomain.origin].map(
          async (origin) =>
            await refusalOf(await post(served.app, create, { ...sent, origin }))
        )
      )
    ).resolves.toStrictEqual(
      Array.from({ length: 3 }, () => ({
        status: 403,
        code: "request.forbidden",
      }))
    );
    await expect(titlesOf(served)).resolves.toStrictEqual({
      ok: true,
      value: [],
    });
  });

  it("refuses a person past their requests of the App's pages", async () => {
    // The bucket fills again with time (`pageLimits.requests`), so the
    // clock is stopped: what is admitted is then exact, however long the
    // requests take. A fresh person and App, so no other test's count.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    try {
      const served = await servedApp();
      const titles = requestFor(served, "notes.titles", {});
      const sent = { as: served.builder, lease: served.lease };
      // Opening the page counted one already.
      const statuses: number[] = [];
      for (let count = 0; count < pageLimits.requests.burst; count += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one request after another, as a page sends them
        const response = await post(served.app, titles, sent);
        statuses.push(response.status);
        // oxlint-disable-next-line no-await-in-loop -- each body read so its request ends
        await response.body?.cancel();
      }
      expect(statuses).toStrictEqual([
        ...Array.from({ length: pageLimits.requests.burst - 1 }, () => 200),
        429,
      ]);
      const refused = await post(served.app, titles, sent);
      await expect(refusalOf(refused)).resolves.toStrictEqual({
        status: 429,
        code: "page.rate_limited",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a call of a revoked release before it runs, as the build revoked, and tells the page so", async () => {
    const served = await servedApp();
    const admin = await person("admin");
    await revokeRelease(
      env,
      admin,
      { app: appIdSchema.parse(served.app), version: 1 },
      "Leaks data"
    );
    await expect(
      refusalOf(
        await post(
          served.app,
          requestFor(served, "notes.create", { title: "After" }),
          { as: served.builder, lease: served.lease }
        )
      )
    ).resolves.toStrictEqual({ status: 403, code: "page.revoked" });
    // The page asks core on its own connection, and tears the frame down.
    await expect(
      served.builder.api.pages.frame(served.app, served.lease).delivery()
    ).resolves.toBe("revoked");
  });

  it("refuses a body whose length says it is past the bound, unread", async () => {
    const served = await servedApp();
    await expect(
      refusalOf(
        await post(served.app, requestFor(served, "notes.titles", {}), {
          as: served.builder,
          lease: served.lease,
          headers: { "content-length": String(functionRequestMaxBytes + 1) },
        })
      )
    ).resolves.toStrictEqual({ status: 413, code: "request.too_large" });
  });

  it("stops reading a body past its bound, whatever its length says, and runs nothing", async () => {
    const served = await servedApp();
    const as = served.builder;
    const { lease } = served;
    // A valid call, padded past the bound, sent as a stream with no length.
    const padded = requestFor(served, "notes.create", {
      title: "Padded",
    }).replace("{", `{ ${" ".repeat(functionRequestMaxBytes)}`);
    const bytes = new TextEncoder().encode(padded);
    const streamed = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let at = 0; at < bytes.byteLength; at += 16 * 1024) {
          controller.enqueue(bytes.slice(at, at + 16 * 1024));
        }
        controller.close();
      },
    });
    expect({
      streamed: await refusalOf(
        await post(served.app, streamed, { as, lease })
      ),
      whole: await refusalOf(await post(served.app, padded, { as, lease })),
    }).toStrictEqual({
      streamed: { status: 413, code: "request.too_large" },
      whole: { status: 413, code: "request.too_large" },
    });
    await expect(titlesOf(served)).resolves.toStrictEqual({
      ok: true,
      value: [],
    });
  });
});

/**
 * `served`'s App with `colleague` added as one of its builders, each with
 * their own chat of it previewed, and the lease each preview opened with:
 * a draft of the App (one that changes nothing yet), run on a throwaway
 * store of the preview's own.
 */
const previewed = async (served: Served) => {
  const colleague = await personApi("builder");
  await served.builder.api.apps.members.add(served.app, {
    type: "person",
    id: colleague.userId,
    role: "builder",
  });
  const leaseOf = async (by: Person) => {
    const { id } = await by.api.chats.forApp(served.app);
    const { lease } = await by.api.chats.preview(id, served.app);
    if (lease === undefined) {
      throw new Error("The preview opened with no lease.");
    }
    return { chatId: id, lease };
  };
  return {
    colleague,
    own: await leaseOf(served.builder),
    theirs: await leaseOf(colleague),
  };
};

/** The frames a streaming call answered, one JSON line each. */
const framesOf = async (response: Response): Promise<unknown[]> => {
  expect(response.status).toBe(200);
  const text = await response.text();
  return text
    .trim()
    .split("\n")
    .map((line): unknown => JSON.parse(line));
};

/** The result the last of `frames` carries. */
const resultOfLast = (frames: unknown[]): unknown => {
  const last = frames.at(-1);
  return isRecord(last) ? last.result : undefined;
};

/** The error code a refused result carries. */
const errorCodeOf = (result: unknown): unknown => {
  const error = isRecord(result) ? result.error : undefined;
  return isRecord(error) ? error.code : undefined;
};

/** `lease` with the chat it names swapped for `chatId`, its MAC kept. */
const withChat = (lease: string, chatId: string): string => {
  const [artifact, , mac] = lease.split(".");
  const chat = btoa(chatId)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
  return `${artifact}.d${chat}.${mac}`;
};

describe(
  "one call path for releases and drafts, from its threat model",
  { timeout: 180_000 },
  () => {
    it("runs a draft's calls on the preview's own store: the App's real store never sees them, nor the draft the App's", async () => {
      const served = await servedApp();
      const { own } = await previewed(served);
      const as = served.builder;
      const draft = { as, lease: own.lease };
      const real = { as, lease: served.lease };
      await resultOf(
        await post(
          served.app,
          requestFor(served, "notes.create", { title: "Real" }),
          real
        )
      );
      const drafted = await resultOf(
        await post(
          served.app,
          requestFor(served, "notes.create", { title: "Draft" }),
          draft
        )
      );
      expect({
        drafted: z.object({ ok: z.boolean() }).loose().parse(drafted).ok,
        draft: await resultOf(
          await post(served.app, requestFor(served, "notes.titles", {}), draft)
        ),
        real: await titlesOf(served),
      }).toStrictEqual({
        drafted: true,
        draft: { ok: true, value: ["Draft"] },
        real: { ok: true, value: ["Real"] },
      });
    });

    it("follows a draft's live query over the page's socket on its own store, and answers no workflow run", async () => {
      const served = await servedApp();
      const { own } = await previewed(served);
      const frame = served.builder.api.pages.frame(served.app, own.lease);
      const pushed = Promise.withResolvers<unknown>();
      await frame.watchQuery(requestFor(served, "notes.titles", {}), (push) => {
        pushed.resolve(push.result);
      });
      expect({
        pushed: await pushed.promise,
        delivery: await frame.delivery(),
        decide: await outcome(
          frame.decide("run", "decision", { approved: true })
        ),
      }).toStrictEqual({
        pushed: { ok: true, value: [] },
        delivery: "open",
        decide: "app.preview_side_effect",
      });
    });

    it("refuses another person's draft lease, a forged one and another App's, as no lease, before anything runs", async () => {
      const served = await servedApp();
      const other = await servedApp();
      const { colleague, own, theirs } = await previewed(served);
      const create = requestFor(served, "notes.create", { title: "Leaked" });
      const as = served.builder;
      const otherPreview = await previewed(other);
      expect({
        // Their lease, replayed by the builder; the builder's, by them.
        theirs: await refusalOf(
          await post(served.app, create, { as, lease: theirs.lease })
        ),
        replayed: await refusalOf(
          await post(served.app, create, { as: colleague, lease: own.lease })
        ),
        // The builder's own lease, its chat swapped for their colleague's.
        forgedChat: await refusalOf(
          await post(served.app, create, {
            as,
            lease: withChat(own.lease, theirs.chatId),
          })
        ),
        // A draft's lease of another App.
        anotherApps: await refusalOf(
          await post(served.app, create, { as, lease: otherPreview.own.lease })
        ),
      }).toStrictEqual({
        theirs: { status: 403, code: "page.unreviewed" },
        replayed: { status: 403, code: "page.unreviewed" },
        forgedChat: { status: 403, code: "page.unreviewed" },
        anotherApps: { status: 403, code: "page.unreviewed" },
      });
      await expect(titlesOf(served)).resolves.toStrictEqual({
        ok: true,
        value: [],
      });
    });

    it("refuses a draft's call once the person no longer builds the App, or names someone else", async () => {
      const served = await servedApp();
      const { colleague, theirs } = await previewed(served);
      const titles = requestFor(served, "notes.titles", {});
      const named = await refusalOf(
        await post(served.app, titles, {
          as: colleague,
          named: served.builder.userId,
          lease: theirs.lease,
        })
      );
      await served.builder.api.apps.members.add(served.app, {
        type: "person",
        id: colleague.userId,
        role: "user",
      });
      expect({
        named,
        user: await refusalOf(
          await post(served.app, titles, { as: colleague, lease: theirs.lease })
        ),
      }).toStrictEqual({
        named: { status: 401, code: "auth.principal_changed" },
        user: { status: 403, code: "role.forbidden" },
      });
    });

    it("streams, attaches to and cancels a draft's action on its own invocation, apart from the release's, and refuses another person's", async () => {
      const served = await servedApp();
      const { colleague, own } = await previewed(served);
      const as = served.builder;
      const slow = (title: string, pauseMs: number, key: string): string =>
        requestFor(served, "notes.slow", { title, pauseMs }, key);
      const draft = { as, lease: own.lease };
      const release = { as, lease: served.lease };
      const done = crypto.randomUUID();
      const streamed = await framesOf(
        await post(`${served.app}/stream`, slow("Streamed", 0, done), draft)
      );
      const attached = await framesOf(
        await post(`${served.app}/attach`, slow("Streamed", 0, done), draft)
      );
      // The release's page has no run under that key: a draft's runs apart.
      const releaseAttached = await framesOf(
        await post(`${served.app}/attach`, slow("Streamed", 0, done), release)
      );
      const neverStarted = await framesOf(
        await post(
          `${served.app}/attach`,
          slow("Never", 0, crypto.randomUUID()),
          draft
        )
      );
      // A long run, cancelled while it waits.
      const waiting = crypto.randomUUID();
      const started = post(
        `${served.app}/stream`,
        slow("Cancelled", 5000, waiting),
        draft
      );
      await vi.waitFor(
        async () => {
          const cancelled = await post(
            `${served.app}/cancel`,
            slow("Cancelled", 5000, waiting),
            draft
          );
          await expect(cancelled.json()).resolves.toStrictEqual({
            requested: true,
          });
        },
        { timeout: 10_000, interval: 100 }
      );
      const startedResponse = await started;
      await startedResponse.body?.cancel();
      const refused = await refusalOf(
        await post(
          `${served.app}/stream`,
          slow("Theirs", 0, crypto.randomUUID()),
          {
            as: colleague,
            lease: own.lease,
          }
        )
      );

      expect({
        streamed: resultOfLast(streamed),
        attached: resultOfLast(attached),
        releaseAttached: errorCodeOf(resultOfLast(releaseAttached)),
        neverStarted: errorCodeOf(resultOfLast(neverStarted)),
        refused,
        draftTitles: await resultOf(
          await post(served.app, requestFor(served, "notes.titles", {}), draft)
        ),
        realTitles: await titlesOf(served),
      }).toStrictEqual({
        streamed: { ok: true, value: "Streamed" },
        attached: { ok: true, value: "Streamed" },
        releaseAttached: "submission.expired",
        neverStarted: "submission.expired",
        refused: { status: 403, code: "page.unreviewed" },
        draftTitles: { ok: true, value: ["Streamed"] },
        realTitles: { ok: true, value: [] },
      });
    });

    it("hands a draft action's kept result to no one once its draft is discarded or its chat deleted, under the same lease and key", async () => {
      const served = await servedApp();
      const { builder } = served;
      const { chatId } = await chatWithDraft(
        builder,
        appIdSchema.parse(served.app),
        {
          "server/notes.ts": `${files["server/notes.ts"] ?? ""}\n// Drafted.\n`,
        }
      );
      const lease = await previewLease(builder, chatId, served.app);
      const sent = { as: builder, lease };
      const call = requestFor(
        served,
        "notes.slow",
        { title: "Kept", pauseMs: 0 },
        crypto.randomUUID()
      );
      const attach = async (): Promise<Response> =>
        await post(`${served.app}/attach`, call, sent);
      const streamed = resultOfLast(
        await framesOf(await post(`${served.app}/stream`, call, sent))
      );
      const before = resultOfLast(await framesOf(await attach()));
      await builder.api.chats.discardDraft(chatId, served.app);
      const discarded = errorCodeOf(
        resultOfLast(await framesOf(await attach()))
      );
      await builder.api.chats.remove(chatId);
      const deleted = await refusalOf(await attach());
      expect({ streamed, before, discarded, deleted }).toStrictEqual({
        streamed: { ok: true, value: "Kept" },
        before: { ok: true, value: "Kept" },
        discarded: "submission.expired",
        deleted: { status: 403, code: "agent.chat_not_found" },
      });
    });

    it("counts a draft's calls against the person's requests of the App's pages, as a release's", async () => {
      vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
      try {
        const served = await servedApp();
        const { own } = await previewed(served);
        const titles = requestFor(served, "notes.titles", {});
        const sent = { as: served.builder, lease: own.lease };
        const statuses: number[] = [];
        for (let count = 0; count < pageLimits.requests.burst; count += 1) {
          // oxlint-disable-next-line no-await-in-loop -- one request after another, as a page sends them
          const response = await post(served.app, titles, sent);
          statuses.push(response.status);
          // oxlint-disable-next-line no-await-in-loop -- each body read so its request ends
          await response.body?.cancel();
        }
        // Opening the App's page counted one, and so did the preview.
        expect(statuses.at(-1)).toBe(429);
        await expect(
          refusalOf(
            await post(served.app, titles, {
              as: served.builder,
              lease: served.lease,
            })
          )
        ).resolves.toStrictEqual({ status: 429, code: "page.rate_limited" });
      } finally {
        vi.useRealTimers();
      }
    });
  }
);
