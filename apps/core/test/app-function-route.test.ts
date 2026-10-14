import { errorPayloadSchema } from "@grasp-os/shared/errors";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import { functionRequestMaxBytes } from "@grasp-os/shared/operation-limits";
import type { Role } from "@grasp-os/shared/roles";
import { builtArtifacts } from "@grasp-os/shared/screen-trust";
import {
  appFunctionPath,
  screenLeaseHeader,
  screenLimits,
} from "@grasp-os/shared/screens";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { loadRelease } from "../src/app-releases.ts";
import { revokeRelease } from "../src/release-retention.ts";
import { mockIdp } from "./idp.ts";
import { person } from "./sealed-apps.ts";
import { clientOrigin } from "./sign-in-config.ts";
import { routed, signedInApi } from "./sign-in.ts";

// A running App's screen calling one of its App's functions over core's
// plain request (app-function-route.ts), from the page's side: a screen
// whose build an admin approved calls through; one nobody approved, one
// with someone else's lease, another site, someone signed out or without
// a role, and a body larger than any request may be, are refused, the
// last before core reads past its bound.

const idp = mockIdp();

const files: Record<string, string> = {
  "schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({
  notes: defineTable({ title: v.string().min(1).max(200) }),
});
`,
  "operations/notes.ts": `import { v } from "@grasp-os/sdk";
import { mutation, query } from "#grasp/server";

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
import { create, titles } from "./operations/notes.ts";
import schema from "./schema.ts";

export default app({
  name: "Notes",
  schema,
  access: { tables: { notes: { read: "appMembers", write: "appMembers" } } },
  operations: { notes: { create, titles } },
  internalOperations: {},
  screens: [],
  uses: [],
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

/** A builder's Notes App, activated, with its screen's build approved by an admin. */
const approvedApp = async () => {
  const builder = await personApi("builder");
  const admin = await personApi("admin");
  const { id } = await builder.api.apps.create({ name: "Notes" });
  const { version } = await builder.api.apps.files.commit(id, files, "First");
  await builder.api.apps.versions.setCurrent(id, version);
  const review = await admin.api.screenTrust.review(id);
  await admin.api.screenTrust.approve(id, {
    version: review.version,
    generation: review.generation,
    artifacts: builtArtifacts(review.screens),
  });
  const { lease } = await builder.api.screens.open(id, "notes");
  const release = await loadRelease(env, id, version);
  return { builder, app: id, lease, release };
};

type Approved = Awaited<ReturnType<typeof approvedApp>>;

/** A call's request, as the screen client writes it. */
const requestFor = ({ release }: Approved, path: string, input: Json): string =>
  JSON.stringify({
    reference: {
      resourceId: release.manifest.resourceId,
      resourceVersion: release.manifest.resourceVersion,
      contractId: path,
      fingerprint: release.fingerprints[path],
      kind: release.app.operations[path]?.kind,
    },
    input,
  });

interface Sent {
  cookie?: string;
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
    cookie,
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
      ...(cookie === undefined ? {} : { cookie }),
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

/** The notes the App holds, as its builder's approved screen reads them. */
const titlesOf = async (approved: Approved): Promise<unknown> =>
  await resultOf(
    await post(approved.app, requestFor(approved, "notes.titles", {}), {
      cookie: approved.builder.session,
      lease: approved.lease,
    })
  );

describe("a screen calling its App's functions", { timeout: 120_000 }, () => {
  it("calls through for an approved build, as the person signed in", async () => {
    const approved = await approvedApp();
    const created = await resultOf(
      await post(
        approved.app,
        requestFor(approved, "notes.create", { title: "Launch" }),
        { cookie: approved.builder.session, lease: approved.lease }
      )
    );
    expect(created).toMatchObject({ ok: true });
    await expect(titlesOf(approved)).resolves.toStrictEqual({
      ok: true,
      value: ["Launch"],
    });
  });

  it("refuses a build nobody approved, or someone else's lease, before the call", async () => {
    const approved = await approvedApp();
    const other = await approvedApp();
    const create = requestFor(approved, "notes.create", { title: "Leaked" });
    const cookie = approved.builder.session;
    expect({
      noLease: await refusalOf(await post(approved.app, create, { cookie })),
      forged: await refusalOf(
        await post(approved.app, create, {
          cookie,
          lease: `${"a".repeat(64)}.x`,
        })
      ),
      anotherApps: await refusalOf(
        await post(approved.app, create, { cookie, lease: other.lease })
      ),
    }).toStrictEqual({
      noLease: { status: 403, code: "screen.unreviewed" },
      forged: { status: 403, code: "screen.unreviewed" },
      anotherApps: { status: 403, code: "screen.unreviewed" },
    });
    await expect(titlesOf(approved)).resolves.toStrictEqual({
      ok: true,
      value: [],
    });
  });

  it("refuses another site, a body that isn't JSON, someone signed out and someone without a role", async () => {
    const approved = await approvedApp();
    const stranger = await personApi("builder");
    const create = requestFor(approved, "notes.create", { title: "Forged" });
    const { lease } = approved;
    const cookie = approved.builder.session;
    expect({
      site: await refusalOf(
        await post(approved.app, create, {
          cookie,
          lease,
          origin: "https://elsewhere.test",
        })
      ),
      form: await refusalOf(
        await post(approved.app, create, {
          cookie,
          lease,
          contentType: "text/plain",
        })
      ),
      signedOut: await refusalOf(await post(approved.app, create, { lease })),
      stranger: await refusalOf(
        await post(approved.app, create, { cookie: stranger.session, lease })
      ),
    }).toStrictEqual({
      site: { status: 403, code: "request.forbidden" },
      form: { status: 403, code: "request.forbidden" },
      signedOut: { status: 401, code: "auth.unauthenticated" },
      stranger: { status: 403, code: "app.not_found" },
    });
    await expect(titlesOf(approved)).resolves.toStrictEqual({
      ok: true,
      value: [],
    });
  });

  it("refuses a request with no Origin, an opaque one, or a subdomain's", async () => {
    const approved = await approvedApp();
    const create = requestFor(approved, "notes.create", { title: "Forged" });
    const sent = { cookie: approved.builder.session, lease: approved.lease };
    const subdomain = new URL(clientOrigin);
    subdomain.hostname = `evil.${subdomain.hostname}`;
    await expect(
      Promise.all(
        [null, "null", subdomain.origin].map(
          async (origin) =>
            await refusalOf(
              await post(approved.app, create, { ...sent, origin })
            )
        )
      )
    ).resolves.toStrictEqual(
      Array.from({ length: 3 }, () => ({
        status: 403,
        code: "request.forbidden",
      }))
    );
    await expect(titlesOf(approved)).resolves.toStrictEqual({
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
      const approved = await approvedApp();
      const titles = requestFor(approved, "notes.titles", {});
      const sent = { cookie: approved.builder.session, lease: approved.lease };
      // Opening the screen counted one already.
      const statuses: number[] = [];
      for (let count = 0; count < screenLimits.requests.burst; count += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one request after another, as a page sends them
        const response = await post(approved.app, titles, sent);
        statuses.push(response.status);
        // oxlint-disable-next-line no-await-in-loop -- each body read so its request ends
        await response.body?.cancel();
      }
      expect(statuses).toStrictEqual([
        ...Array.from({ length: screenLimits.requests.burst - 1 }, () => 200),
        429,
      ]);
      const refused = await post(approved.app, titles, sent);
      await expect(refusalOf(refused)).resolves.toStrictEqual({
        status: 429,
        code: "screen.rate_limited",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a call of a revoked release before it runs, as the build revoked, and tells the page so", async () => {
    const approved = await approvedApp();
    const admin = await person("admin");
    await revokeRelease(
      env,
      admin,
      { app: appIdSchema.parse(approved.app), version: 1 },
      "Leaks data"
    );
    await expect(
      refusalOf(
        await post(
          approved.app,
          requestFor(approved, "notes.create", { title: "After" }),
          { cookie: approved.builder.session, lease: approved.lease }
        )
      )
    ).resolves.toStrictEqual({ status: 403, code: "screen.revoked" });
    // The page asks core on its own connection, and tears the frame down.
    await expect(
      approved.builder.api.screens.present(approved.app, approved.lease)
    ).resolves.toBe("revoked");
  });

  it("refuses a body whose length says it is past the bound, unread", async () => {
    const approved = await approvedApp();
    await expect(
      refusalOf(
        await post(approved.app, requestFor(approved, "notes.titles", {}), {
          cookie: approved.builder.session,
          lease: approved.lease,
          headers: { "content-length": String(functionRequestMaxBytes + 1) },
        })
      )
    ).resolves.toStrictEqual({ status: 413, code: "request.too_large" });
  });

  it("stops reading a body past its bound, whatever its length says, and runs nothing", async () => {
    const approved = await approvedApp();
    const cookie = approved.builder.session;
    const { lease } = approved;
    // A valid call, padded past the bound, sent as a stream with no length.
    const padded = requestFor(approved, "notes.create", {
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
        await post(approved.app, streamed, { cookie, lease })
      ),
      whole: await refusalOf(
        await post(approved.app, padded, { cookie, lease })
      ),
    }).toStrictEqual({
      streamed: { status: 413, code: "request.too_large" },
      whole: { status: 413, code: "request.too_large" },
    });
    await expect(titlesOf(approved)).resolves.toStrictEqual({
      ok: true,
      value: [],
    });
  });
});
