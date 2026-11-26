import type { ConnectionPerson } from "@grasp-os/shared/connect";
import { toBase64Url } from "@grasp-os/shared/encoding";
import { env, exports } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { connections, connectionTokens } from "../src/db/schema.ts";
import { auditEvents, outcome, someone } from "./connect.ts";
import {
  sampleCookieHost,
  sampleCookieName,
} from "./fixtures/sample-cookie-connector.ts";
import {
  sampleLoginApiHost,
  sampleLoginFilesHost,
  sampleLoginPath,
} from "./fixtures/sample-login-connector.ts";
import { fakeInternet, json } from "./internet.ts";
import { fakeProviders } from "./oauth-provider.ts";
import { callTool } from "./tool-calls.ts";

// A connector's sign-in with a call (`auth.login`, GRA-2326), attacks
// first. Threat model on GRA-2306, section 6 (LG1 to LG9), and how each
// can fail, or be made to:
//
// SL1  The session reaches a host it isn't for: a second host of the
//      connector's, or one a cookie's Domain names.
// SL2  The password or the session reaches connector code: the login's
//      answer, a rotated cookie, an echo of the session in a header, or
//      connector code making the login itself.
// SL3  A field breaks out of its place in the body: a password holding
//      quotes, braces or a placeholder; a form's `&`.
// SL4  The login is sent, or its fields follow, where it redirects.
// SL5  A session replayed after sign-out: by connect after a disconnect,
//      or after the vendor refused it.
// SL6  Logins without end: a vendor refusing every session, many calls
//      at once with a password changed at the vendor (a lockout), a
//      vendor that can't answer, a write sent twice.
// SL7  An expiry that keeps a session too long, or has every call log in.
// SL8  The fields or the session in the audit log or the logs.

const password = "correct horse";

/** The vendor, as each test sets it up. */
interface Vendor {
  password: string;
  /** Sessions it takes now. */
  sessions: Set<string>;
  /** Each login's body, as it came. */
  logins: string[];
  /** Every session it answered a login with. */
  issued: string[];
  /** How the login answers instead, when a test says so. */
  login?: () => Response;
  /** How the orders answer instead, when a test says so. */
  orders?: () => Response;
  /** What its login's answer says of how long the session lasts. */
  expiresIn?: number | string;
  /** The session its next login answers with. */
  next: () => string;
}

const vendor: Vendor = {
  password,
  sessions: new Set(),
  logins: [],
  issued: [],
  next: () => `session-${crypto.randomUUID()}`,
};

const orders = [{ id: "order-1", title: "First" }];

const loginAnswer = async (request: Request): Promise<Response> => {
  const body = await request.text();
  vendor.logins.push(body);
  if (vendor.login !== undefined) {
    return vendor.login();
  }
  const sent = z.object({ password: z.string() }).parse(JSON.parse(body));
  if (sent.password !== vendor.password) {
    return json({ message: "Wrong user name or password" }, 401);
  }
  const token = vendor.next();
  vendor.sessions.add(token);
  vendor.issued.push(token);
  return json({
    token,
    ...(vendor.expiresIn === undefined ? {} : { expires_in: vendor.expiresIn }),
  });
};

const cookieLoginAnswer = async (request: Request): Promise<Response> => {
  const form = new URLSearchParams(await request.text());
  vendor.logins.push(form.toString());
  if (vendor.login !== undefined) {
    return vendor.login();
  }
  if (form.get("secret") !== vendor.password) {
    return json({ message: "Unauthorized" }, 401);
  }
  const token = vendor.next();
  vendor.sessions.add(token);
  vendor.issued.push(token);
  const headers = new Headers();
  headers.append("set-cookie", "tracking=1; Path=/");
  headers.append(
    "set-cookie",
    `${sampleCookieName}=${token}; Domain=evil.test; Path=/admin; HttpOnly`
  );
  return new Response(null, { status: 204, headers });
};

const sessionOf = (request: Request): string => {
  const cookie = request.headers.get("cookie");
  if (cookie !== null) {
    return cookie.slice(`${sampleCookieName}=`.length);
  }
  return (request.headers.get("authorization") ?? "").slice("Bearer ".length);
};

fakeProviders();
const internet = fakeInternet(async (request, url) => {
  if (url.hostname === sampleLoginApiHost && url.pathname === sampleLoginPath) {
    return await loginAnswer(request);
  }
  if (url.hostname === sampleCookieHost && url.pathname === "/session/login") {
    return await cookieLoginAnswer(request);
  }
  if (url.hostname === sampleLoginFilesHost) {
    return json({ items: [] });
  }
  if (!vendor.sessions.has(sessionOf(request))) {
    return json({ message: "Session expired" }, 401);
  }
  if (vendor.orders !== undefined) {
    return vendor.orders();
  }
  if (request.method === "POST") {
    return json({ id: "order-2", title: "Second" });
  }
  const headers = new Headers({ "x-echo": `Bearer ${sessionOf(request)}` });
  headers.append("set-cookie", `${sampleCookieName}=rotated; Path=/`);
  return Response.json({ items: orders }, { headers });
});
const audit = auditEvents();

/**
 * Connects the app as a shared connection, as an account of its own (tests
 * share the database), with `given` as its password.
 */
const connect = async (
  person: ConnectionPerson,
  provider: "sample-login" | "sample-cookie" = "sample-login",
  given = password
): Promise<string> => {
  const user = `erp-${crypto.randomUUID()}`;
  const fields: Record<string, string> =
    provider === "sample-login"
      ? { userName: user, password: given }
      : { user, secret: given };
  const { connectionId } = await exports.default.connectWithKey({
    person,
    provider,
    scope: "shared",
    fields,
  });
  return connectionId;
};

const call = async (
  id: string,
  person: ConnectionPerson,
  action: string,
  input: Record<string, string> = {}
) =>
  await callTool({ id, person }, action, input, {
    idempotencyKey: crypto.randomUUID(),
  });

const output = (result: { output: string }): unknown =>
  JSON.parse(result.output);

/** The session's row, as stored. */
const tokenRow = async (id: string) =>
  await drizzle(env.DB)
    .select()
    .from(connectionTokens)
    .where(eq(connectionTokens.connectionId, id))
    .get();

/**
 * Makes the connection's session older than a session refused moments
 * after its login (which isn't logged in for again), as time would.
 */
const age = async (id: string): Promise<void> => {
  await drizzle(env.DB)
    .update(connectionTokens)
    .set({ updatedAt: new Date(Date.now() - 3 * 60_000) })
    .where(eq(connectionTokens.connectionId, id));
};

/** Makes the connection's session run out, as time would. */
const expire = async (id: string): Promise<void> => {
  await drizzle(env.DB)
    .update(connectionTokens)
    .set({ accessExpiresAt: new Date(0) })
    .where(eq(connectionTokens.connectionId, id));
};

const statusOf = async (id: string) => {
  const row = await drizzle(env.DB)
    .select({ status: connections.status })
    .from(connections)
    .where(eq(connections.id, id))
    .get();
  return row?.status;
};

/** The sessions each request to the vendor's API carried, in order. */
const sentSessions = (): string[] =>
  internet.sent
    .filter(({ path }) => path !== sampleLoginPath && path !== "/session/login")
    .map(({ headers }) =>
      (headers.authorization ?? headers.cookie ?? "").replace(/^\S+[ =]/u, "")
    );

const actionsOf = async () => {
  const events = await audit.events();
  return events
    .filter(({ action }) => action !== "connection.call")
    .map(({ action, detail }) => ({ action, detail }));
};

/** Each event's action, and the reason it gives. */
const reasonsOf = async () => {
  const events = await actionsOf();
  return events.map(({ action, detail }) => [action, detail?.reason]);
};

const loginBodySchema = z.object({
  userName: z.string(),
  password: z.string(),
  remember: z.boolean(),
});

/** A login's JSON body, its user name only as whether it is a test's own. */
const loginBody = (index: number) => {
  const body = loginBodySchema.parse(
    JSON.parse(vendor.logins[index] ?? "null")
  );
  return { ...body, userName: body.userName.startsWith("erp-") };
};

/** A JWT that says it expires at `exp`, in seconds since the epoch. */
const jwtUntil = (exp: number): string =>
  [{ alg: "none" }, { sub: "erp-user", exp }]
    .map((part) => toBase64Url(new TextEncoder().encode(JSON.stringify(part))))
    .join(".")
    .concat(".signature");

describe("a connector's sign-in with a call", () => {
  beforeEach(() => {
    vendor.password = password;
    vendor.sessions.clear();
    vendor.logins.length = 0;
    vendor.issued.length = 0;
    vendor.login = undefined;
    vendor.orders = undefined;
    vendor.expiresIn = 3600;
    vendor.next = () => `session-${crypto.randomUUID()}`;
  });

  it("logs in with the fields, holds them and the session sealed, sends the session to its API alone, and audits the sign-in once", async () => {
    const person = someone("admin");
    const id = await connect(person);
    const listed = await call(id, person, "orders.list");
    await call(id, person, "files.list");
    const row = await tokenRow(id);
    const [session] = vendor.sessions;

    expect({
      login: internet.sent.find(({ path }) => path === sampleLoginPath),
      login_body: loginBody(0),
      listed: output(listed),
      sent: internet.sent
        .filter(({ path }) => path !== sampleLoginPath)
        .map(({ host, headers }) => ({
          host,
          authorization: headers.authorization,
        })),
      sealed: [password, session ?? "none"].some(
        (secret) => row?.sealed.includes(secret) === true
      ),
      events: await actionsOf(),
    }).toMatchObject({
      login: {
        method: "POST",
        host: sampleLoginApiHost,
        headers: { "content-type": "application/json" },
      },
      login_body: { userName: true, password, remember: false },
      listed: { items: orders, next: null },
      sent: [
        { host: sampleLoginApiHost, authorization: `Bearer ${session}` },
        { host: sampleLoginFilesHost, authorization: undefined },
      ],
      sealed: false,
      events: [
        {
          action: "connection.connect",
          detail: { provider: "sample-login", scope: "shared", outcome: "ok" },
        },
      ],
    });
  });

  it("SL1: sends a cookie session as its one cookie to its host, whatever Domain or Path the vendor set, and never another cookie", async () => {
    const person = someone("admin");
    const id = await connect(person, "sample-cookie");
    await call(id, person, "orders.list");
    const [session] = vendor.sessions;

    expect({
      login: internet.sent.filter(({ path }) => path === "/session/login")
        .length,
      calls: internet.sent
        .filter(({ path }) => path !== "/session/login")
        .map(({ host, path, headers }) => ({
          host,
          path,
          cookie: headers.cookie,
        })),
    }).toStrictEqual({
      login: 1,
      calls: [
        {
          host: sampleCookieHost,
          path: "/session/orders",
          cookie: `${sampleCookieName}=${session}`,
        },
      ],
    });
  });

  it("SL2: keeps the login, a rotated cookie and an echoed session from connector code, which can't make the login itself", async () => {
    const person = someone("admin");
    const id = await connect(person);
    const read = z
      .object({ headers: z.string() })
      .parse(output(await call(id, person, "orders.headers")));
    const own = z
      .object({ status: z.number() })
      .parse(
        output(await call(id, person, "orders.probe", { password: "guess" }))
      );
    await call(id, person, "orders.list");
    const [session = "none"] = vendor.sessions;

    expect({
      cookie:
        read.headers.includes("set-cookie") || read.headers.includes("rotated"),
      session: read.headers.includes(session),
      echo: z
        .array(z.array(z.string()))
        .parse(JSON.parse(read.headers))
        .find(([name]) => name === "x-echo"),
      own,
      logins: vendor.logins.length,
      sessions: [...new Set(sentSessions())],
    }).toStrictEqual({
      cookie: false,
      session: false,
      echo: ["x-echo", "[credential]"],
      own: { status: 403 },
      logins: 1,
      // The cookie a call's answer set never took the session's place.
      sessions: [session],
    });
  });

  it("SL3: sends each field whole, as JSON or a form, whatever it holds", async () => {
    const tricky = String.raw`"},{"x":"{token}\"&secret=x&user=admin`;
    vendor.password = tricky;
    await connect(someone("admin"), "sample-login", tricky);
    await connect(someone("admin"), "sample-cookie", tricky);

    expect({
      json: loginBody(0),
      form: [...new URLSearchParams(vendor.logins[1])].map(([name, value]) => [
        name,
        name === "user" ? value.startsWith("erp-") : value,
      ]),
    }).toStrictEqual({
      json: { userName: true, password: tricky, remember: false },
      form: [
        ["user", true],
        ["secret", tricky],
        ["client", "grasp"],
      ],
    });
  });

  it("SL4: follows no redirect from the login, and connects nothing", async () => {
    vendor.login = () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://evil.test/steal" },
      });
    const person = someone("admin");
    const result = await outcome(connect(person));

    expect({
      result,
      hosts: internet.sent.map(({ host }) => host),
      events: await actionsOf(),
    }).toMatchObject({
      result: "connection.provider_unavailable",
      hosts: [sampleLoginApiHost],
      events: [
        {
          action: "connection.connect",
          detail: { reason: "connection.provider_unavailable" },
        },
      ],
    });
  });

  it("SL5: never sends a session again once the connection is disconnected, or once the vendor refused it", async () => {
    const person = someone("admin");
    const id = await connect(person);
    const [first = ""] = vendor.sessions;
    // The vendor signs the session out: the next read logs in again and
    // is sent again with the new session, and so is every call after it.
    await age(id);
    vendor.sessions.delete(first);
    const listed = await call(id, person, "orders.list");
    await call(id, person, "orders.list");
    const [second = ""] = vendor.sessions;
    await exports.default.disconnect({ person, connectionId: id });
    const after = await outcome(call(id, person, "orders.list"));

    expect({
      listed: output(listed),
      sessions: sentSessions(),
      after,
      logins: vendor.logins.length,
      events: await reasonsOf(),
    }).toStrictEqual({
      listed: { items: orders, next: null },
      sessions: [first, second, second],
      after: "connect.connection_inactive",
      logins: 2,
      events: [
        ["connection.connect", undefined],
        ["connection.session_renewed", "refused"],
        ["connection.disconnect", undefined],
      ],
    });
  });

  it("SL6: logs in again at most once in two minutes when the vendor refuses every session, and never sends a write again", async () => {
    const person = someone("admin");
    const id = await connect(person);
    await age(id);
    vendor.orders = () => json({ message: "Session expired" }, 401);
    await outcome(call(id, person, "orders.list"));
    const readSent = internet.sent.filter(
      ({ method }) => method === "GET"
    ).length;
    await outcome(call(id, person, "orders.create", { title: "x" }));

    expect({
      readSent,
      logins: vendor.logins.length,
      writes: internet.sent.filter(
        ({ method, path }) => method === "POST" && path !== sampleLoginPath
      ).length,
      status: await statusOf(id),
    }).toStrictEqual({
      // The read, and once more with the new session.
      readSent: 2,
      // The sign-in, then once: the new session was refused moments after.
      logins: 2,
      writes: 1,
      status: "active",
    });
  });

  it("SL6: makes one login for twenty calls at once refused the same session, and sends each read again with it", async () => {
    const person = someone("admin");
    const id = await connect(person);
    await age(id);
    vendor.sessions.clear();
    const results = await Promise.all(
      Array.from(
        { length: 20 },
        async () => await outcome(call(id, person, "orders.list"))
      )
    );

    expect({
      results: new Set(results),
      logins: vendor.logins.length,
      events: await reasonsOf(),
    }).toStrictEqual({
      results: new Set([undefined]),
      logins: 2,
      events: [
        ["connection.connect", undefined],
        ["connection.session_renewed", "refused"],
      ],
    });
  });

  it("SL6: sends a write after a read that logged in again with the new session", async () => {
    const person = someone("admin");
    const id = await connect(person);
    const [first = ""] = vendor.sessions;
    await age(id);
    vendor.sessions.clear();
    const copied = await call(id, person, "orders.duplicate");
    const [second = ""] = vendor.sessions;

    expect({
      copied: output(copied),
      sessions: sentSessions(),
      logins: vendor.logins.length,
    }).toStrictEqual({
      copied: { id: "order-2", title: "Second" },
      sessions: [first, second, second],
      logins: 2,
    });
  });

  it("SL6: makes one login for twenty calls at once whose password changed at the vendor, and then needs a person to give it again", async () => {
    const person = someone("admin");
    const id = await connect(person);
    vendor.password = "changed at the vendor";
    await expire(id);
    const results = await Promise.all(
      Array.from(
        { length: 20 },
        async () => await outcome(call(id, person, "orders.list"))
      )
    );
    const later = await outcome(call(id, person, "orders.list"));

    expect({
      results: new Set(results),
      later,
      logins: vendor.logins.length,
      status: await statusOf(id),
      fields: await tokenRow(id),
      events: await reasonsOf(),
    }).toStrictEqual({
      results: new Set(["connect.connection_inactive"]),
      later: "connect.connection_inactive",
      logins: 2,
      status: "needs_reauth",
      fields: undefined,
      events: [
        ["connection.connect", undefined],
        ["connection.needs_reauth", "login_refused"],
      ],
    });
  });

  it("SL6: backs off when the vendor can't answer the login, for as long as it asks, without another login", async () => {
    const person = someone("admin");
    const id = await connect(person);
    vendor.login = () =>
      new Response(null, { status: 503, headers: { "retry-after": "120" } });
    await expire(id);
    const first = await outcome(call(id, person, "orders.list"));
    const second = await outcome(call(id, person, "orders.list"));
    const row = await tokenRow(id);

    expect({
      first,
      second,
      logins: vendor.logins.length,
      status: await statusOf(id),
      paused: (row?.pausedUntil?.getTime() ?? 0) > Date.now() + 100_000,
    }).toStrictEqual({
      first: "connect.rate_limited",
      second: "connect.rate_limited",
      logins: 2,
      status: "active",
      paused: true,
    });
  });

  it("SL6: keeps the fields when a renewal is answered with a redirect or no session, and backs off", async () => {
    const person = someone("admin");
    const redirected = await connect(person);
    const empty = await connect(person);
    vendor.login = () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://status.sample-login.test/" },
      });
    await expire(redirected);
    const afterRedirect = await outcome(
      call(redirected, person, "orders.list")
    );
    vendor.login = () => json({ message: "Maintenance" });
    await expire(empty);
    const afterEmpty = await outcome(call(empty, person, "orders.list"));

    expect({
      results: [afterRedirect, afterEmpty],
      statuses: [await statusOf(redirected), await statusOf(empty)],
      kept: [
        (await tokenRow(redirected)) !== undefined,
        (await tokenRow(empty)) !== undefined,
      ],
    }).toStrictEqual({
      results: ["connect.rate_limited", "connect.rate_limited"],
      statuses: ["active", "active"],
      kept: [true, true],
    });
  });

  it("SL7: keeps a session as long as the answer says, or its JWT, within two minutes and a day, and logs in again once it runs out", async () => {
    const person = someone("admin");
    const lasts = async (): Promise<number> => {
      const row = await tokenRow(await connect(person));
      return Math.round(
        ((row?.accessExpiresAt.getTime() ?? 0) - Date.now()) / 60_000
      );
    };
    vendor.expiresIn = 600;
    const stated = await lasts();
    vendor.expiresIn = "900";
    const written = await lasts();
    vendor.expiresIn = 5;
    const short = await lasts();
    vendor.expiresIn = undefined;
    vendor.next = () => jwtUntil(Math.floor(Date.now() / 1000) + 3600);
    const hourJwt = await lasts();
    vendor.next = () =>
      jwtUntil(Math.floor(Date.now() / 1000) + 30 * 24 * 3600);
    const farJwt = await lasts();
    vendor.next = () => `plain-${crypto.randomUUID()}`;
    const none = await lasts();

    const id = await connect(person);
    await expire(id);
    await call(id, person, "orders.list");
    await call(id, person, "orders.list");
    const events = await actionsOf();

    expect({
      minutes: { stated, written, short, hourJwt, farJwt, none },
      logins: vendor.logins.length,
      renewed: events
        .filter(({ action }) => action === "connection.session_renewed")
        .map(({ detail }) => detail),
    }).toStrictEqual({
      minutes: {
        stated: 10,
        written: 15,
        short: 2,
        hourJwt: 60,
        farJwt: 24 * 60,
        none: 24 * 60,
      },
      logins: 8,
      renewed: [{ provider: "sample-login", reason: "expired" }],
    });
  });

  it("SL8: writes neither the fields nor a session to the audit log or the logs", async () => {
    const logged: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(JSON.stringify(args));
      });
    }
    const person = someone("admin");
    const id = await connect(person);
    await age(id);
    vendor.sessions.clear();
    await call(id, person, "orders.list");
    await expire(id);
    vendor.password = "a-new-password";
    await outcome(call(id, person, "orders.list"));
    const written = JSON.stringify(await audit.events());

    expect({
      logged: logged.length > 0,
      leaked: [password, "a-new-password", ...vendor.issued].filter(
        (secret) =>
          written.includes(secret) ||
          logged.some((line) => line.includes(secret))
      ),
    }).toStrictEqual({ logged: true, leaked: [] });
  });
});
