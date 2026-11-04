import { errorPayloadSchema } from "@grasp-os/shared/errors";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import { functionRequestMaxBytes } from "@grasp-os/shared/operation-limits";
import type { Role } from "@grasp-os/shared/roles";
import {
  appFunctionPath,
  screenLeaseHeader,
  screenLimits,
  screenPersonHeader,
} from "@grasp-os/shared/screens";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { loadRelease } from "../src/app-releases.ts";
import { revokeRelease } from "../src/release-retention.ts";
import { published } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { person } from "./sealed-apps.ts";
import { clientOrigin } from "./sign-in-config.ts";
import { routed, signedIn, signedInApi, withSignIn } from "./sign-in.ts";

// A running App's screen calling one of its App's functions over core's
// plain request (app-function-route.ts), from the page's side: a screen
// with the lease core gave its build calls through, no admin approving
// it; one with no lease of core's, one with someone else's lease, another site, someone signed out or without
// a role, a session that is someone else's than the frame's, and a body
// larger than any request may be, are refused, the last before core reads
// past its bound.

const idp = mockIdp();

const files: Record<string, string> = {
  "schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({
  notes: defineTable({ title: v.string().min(1).max(200) }),
});
`,
  "server/notes.ts": `import { v } from "@grasp-os/sdk";
import { mutation, query } from "@server/_generated/server";

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
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import schema from "./schema.ts";

export default app({
  name: "Notes",
  schema,
  access: { tables: { notes: { read: "appMembers", write: "appMembers" } } },
  screens: [],
});
`,
  "screens/notes.tsx": `export default function Notes() {
  return <p>Notes</p>;
}
`,
};

type Person = Awaited<ReturnType<typeof signedInApi>>;

const personApi = async (role: Role): Promise<Person> =>
  await signedInApi(idp, role);

/**
 * A builder's Notes App, activated, with the lease core gave its screen's
 * build as the builder opened it: no admin approves a screen's build.
 */
const servedApp = async () => {
  const builder = await personApi("builder");
  const { id } = await builder.api.apps.create({ name: "Notes" });
  await published(id);
  const { version } = await builder.api.apps.files.commit(id, files, "First");
  await builder.api.apps.versions.setCurrent(id, version);
  const { lease } = await builder.api.screens.open(id, "notes");
  const release = await loadRelease(env, id, version);
  return { builder, app: id, lease, release };
};

type Served = Awaited<ReturnType<typeof servedApp>>;

/**
 * `servedApp`, its data classified ordinary and shared with `other`: a
 * screen of it runs without a lease of the caller's, so a lease signed
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

/** A call's request, as the screen client writes it. */
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
        : { [screenPersonHeader]: named }),
      ...(lease === undefined ? {} : { [screenLeaseHeader]: lease }),
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

/** The notes the App holds, as its builder's screen reads them. */
const titlesOf = async (served: Served): Promise<unknown> =>
  await resultOf(
    await post(served.app, requestFor(served, "notes.titles", {}), {
      as: served.builder,
      lease: served.lease,
    })
  );

describe("a screen calling its App's functions", { timeout: 120_000 }, () => {
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
      noLease: { status: 403, code: "screen.unreviewed" },
      forged: { status: 403, code: "screen.unreviewed" },
      anotherApps: { status: 403, code: "screen.unreviewed" },
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
      nobodyNamed: { status: 403, code: "screen.reload_required" },
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
      const { burst } = screenLimits.requests;
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
      // screen counted one.
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

  it("refuses a person past their requests of the App's screens", async () => {
    // The bucket fills again with time (`screenLimits.requests`), so the
    // clock is stopped: what is admitted is then exact, however long the
    // requests take. A fresh person and App, so no other test's count.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    try {
      const served = await servedApp();
      const titles = requestFor(served, "notes.titles", {});
      const sent = { as: served.builder, lease: served.lease };
      // Opening the screen counted one already.
      const statuses: number[] = [];
      for (let count = 0; count < screenLimits.requests.burst; count += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one request after another, as a page sends them
        const response = await post(served.app, titles, sent);
        statuses.push(response.status);
        // oxlint-disable-next-line no-await-in-loop -- each body read so its request ends
        await response.body?.cancel();
      }
      expect(statuses).toStrictEqual([
        ...Array.from({ length: screenLimits.requests.burst - 1 }, () => 200),
        429,
      ]);
      const refused = await post(served.app, titles, sent);
      await expect(refusalOf(refused)).resolves.toStrictEqual({
        status: 429,
        code: "screen.rate_limited",
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
    ).resolves.toStrictEqual({ status: 403, code: "screen.revoked" });
    // The page asks core on its own connection, and tears the frame down.
    await expect(
      served.builder.api.screens.frame(served.app, served.lease).delivery()
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
