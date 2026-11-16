/**
 * Connections for end-to-end tests. Connecting one goes to Microsoft or
 * Composio, which a local stack can't reach, and its dev server can't point
 * connect's calls out at a fake, so this writes what a finished connection
 * leaves behind straight into connect's local database: the connection
 * rows only, with no tokens, which nothing here uses. The flows themselves,
 * through a fake Entra and Composio, are core's tests
 * (apps/core/test/connections.test.ts). Written in one write once the
 * connections scene's people are signed in, for each attempt; tests only
 * look theirs up.
 */
import { test } from "@playwright/test";
import { z } from "zod";

import type { Cast } from "./people.ts";
import { origin } from "./stack.ts";

export const quoted = (text: string): string =>
  `'${text.replaceAll("'", "''")}'`;

/**
 * Each Worker's local database, by the ID the dev server keeps it under:
 * core's has no ID of its own locally, so it goes by its binding, `DB`;
 * connect's by its `preview_database_id` (apps/connect/wrangler.jsonc).
 */
const databases = {
  core: "DB",
  connect: "grasp-os-connect",
} as const;

/** What the dev server's D1 API answers a query, as far as this reads. */
const answerSchema = z.object({
  success: z.boolean(),
  errors: z.array(z.object({ message: z.string() })),
});

/** `text` parsed as JSON, or null when it isn't JSON. */
const jsonOrNull = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/**
 * Runs SQL on connect's local database (or core's), as one batch in one
 * transaction, through the dev server's own D1 API (miniflare's local
 * explorer): on the database objects core and connect use, one query after
 * another. A second runtime on the stack's state (`wrangler d1 execute
 * --local`) held the database file's lock while it wrote, and whatever the
 * dev server asked of that database meanwhile failed with SQLITE_BUSY: a
 * sign-in of a test running beside it among them (merge queue, November
 * 2026).
 */
export const execute = async (
  sql: string,
  worker: keyof typeof databases = "connect"
): Promise<void> => {
  const response = await fetch(
    new URL(
      `/cdn-cgi/local/explorer/api/d1/database/${databases[worker]}/raw`,
      origin
    ),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sql }),
    }
  );
  const body = await response.text();
  // Anything but the API's own JSON (the explorer turned off, or core's
  // 404 for a path it doesn't know) fails with what came back.
  const answer = answerSchema.safeParse(jsonOrNull(body));
  if (!response.ok || !answer.success || !answer.data.success) {
    const said = answer.success
      ? answer.data.errors.map(({ message }) => message).join("; ")
      : body;
    throw new Error(
      `SQL on ${worker}'s local database failed (${response.status}): ${said}`
    );
  }
};

export interface SeededConnection {
  id: string;
  /** Its account at the provider, unique to the attempt. */
  account: string;
}

/** The connections scene's connections (e2e/people.ts), for one attempt. */
export interface SeededConnections {
  /** The user's own Microsoft 365 account, active. */
  mine: SeededConnection;
  /** Another account of theirs, whose access ran out (`needs_reauth`). */
  expired: SeededConnection;
  /** A shared Microsoft 365 mailbox, which the admin connected. */
  mailbox: SeededConnection;
  /** A Composio toolkit, HubSpot, which the admin connected with consent. */
  toolkit: SeededConnection;
}

/** The tools the admin allowed on the seeded toolkit. */
export const seededTools = ["HUBSPOT_LIST_CONTACTS"];

/** How `seedConnections` hands the connections to the test workers. */
const seededVariable = "E2E_CONNECTIONS";

/** A value for SQL: quoted, or NULL. */
const value = (text: string | null): string =>
  text === null ? "NULL" : quoted(text);

interface Row {
  connection: SeededConnection;
  provider: string;
  scope: "personal" | "shared";
  owner: string | null;
  status: "active" | "needs_reauth";
  connectedBy: string;
}

/** A finished connection's row, as connect writes it. */
const insert = (
  { connection, provider, scope, owner, status, connectedBy }: Row,
  now: number
): string => {
  const composio = provider === "hubspot";
  const server = composio
    ? `https://backend.composio.dev/v3/mcp/${connection.id}?user_id=e2e`
    : "microsoft-365";
  return `INSERT INTO connections (id, provider, scope, owner_user_id, status, server_kind, server, account_id, account_name, connected_by, tools, created_at, updated_at) VALUES (${[
    quoted(connection.id),
    quoted(provider),
    quoted(scope),
    value(owner),
    quoted(status),
    quoted(composio ? "composio" : "native"),
    quoted(server),
    quoted(`account-${connection.id}`),
    quoted(connection.account),
    quoted(connectedBy),
    value(composio ? JSON.stringify(seededTools) : null),
    String(now),
    String(now),
  ].join(", ")})`;
};

/** A new connection's ID, with its account. */
const newConnection = (account: string): SeededConnection => ({
  id: crypto.randomUUID(),
  account,
});

/** The connections seeded so far, by attempt. */
const seededSoFar = (): (SeededConnections | null)[] => {
  const json = process.env[seededVariable];
  if (json === undefined) {
    return [];
  }
  // SAFETY: seedConnections wrote it, by attempt.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return JSON.parse(json) as (SeededConnections | null)[];
};

/**
 * Writes the connections scene's connections for one attempt's cast
 * (`scenes`), in one write, once that scene's people are signed in
 * (`fileCast`, e2e/contexts.ts).
 */
export const seedConnections = async (
  scenes: Cast[number],
  attempt: number
): Promise<void> => {
  const admin = scenes.connections?.admin;
  const user = scenes.connections?.user;
  if (admin === undefined || user === undefined) {
    throw new Error("Nobody is signed in for the connections scene");
  }
  // Accounts are unique to an attempt, so each finds its own.
  const tag = crypto.randomUUID().slice(0, 8);
  const connections: SeededConnections = {
    mine: newConnection(`mine-${tag}@acme.test`),
    expired: newConnection(`expired-${tag}@acme.test`),
    mailbox: newConnection(`mailbox-${tag}@acme.test`),
    toolkit: newConnection(`hubspot-${tag}`),
  };
  const personal = {
    provider: "microsoft",
    scope: "personal",
    owner: user.userId,
    connectedBy: user.userId,
  } as const;
  const shared = {
    scope: "shared",
    owner: null,
    status: "active",
    connectedBy: admin.userId,
  } as const;
  const rows: Row[] = [
    { ...personal, connection: connections.mine, status: "active" },
    { ...personal, connection: connections.expired, status: "needs_reauth" },
    { ...shared, connection: connections.mailbox, provider: "microsoft" },
    { ...shared, connection: connections.toolkit, provider: "hubspot" },
  ];
  const now = Date.now();
  await execute(rows.map((row) => insert(row, now)).join("; "));
  const seeded = seededSoFar();
  while (seeded.length < attempt) {
    seeded.push(null);
  }
  seeded[attempt] = connections;
  // Playwright hands the global setup's environment to the test workers.
  process.env[seededVariable] = JSON.stringify(seeded);
};

/** The connections scene's connections, for this attempt at the test. */
export const seededConnections = (): SeededConnections => {
  const { retry } = test.info();
  const seeded = seededSoFar()[retry];
  if (seeded === undefined || seeded === null) {
    throw new Error(
      `No connections for attempt ${retry + 1}: fileCast writes them once the file's connections scene is signed in`
    );
  }
  return seeded;
};
