import { GraspClient, GraspError } from "@grasp-os/sdk/client";
import { fromBase64Url, toBase64Url } from "@grasp-os/shared/encoding";
import { errorPayloadSchema } from "@grasp-os/shared/errors";
import { appIdSchema } from "@grasp-os/shared/ids";
import { functionRequestMaxBytes } from "@grasp-os/shared/operation-limits";
import { appTokenPath, portableFunctionPath } from "@grasp-os/shared/portable";
import type { Role } from "@grasp-os/shared/roles";
import { appFunctionPath } from "@grasp-os/shared/screens";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { loadRelease } from "../src/app-releases.ts";
import { sweepTokenKeys } from "../src/auth/app-tokens.ts";
import { authFor } from "../src/auth/auth.ts";
import { signInConfig } from "../src/auth/config.ts";
import { revokeRelease } from "../src/release-retention.ts";
import { eventsAfter, logHead } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { apiOf, notesFiles } from "./notes-client-app.ts";
import { person } from "./sealed-apps.ts";
import { clientOrigin } from "./sign-in-config.ts";
import { callAuth, routed, signedInApi } from "./sign-in.ts";

// A portable host (spec 10.7.1: the App's UI outside Grasp's shell) on
// `new GraspClient({ url, getToken })`, against core's real routes: the
// person's session mints an App token, and the client calls the App's
// functions with it. The ways it can fail come first: a token missing,
// expired, from a session that ended, for another App, or presented on
// the cookie's route; a cookie on the token's route; a token minted from
// another site or for an App the person has no role in; someone whose
// role went; code nobody approved getting sensitive data, or a revoked
// release's; and someone else's data shown after they swap.

const idp = mockIdp();

type Person = Awaited<ReturnType<typeof signedInApi>>;

const personApi = async (role: Role): Promise<Person> =>
  await signedInApi(idp, role);

/** Classifies the App's data as `admin`, under the generation they review now. */
const classifyAs = async (
  admin: Person,
  app: string,
  output: "ordinary" | "sensitive"
): Promise<void> => {
  const { generation } = await admin.api.screenTrust.review(app);
  await admin.api.screenTrust.classify(app, output, generation);
};

/**
 * A builder's Notes App, made current; its data `ordinary` (fine for
 * code nobody approved) unless `sensitive`.
 */
const notesApp = async ({ sensitive = false } = {}) => {
  const builder = await personApi("builder");
  const admin = await personApi("admin");
  const { id } = await builder.api.apps.create({ name: "Notes" });
  const { version } = await builder.api.apps.files.commit(
    id,
    notesFiles,
    "First"
  );
  await builder.api.apps.versions.setCurrent(id, version);
  if (!sensitive) {
    await classifyAs(admin, id, "ordinary");
  }
  const release = await loadRelease(env, id, version);
  return { builder, admin, app: id, release, api: apiOf(release) };
};

type NotesApp = Awaited<ReturnType<typeof notesApp>>;

/**
 * Asks core for a token for `app`, from `origin` with `cookie`; through
 * `coreEnv`, as an isolate of its own would, when given.
 */
const requestToken = async (
  app: string,
  {
    cookie,
    origin = clientOrigin,
    contentType = "application/json",
    coreEnv = env,
  }: { cookie?: string; origin?: string; contentType?: string; coreEnv?: Env }
): Promise<Response> =>
  await routed(
    `${appTokenPath}/${app}`,
    {
      method: "POST",
      headers: {
        origin,
        "content-type": contentType,
        ...(cookie === undefined ? {} : { cookie }),
      },
      body: "{}",
    },
    coreEnv
  );

const issuedSchema = z.object({
  token: z.string(),
  expiresAt: z.iso.datetime(),
});

/** A token for `cookie`'s person to call `app`'s functions. */
const tokenFor = async (
  cookie: string,
  app: string,
  coreEnv: Env = env
): Promise<string> => {
  const response = await requestToken(app, { cookie, coreEnv });
  expect(response.status).toBe(200);
  return issuedSchema.parse(await response.json()).token;
};

const claimsSchema = z.object({ sub: z.string(), sid: z.string() });

/** What a token's payload says, read without checking it. */
const claimsOf = (token: string) =>
  claimsSchema.parse(
    JSON.parse(
      new TextDecoder().decode(fromBase64Url(token.split(".")[1] ?? ""))
    )
  );

/** The status and error code of a refused request. */
const refusalOf = async (response: Response) => ({
  status: response.status,
  code: errorPayloadSchema.parse(await response.json()).code,
});

/** A call's request, as the client writes it. */
const requestFor = (
  { release }: NotesApp,
  path: string,
  input: unknown
): string =>
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

/** Posts `body` to `app`'s portable function route with `headers`, through `coreEnv`. */
const postPortable = async (
  app: string,
  body: string,
  headers: Record<string, string>,
  coreEnv: Env = env
): Promise<Response> =>
  await routed(
    `${portableFunctionPath}/${app}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    },
    coreEnv
  );

/** The status `response` answers with. */
const statusOf = async (response: Promise<Response>): Promise<number> => {
  const { status } = await response;
  return status;
};

/** A list of the App's notes, posted with `token` through `coreEnv`. */
const listWith = async (
  notes: NotesApp,
  token: string,
  coreEnv: Env = env
): Promise<Response> =>
  await postPortable(
    notes.app,
    requestFor(notes, "notes.list", { pagination: {} }),
    { authorization: `Bearer ${token}` },
    coreEnv
  );

/** A token header of `fields`, base64url. */
const headerOf = (fields: unknown): string =>
  toBase64Url(new TextEncoder().encode(JSON.stringify(fields)));

/**
 * A token header whose base64url is a multiple of 4 long, so one more
 * character makes it a length a strict decoder refuses and a lenient one
 * reads the same.
 */
const lenientHeader = (forged: number): string => {
  let padding = "";
  for (;;) {
    const text = JSON.stringify({ alg: "EdDSA", kid: `k${forged}${padding}` });
    const encoded = toBase64Url(new TextEncoder().encode(text));
    if (encoded.length % 4 === 0) {
      return encoded;
    }
    padding += "x";
  }
};

/**
 * `env` with its D1 counting the reads of the token keys' table: an
 * isolate of its own, which holds no keys yet.
 */
const countingKeyReads = () => {
  let reads = 0;
  const db = new Proxy(env.DB, {
    get: (target, property): unknown =>
      property === "prepare"
        ? (query: string) => {
            if (query.includes('"jwks"')) {
              reads += 1;
            }
            return target.prepare(query);
          }
        : Reflect.get(target, property),
  });
  return { coreEnv: { ...env, DB: db }, reads: () => reads };
};

/** What a portable host's browser sent: what core reads, and how it sent it. */
interface Sent {
  authorization: string | null;
  cookie: boolean;
  credentials: unknown;
  redirect: unknown;
}

/**
 * The host's network: its `fetch` of the deployment reaches core through
 * the router, as a browser's would; everything else goes out as before.
 */
const hostNetwork = () => {
  const sent: Sent[] = [];
  const received: Response[] = [];
  const outside = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.origin !== clientOrigin) {
        return await outside(input, init);
      }
      const headers = new Headers(init?.headers);
      sent.push({
        authorization: headers.get("authorization"),
        cookie: headers.has("cookie"),
        // What the browser does with these; workerd takes neither.
        credentials: Reflect.get(init ?? {}, "credentials"),
        redirect: init?.redirect,
      });
      const response = await routed(`${url.pathname}${url.search}`, {
        method: init?.method ?? "GET",
        headers,
        body: init?.body ?? null,
      });
      received.push(response.clone());
      return response;
    }
  );
  return { sent, received };
};

/** A client a portable host makes, its token whatever `token()` says now. */
const portableClient = (token: () => string | null) =>
  new GraspClient({
    url: clientOrigin,
    getToken: async () => await Promise.resolve(token()),
  });

/** Why `promise` rejected: the structured error's code and category. */
const failureOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof GraspError)) {
      throw error;
    }
    return { code: error.code, category: error.category };
  }
  throw new Error("It resolved");
};

describe("a portable host's client", { timeout: 120_000 }, () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("creates, reads, edits and deletes notes with the person's App token", async () => {
    const notes = await notesApp();
    const token = await tokenFor(notes.builder.session, notes.app);
    const network = hostNetwork();
    const client = portableClient(() => token);
    const { api } = notes;

    const id = await client.mutation(api.create, { title: "  Launch  " });
    const created = await client.query(api.get, { id });
    const edited = await client.mutation(api.update, {
      id,
      expectedRevision: 1,
      title: "Launch plan",
      body: "Ship it",
    });
    const page = await client.query(api.list, { pagination: {} });
    const removed = await client.mutation(api.remove, {
      id,
      expectedRevision: 2,
    });
    const gone = await client.query(api.get, { id });
    expect({
      created,
      edited,
      titles: page.items.map((note) => note.title),
      removed,
      gone,
    }).toMatchObject({
      created: { _id: id, title: "Launch", _rev: 1 },
      edited: { title: "Launch plan", body: "Ship it", _rev: 2 },
      titles: ["Launch plan"],
      removed: null,
      gone: null,
    });

    // Every call carried the token and nothing of the browser's: no
    // cookie, no redirect followed; every answer is readable cross-site.
    expect(network.sent).toHaveLength(6);
    expect(
      new Set(network.sent.map((sent) => JSON.stringify(sent)))
    ).toStrictEqual(
      new Set([
        JSON.stringify({
          authorization: `Bearer ${token}`,
          cookie: false,
          credentials: "omit",
          redirect: "error",
        }),
      ])
    );
    expect(
      new Set(
        network.received.map((response) =>
          JSON.stringify([
            response.headers.get("access-control-allow-origin"),
            response.headers.has("access-control-allow-credentials"),
          ])
        )
      )
    ).toStrictEqual(new Set([JSON.stringify(["*", false])]));
  });

  it("refuses no token, a forged one, another App's and an expired one before the call runs", async () => {
    const notes = await notesApp();
    const other = await notesApp();
    const token = await tokenFor(notes.builder.session, notes.app);
    const othersToken = await tokenFor(other.builder.session, other.app);
    const create = requestFor(notes, "notes.create", { title: "Forged" });
    const [header, , signature] = token.split(".");
    // Someone else's claims under the token's own header and signature.
    const forgedClaims = toBase64Url(
      new TextEncoder().encode(
        JSON.stringify({ sub: other.builder.userId, app: notes.app })
      )
    );
    expect({
      none: await refusalOf(await postPortable(notes.app, create, {})),
      notBearer: await refusalOf(
        await postPortable(notes.app, create, { authorization: token })
      ),
      forged: await refusalOf(
        await postPortable(notes.app, create, {
          authorization: `Bearer ${header}.${forgedClaims}.${signature}`,
        })
      ),
      anotherApps: await refusalOf(
        await postPortable(notes.app, create, {
          authorization: `Bearer ${othersToken}`,
        })
      ),
    }).toStrictEqual({
      none: { status: 401, code: "auth.unauthenticated" },
      notBearer: { status: 401, code: "auth.unauthenticated" },
      forged: { status: 401, code: "auth.unauthenticated" },
      anotherApps: { status: 401, code: "auth.unauthenticated" },
    });

    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 5 * 60_000 + 1000 });
    await expect(
      refusalOf(
        await postPortable(notes.app, create, {
          authorization: `Bearer ${token}`,
        })
      )
    ).resolves.toStrictEqual({ status: 401, code: "auth.unauthenticated" });
    vi.useRealTimers();

    // Nothing of any of them ran.
    const fresh = await tokenFor(notes.builder.session, notes.app);
    const response = await listWith(notes, fresh);
    const listed: unknown = await response.json();
    expect(listed).toMatchObject({
      result: { ok: true, value: { items: [] } },
    });
  });

  it("ends every token with the session it came from, and goes no further than the person's role", async () => {
    const notes = await notesApp();
    const reader = await personApi("user");
    await notes.builder.api.apps.members.add(notes.app, {
      type: "person",
      id: reader.userId,
      role: "user",
    });
    const readers = await tokenFor(reader.session, notes.app);
    await expect(statusOf(listWith(notes, readers))).resolves.toBe(200);
    await notes.builder.api.apps.members.remove(notes.app, {
      type: "person",
      id: reader.userId,
    });
    await expect(
      refusalOf(await listWith(notes, readers))
    ).resolves.toStrictEqual({ status: 403, code: "app.not_found" });

    const builders = await tokenFor(notes.builder.session, notes.app);
    await expect(statusOf(listWith(notes, builders))).resolves.toBe(200);
    await callAuth("/sign-out", notes.builder.session, {});
    await expect(
      refusalOf(await listWith(notes, builders))
    ).resolves.toStrictEqual({ status: 401, code: "auth.unauthenticated" });
  });

  it("keeps the cookie and the token apart, and the plugin's own token routes closed", async () => {
    const notes = await notesApp();
    const token = await tokenFor(notes.builder.session, notes.app);
    const titles = requestFor(notes, "notes.list", { pagination: {} });
    expect({
      tokenOnCookieRoute: await refusalOf(
        await routed(`${appFunctionPath}/${notes.app}`, {
          method: "POST",
          headers: {
            origin: clientOrigin,
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: titles,
        })
      ),
      cookieOnTokenRoute: await refusalOf(
        await postPortable(notes.app, titles, {
          origin: clientOrigin,
          cookie: notes.builder.session,
        })
      ),
    }).toStrictEqual({
      tokenOnCookieRoute: { status: 401, code: "auth.unauthenticated" },
      cookieOnTokenRoute: { status: 401, code: "auth.unauthenticated" },
    });
    const sessionToken = await callAuth("/token", notes.builder.session);
    const keys = await callAuth("/jwks", notes.builder.session);
    const session = await callAuth("/get-session", notes.builder.session);
    expect({
      token: sessionToken.status,
      jwks: keys.status,
      session: session.status,
      sessionJwt: session.headers.has("set-auth-jwt"),
    }).toStrictEqual({
      token: 404,
      jwks: 404,
      session: 200,
      sessionJwt: false,
    });
  });

  it("mints a token only from the deployment's own pages, for an App the person has a role in, and records it", async () => {
    const notes = await notesApp();
    const stranger = await personApi("builder");
    const cookie = notes.builder.session;
    expect({
      site: await refusalOf(
        await requestToken(notes.app, {
          cookie,
          origin: "https://elsewhere.test",
        })
      ),
      form: await refusalOf(
        await requestToken(notes.app, { cookie, contentType: "text/plain" })
      ),
      signedOut: await refusalOf(await requestToken(notes.app, {})),
      stranger: await refusalOf(
        await requestToken(notes.app, { cookie: stranger.session })
      ),
    }).toStrictEqual({
      site: { status: 403, code: "request.forbidden" },
      form: { status: 403, code: "request.forbidden" },
      signedOut: { status: 401, code: "auth.unauthenticated" },
      stranger: { status: 403, code: "app.not_found" },
    });

    const head = await logHead();
    const response = await requestToken(notes.app, { cookie });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const { token, expiresAt } = issuedSchema.parse(await response.json());
    expect(Date.parse(expiresAt) - Date.now()).toBeLessThanOrEqual(5 * 60_000);
    const events = await eventsAfter(head);
    expect(
      events.filter(({ action }) => action === "app.token.issued")
    ).toMatchObject([
      {
        actor: { type: "person", userId: notes.builder.userId },
        target: { type: "app", id: notes.app },
        detail: { session: claimsOf(token).sid },
      },
    ]);
  });

  it("gives no portable host an App's sensitive data, nor anything of a revoked release", async () => {
    const notes = await notesApp({ sensitive: true });
    const token = await tokenFor(notes.builder.session, notes.app);
    hostNetwork();
    const client = portableClient(() => token);
    await expect(
      failureOf(client.mutation(notes.api.create, { title: "Leaked" }))
    ).resolves.toStrictEqual({
      code: "screen.unreviewed",
      category: "authorization",
    });

    await classifyAs(notes.admin, notes.app, "ordinary");
    await expect(
      client.query(notes.api.list, { pagination: {} })
    ).resolves.toMatchObject({ items: [] });

    await revokeRelease(
      env,
      await person("admin"),
      { app: appIdSchema.parse(notes.app), version: 1 },
      "Leaks data"
    );
    await expect(
      failureOf(client.query(notes.api.list, { pagination: {} }))
    ).resolves.toStrictEqual({
      code: "screen.revoked",
      category: "authorization",
    });
  });

  it("answers any origin's preflight without credentials; the cookie route answers none", async () => {
    const notes = await notesApp();
    const preflight = async (path: string) =>
      await routed(`${path}/${notes.app}`, {
        method: "OPTIONS",
        headers: {
          origin: "https://elsewhere.test",
          "access-control-request-method": "POST",
          "access-control-request-headers": "authorization, content-type",
        },
      });
    const portable = await preflight(portableFunctionPath);
    expect({
      status: portable.status,
      origin: portable.headers.get("access-control-allow-origin"),
      headers: portable.headers.get("access-control-allow-headers"),
      credentials: portable.headers.has("access-control-allow-credentials"),
    }).toStrictEqual({
      status: 204,
      origin: "*",
      headers: "authorization, content-type",
      credentials: false,
    });
    const cookieRoute = await preflight(appFunctionPath);
    expect(cookieRoute.status).toBe(404);
    expect(cookieRoute.headers.has("access-control-allow-origin")).toBeFalsy();
  });

  it("refuses a call before sending it while the host has no token, and shows the next person only their own notes", async () => {
    const notes = await notesApp();
    const other = await personApi("user");
    await notes.builder.api.apps.members.add(notes.app, {
      type: "person",
      id: other.userId,
      role: "user",
    });
    const builders = await tokenFor(notes.builder.session, notes.app);
    const others = await tokenFor(other.session, notes.app);
    const network = hostNetwork();
    let current: string | null = null;
    const client = portableClient(() => current);
    const { api } = notes;

    await expect(
      failureOf(client.query(api.list, { pagination: {} }))
    ).resolves.toStrictEqual({
      code: "auth.unauthenticated",
      category: "authorization",
    });
    expect(network.sent).toHaveLength(0);

    current = builders;
    await client.mutation(api.create, { title: "Builder's own" });
    const titles = async () => {
      const page = await client.query(api.list, { pagination: {} });
      return page.items.map((note) => note.title);
    };
    const before = await titles();
    // Swapped without signing out between. The client keeps a token until
    // shortly before its expiry, so it sees the swap when it next asks:
    // the call that finds it is refused unsent, and every later one is
    // the new person's alone.
    current = others;
    const kept = await titles();
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 280_000 });
    const raced = await failureOf(titles());
    const after = await titles();
    expect({ before, kept, raced, after }).toStrictEqual({
      before: ["Builder's own"],
      kept: ["Builder's own"],
      raced: { code: "auth.principal_changed", category: "authorization" },
      after: [],
    });
  });

  it("verifies only with keys that could still have signed a current token, and deletes the rest", async () => {
    const notes = await notesApp();
    const token = await tokenFor(notes.builder.session, notes.app);
    // Each step as a fresh isolate sees it: one holding no keys yet.
    const stopped = async (agoMs: number) => {
      await env.DB.prepare("UPDATE jwks SET expires_at = ?")
        .bind(Date.now() - agoMs)
        .run();
      return await statusOf(listWith(notes, token, { ...env }));
    };
    // Stopped signing a minute ago: a token it signed may still be current.
    const recently = await stopped(60_000);
    // Stopped longer ago than a token lives: whatever it signed is over.
    const long = await stopped(6 * 60_000);
    const before = await env.DB.prepare(
      "SELECT count(*) AS keys FROM jwks"
    ).first<{
      keys: number;
    }>();
    await sweepTokenKeys(env, new Date());
    const after = await env.DB.prepare(
      "SELECT count(*) AS keys FROM jwks"
    ).first<{
      keys: number;
    }>();
    expect({
      recently,
      long,
      before: before?.keys,
      after: after?.keys,
    }).toStrictEqual({ recently: 200, long: 401, before: 1, after: 0 });
    // A fresh token signs with a fresh key.
    const fresh = await tokenFor(notes.builder.session, notes.app, {
      ...env,
    });
    await expect(statusOf(listWith(notes, fresh, { ...env }))).resolves.toBe(
      200
    );
  });

  it("reads the token keys once a minute an isolate, not once a token, however many are forged", async () => {
    const notes = await notesApp();
    const token = await tokenFor(notes.builder.session, notes.app);
    const [header, claims] = token.split(".");
    const isolate = countingKeyReads();
    // All within the few seconds an unknown key waits to be read again.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    const statuses: number[] = [];
    // Tokens under a real key's header, signed by nobody; ones naming
    // keys nobody made; ones whose key isn't a string; and ones whose
    // header only a lenient decoder reads (a length of 1 mod 4).
    for (let forged = 0; forged < 10; forged += 1) {
      const madeUp = headerOf({ alg: "EdDSA", kid: `made-up-${forged}` });
      const numeric = headerOf({ alg: "EdDSA", kid: forged + 1 });
      const lenient = `${lenientHeader(forged)}A`;
      for (const sent of [
        `${header}.${claims}.c2lnbmVk`,
        `${madeUp}.${claims}.c2lnbmVk`,
        `${numeric}.${claims}.c2lnbmVk`,
        `${lenient}.${claims}.c2lnbmVk`,
      ]) {
        // oxlint-disable-next-line no-await-in-loop -- one request after another
        statuses.push(await statusOf(listWith(notes, sent, isolate.coreEnv)));
      }
    }
    // A genuine token verifies all the same, with the keys held.
    statuses.push(await statusOf(listWith(notes, token, isolate.coreEnv)));
    expect({
      // Refused, or told to try again for a key it may not hold yet.
      refused: statuses
        .slice(0, -1)
        .every((status) => status === 401 || status === 503),
      genuine: statuses.at(-1),
      reads: isolate.reads(),
    }).toStrictEqual({ refused: true, genuine: 200, reads: 1 });
  });

  it("tells a token's holder to try again, not to sign in, when its key was made seconds ago in another isolate", async () => {
    const notes = await notesApp();
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    const first = await tokenFor(notes.builder.session, notes.app);
    // An isolate that read the keys just now.
    const isolate = { ...env };
    const before = await statusOf(listWith(notes, first, isolate));
    // The key stops signing, and another isolate signs with a new one.
    await env.DB.prepare("UPDATE jwks SET expires_at = ?")
      .bind(Date.now() - 1000)
      .run();
    const second = await tokenFor(notes.builder.session, notes.app, {
      ...env,
    });
    const soon = await refusalOf(await listWith(notes, second, isolate));
    vi.setSystemTime(Date.now() + 5000);
    const later = await statusOf(listWith(notes, second, isolate));
    expect({ before, soon, later }).toStrictEqual({
      before: 200,
      soon: { status: 503, code: "auth.token_unavailable" },
      later: 200,
    });
  });

  it("records portable use only for a call it reads, never one past the size a call may be", async () => {
    const notes = await notesApp();
    const token = await tokenFor(notes.builder.session, notes.app);
    const head = await logHead();
    const tooLarge = requestFor(notes, "notes.create", {
      title: "x".repeat(functionRequestMaxBytes),
    });
    const status = await statusOf(
      postPortable(notes.app, tooLarge, { authorization: `Bearer ${token}` })
    );
    const events = await eventsAfter(head);
    expect({
      status,
      used: events.filter(({ action }) => action === "app.portable.called"),
    }).toStrictEqual({ status: 413, used: [] });
  });

  it("refuses a token the same keys signed that isn't typed as an App token", async () => {
    const notes = await notesApp();
    const token = await tokenFor(notes.builder.session, notes.app);
    const auth = authFor(env, signInConfig(env));
    if (auth === undefined) {
      throw new Error("Sign-in isn't configured");
    }
    const { sub, sid } = claimsOf(token);
    const { token: untyped } = await auth.api.signJWT({
      body: { payload: { sub, sid, app: notes.app } },
    });
    await expect(
      refusalOf(await listWith(notes, untyped))
    ).resolves.toStrictEqual({ status: 401, code: "auth.unauthenticated" });
  });

  it("records portable use once a window with its session, and logs refused genuine tokens, boundedly", async () => {
    const notes = await notesApp();
    const other = await notesApp();
    const token = await tokenFor(notes.builder.session, notes.app);
    const head = await logHead();
    await expect(statusOf(listWith(notes, token))).resolves.toBe(200);
    await expect(statusOf(listWith(notes, token))).resolves.toBe(200);
    const events = await eventsAfter(head);
    const used = events.filter(
      ({ action }) => action === "app.portable.called"
    );
    expect(used).toMatchObject([
      {
        actor: { type: "person", userId: notes.builder.userId },
        target: { type: "app", id: notes.app },
        detail: { session: claimsOf(token).sid },
      },
    ]);

    const warned = vi.spyOn(console, "warn");
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    vi.setSystemTime(Math.ceil(Date.now() / 60_000) * 60_000 + 1000);
    const elsewhere = requestFor(other, "notes.list", { pagination: {} });
    for (let attempt = 0; attempt < 25; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one request after another
      await postPortable(other.app, elsewhere, {
        authorization: `Bearer ${token}`,
      });
    }
    vi.setSystemTime(Date.now() + 60_000);
    await callAuth("/sign-out", notes.builder.session, {});
    await postPortable(
      notes.app,
      requestFor(notes, "notes.list", { pagination: {} }),
      {
        authorization: `Bearer ${token}`,
      }
    );
    const lines = warned.mock.calls
      .map((call): unknown => call[0])
      .filter(
        (line): line is { event: string; reason?: string; count?: number } =>
          typeof line === "object" &&
          line !== null &&
          String(Reflect.get(line, "event")).startsWith(
            "portable.token_refused"
          )
      );
    expect({
      anotherApp: lines.filter(({ reason }) => reason === "another_app").length,
      dropped: lines.find(
        ({ event }) => event === "portable.token_refused.dropped"
      )?.count,
      sessionEnded: lines.filter(({ reason }) => reason === "session_ended")
        .length,
    }).toStrictEqual({ anotherApp: 20, dropped: 5, sessionEnded: 1 });
  });

  it("answers a failure checking a token readably cross-site", async () => {
    const notes = await notesApp();
    const token = await tokenFor(notes.builder.session, notes.app);
    // Sessions can't be read: the token's keys can, its session can't.
    const broken = new Proxy(env.DB, {
      get: (target, property): unknown =>
        property === "prepare"
          ? (query: string) => {
              if (query.includes('"sessions"')) {
                throw new Error("D1 is down");
              }
              return target.prepare(query);
            }
          : Reflect.get(target, property),
    });
    const response = await routed(
      `${portableFunctionPath}/${notes.app}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: requestFor(notes, "notes.list", { pagination: {} }),
      },
      { ...env, DB: broken }
    );
    expect({
      status: response.status,
      origin: response.headers.get("access-control-allow-origin"),
      code: errorPayloadSchema.parse(await response.json()).code,
    }).toStrictEqual({ status: 500, origin: "*", code: "internal.unexpected" });
  });
});
