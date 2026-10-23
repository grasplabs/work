/**
 * The local stack `vp run dev` runs, as the seed reaches it: people sign in
 * through the product, as e2e/people.ts does, and act over `/rpc` with
 * their own session; what an API can't backdate is written straight into
 * the stack's local state, as core's tests write to D1.
 */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { CoreApi } from "@grasp-os/shared/rpc";
import { newWebSocketRpcSession } from "capnweb";
import type { RpcStub } from "capnweb";

import { localIdpOrigin } from "../../apps/core/test/sign-in-config.ts";

/**
 * The frontend `vp run dev` serves, which sends `/api` and `/rpc` on to
 * core: the origin sign-in is configured for (scripts/dev.ts). Never read
 * from the environment, so the seed can't be pointed anywhere else.
 */
export const origin = "http://localhost:5173";

const root = path.join(import.meta.dirname, "../..");

/** Where `vp run dev` keeps core's and connect's state (apps/core's dev script). */
export const stateDir = path.resolve(
  root,
  "apps/core",
  process.env.DEV_PERSIST_TO ?? ".wrangler/state"
);

const sessionCookie = "__Host-grasp.session_token";

/** The `name=value` pairs a response sets, as a `Cookie` header. */
const cookiesOf = (response: Response): string =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0] ?? "")
    .join("; ");

const locationOf = (response: Response, step: string): string => {
  const location = response.headers.get("location");
  if (location === null) {
    throw new Error(`${step} did not redirect (${response.status})`);
  }
  return location;
};

/**
 * Signs in as `email` the way a browser does, and returns the session
 * cookie's value. Refuses to go on unless core sends the browser to the
 * fake IdP on this machine: core does that only for a local stack
 * (`devIdpOrigin` in apps/core/src/auth/config.ts), so a deployed core,
 * or anything else answering here, is never seeded.
 */
export const signInAs = async (
  email: string,
  {
    providerId = "microsoft",
    signal,
  }: {
    /** Grasp's own tenant (`grasp-staff`) for the stack's staff member. */
    providerId?: "microsoft" | "grasp-staff";
    /** Aborts each request of the sign-in, for a caller with a deadline. */
    signal?: AbortSignal;
  } = {}
): Promise<string> => {
  let started: Response;
  try {
    started = await fetch(new URL("/api/auth/sign-in/sso", origin), {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      signal,
      body: JSON.stringify({
        providerId,
        callbackURL: "/",
        errorCallbackURL: "/",
        loginHint: email,
      }),
    });
  } catch {
    throw new Error(
      `Nothing answers at ${origin}. Start the local stack with \`vp run dev\` first.`
    );
  }
  const body: unknown = await started.json();
  if (
    !started.ok ||
    typeof body !== "object" ||
    body === null ||
    !("url" in body) ||
    typeof body.url !== "string"
  ) {
    throw new Error(`Sign-in as ${email} did not start (${started.status})`);
  }
  if (new URL(body.url).origin !== localIdpOrigin) {
    throw new Error(
      `Core at ${origin} signs people in at ${new URL(body.url).origin}, not the local fake IdP: the seed only fills the stack \`vp run dev\` runs.`
    );
  }
  const atIdp = await fetch(body.url, { redirect: "manual", signal });
  const finished = await fetch(locationOf(atIdp, "The IdP"), {
    redirect: "manual",
    signal,
    headers: { cookie: cookiesOf(started) },
  });
  const session = cookiesOf(finished)
    .split("; ")
    .find((pair) => pair.startsWith(`${sessionCookie}=`));
  if (session === undefined) {
    throw new Error(
      `Sign-in as ${email} refused: ${locationOf(finished, "Core")}`
    );
  }
  return decodeURIComponent(session.slice(sessionCookie.length + 1));
};

/** The `Cookie` header of a session. */
export const cookieHeader = (cookie: string): string =>
  `${sessionCookie}=${encodeURIComponent(cookie)}`;

/** A connection to `/rpc` from Node, with the session cookie. */
const rpcSocket = (cookie: string): WebSocket => {
  const url = new URL("/rpc", origin);
  url.protocol = "ws:";
  const headers = { origin, cookie: cookieHeader(cookie) };
  // Node's WebSocket (undici) takes headers, which a browser's doesn't.
  return new WebSocket(url, { headers });
};

export type Api = ReturnType<RpcStub<CoreApi>["authenticate"]>;

/** Someone signed in, with their API over `/rpc`. */
export interface Session {
  email: string;
  userId: string;
  cookie: string;
  api: Api;
  close: () => void;
}

/** Signs `email` in and opens their API; through Grasp's tenant for the stack's staff member. */
export const sessionOf = async (
  email: string,
  { providerId }: { providerId?: "microsoft" | "grasp-staff" } = {}
): Promise<Session> => {
  const cookie = await signInAs(email, { providerId });
  const core = newWebSocketRpcSession<CoreApi>(rpcSocket(cookie));
  const api = core.authenticate();
  const { userId } = await api.whoami();
  return {
    email,
    userId,
    cookie,
    api,
    close: () => {
      core[Symbol.dispose]();
    },
  };
};

/**
 * Calls one of Better Auth's endpoints under `/api/auth` as the session's
 * person, as the frontend's auth client does: how admins manage teams.
 */
export const authCall = async (
  session: Pick<Session, "cookie">,
  endpoint: string,
  body?: unknown
): Promise<unknown> => {
  const response = await fetch(new URL(`/api/auth${endpoint}`, origin), {
    method: body === undefined ? "GET" : "POST",
    headers: {
      origin,
      cookie: cookieHeader(session.cookie),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    throw new Error(
      `${endpoint} failed (${response.status}): ${await response.text()}`
    );
  }
  return await response.json();
};

/** How long a write waits for workerd to let go of a database. */
const busyTimeoutMs = 10_000;

/** The SQLite files under a folder of the local state, if it exists. */
const sqliteFiles = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.endsWith(".sqlite"))
        .map((name) => path.join(dir, name))
    : [];

const open = (file: string): DatabaseSync => {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  return db;
};

const hasTable = (db: DatabaseSync, table: string): boolean =>
  db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) !== undefined;

/**
 * The local D1 database that has `table`: core's (`workflow_runs`) or
 * Knowledge's (`collections`), as Miniflare keeps them, one file each.
 */
export const localD1 = (table: string): DatabaseSync => {
  const dir = path.join(stateDir, "v3/d1/miniflare-D1DatabaseObject");
  for (const file of sqliteFiles(dir)) {
    const db = open(file);
    if (hasTable(db, table)) {
      return db;
    }
    db.close();
  }
  throw new Error(
    `No local database with \`${table}\` under ${dir}: is \`vp run dev\` running from this checkout?`
  );
};

/**
 * The storage of the Durable Object of core's class `className` that has a
 * row `id` in `table`: Miniflare names each object's file by its ID,
 * which the seed can't derive from the object's name, so it looks.
 */
export const localObject = (
  className: string,
  table: string,
  id: string
): DatabaseSync => {
  const dir = path.join(stateDir, `v3/do/grasp-os-core-${className}`);
  for (const file of sqliteFiles(dir)) {
    const db = open(file);
    if (
      hasTable(db, table) &&
      db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id) !== undefined
    ) {
      return db;
    }
    db.close();
  }
  throw new Error(`No ${className} object under ${dir} holds ${table} ${id}`);
};
