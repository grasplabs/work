import type { AuditEvent } from "@grasp-os/shared/audit";
import { env } from "cloudflare:workers";
import { vi } from "vite-plus/test";

import { recallAs } from "../src/brain-next.ts";
import { runSync } from "../src/brain-sync.ts";
import type { Budget } from "../src/brain-sync.ts";
import { allEvents } from "./audit-events.ts";
import { consentCode } from "./connect-providers.ts";
import { driveSyncControlUrl } from "./drive-sync-fake.ts";
import type { DriveFile, DriveWorld } from "./drive-sync-fake.ts";
import { createIdp } from "./fake-idp.ts";
import { sampleSyncControlUrl } from "./sample-sync-fake.ts";
import { acmeTenant, signInConfig } from "./sign-in-config.ts";
import type { signedInApi } from "./sign-in.ts";
import { routed, unique } from "./sign-in.ts";
import { connectDb, testBinding } from "./test-env.ts";

// Native sync's run (src/brain-sync.ts, GRA-1758), through the real
// connect and its Google Workspace connector, with Google Drive mocked at
// its host (test/drive-sync-fake.ts). The ways it can fail come first
// (the threat model on GRA-1758): a page's adds landing before what it
// took away; a sharing change, which moves no timestamp, lost; a file
// deleted while the cursor was lost kept after a relist; a stopped or
// throttled run losing or doubling something; one source holding up the
// others; and a disconnect leaving a copy behind.

/**
 * The fake IdP these files sign in with, made once for them all: each file
 * answers core's calls with it by its own hooks (`mockIdpWith`), as a
 * module loaded once for several files must.
 */
export const idp = createIdp();

/** Signing people in and connecting can be slow on CI. */
export const setUpTime = { timeout: 90_000 };

export const domain = signInConfig.google.hostedDomain;
export const doc = "application/vnd.google-apps.document";
export const budget = { tokens: 2000 };

/** When the clock runs the sync next: its period, a minute. */
export const pollMs = 60_000;

/** A word nothing else holds. */
export const markerOf = (): string => `sync${unique().replaceAll("-", "")}`;

export type Person = Awaited<ReturnType<typeof signedInApi>>;

export const isFetcher = (value: unknown): value is Fetcher =>
  typeof value === "object" && value !== null && "fetch" in value;

/** Sets what `subject`'s Drive holds. */
export const driveHolds = async (subject: string, drive: DriveWorld) => {
  const providers = testBinding("CONNECT_PROVIDERS");
  if (!isFetcher(providers)) {
    throw new TypeError("Expected the providers Worker");
  }
  await providers.fetch(driveSyncControlUrl, {
    method: "POST",
    body: JSON.stringify({ subject, drive }),
  });
};

/**
 * The connections the test under way made (`connectSampleFeed`,
 * `connectDrive`): the only ones whose sources its runs read.
 */
const ours = new Set<string>();

/** A time no fake clock of these tests reaches: a source due then is never due in them. */
const neverDue = Date.parse("2100-01-01T00:00:00.000Z");

/**
 * Parks every source but the test's own (`ours`), due only at `neverDue`.
 * Core's test files share their worker's database (`isolate: false`), and
 * every personal connection any of them made there is a source a run
 * reads; parked, a test's runs read its own connections alone, whatever
 * else lives in the worker.
 */
const parkOthers = async (): Promise<void> => {
  await env.DB.prepare(
    "UPDATE brain_sync_sources SET due_at = ?, relist_at = ? WHERE connection_id NOT IN (SELECT value FROM json_each(?))"
  )
    .bind(neverDue, neverDue, JSON.stringify([...ours]))
    .run();
};

/**
 * Before a file's tests (`beforeAll`): the sources of every connection the
 * worker holds so far listed once, by a run, then parked.
 */
export const parkWorkerSources = async (): Promise<void> => {
  await runSync(env);
  await parkOthers();
};

/** Before each test (`beforeEach`): nothing yet its own, everything else parked. */
export const ownSourcesOnly = async (): Promise<void> => {
  ours.clear();
  await parkOthers();
};

/**
 * `person`'s own Microsoft 365 account connected, read by connect's sample
 * sync connector (built into core's test bundle, test/build-connect.ts),
 * whose change feed is `pages` (test/sample-sync-fake.ts): a mailbox
 * whose items name what they are part of.
 */
export const connectSampleFeed = async (
  person: Person,
  pages: Record<string, unknown>
) => {
  const subject = String(person.person.oid);
  const providers = testBinding("CONNECT_PROVIDERS");
  if (!isFetcher(providers)) {
    throw new TypeError("Expected the providers Worker");
  }
  const post = async (feed: Record<string, unknown>) => {
    await providers.fetch(sampleSyncControlUrl, {
      method: "POST",
      body: JSON.stringify({ subject, pages: feed }),
    });
  };
  await post(pages);
  const { url } = await person.api.connections.start({
    provider: "microsoft",
    scope: "personal",
  });
  const authorization = new URL(url);
  const query = new URLSearchParams({
    code: consentCode(
      authorization,
      acmeTenant,
      subject,
      "openid profile email offline_access User.Read Mail.ReadWrite"
    ),
    state: authorization.searchParams.get("state") ?? "",
  });
  await routed(`/api/connections/callback?${query.toString()}`, {
    headers: { cookie: person.session },
  });
  const listed = await person.api.connections.list();
  const connection = listed.find(
    ({ accountName }) => accountName === `${subject}@acme.test`
  );
  if (connection === undefined) {
    throw new Error(`Expected ${subject}'s connection`);
  }
  // Read by the sample sync connector instead of the suite's own.
  await connectDb()
    .prepare("UPDATE connections SET server = 'sample-sync' WHERE id = ?")
    .bind(connection.id)
    .run();
  /** Replaces the parts of the account's world `parts` names (test/sample-sync-fake.ts). */
  const world = async (parts: Record<string, unknown>) => {
    await providers.fetch(sampleSyncControlUrl, {
      method: "POST",
      body: JSON.stringify({ subject, ...parts }),
    });
  };
  /** The items requests that reached `folder`, each its IDs. */
  const fetchedOf = async (folder: string): Promise<unknown> => {
    const asked = new URLSearchParams({ subject, folder });
    const answer = await providers.fetch(
      `${sampleSyncControlUrl}?${asked.toString()}`
    );
    return await answer.json();
  };
  ours.add(connection.id);
  return { connectionId: connection.id, post, world, fetchedOf };
};

/** A file of a shared site, its readers unread (as a shared drive's are), as a sync item. */
const siteFileOf = (id: string, text: string, version: string) => ({
  gone: false,
  id,
  kind: "file",
  version,
  changedAt: "2026-11-18T09:00:00.000Z",
  title: id,
  content: { type: "text", text },
  readers: null,
  changedBy: null,
  partOf: null,
});

/**
 * Has the account `subject` hold the sites `sites` to pick, each one file
 * with its marker, in its `version`, as the sample sync connector's sync
 * of picked places (`sites`) reads them (test/sample-sync-fake.ts).
 */
export const sitesHeld = async (
  subject: string,
  sites: Record<string, string>,
  version = "1"
): Promise<void> => {
  const providers = testBinding("CONNECT_PROVIDERS");
  if (!isFetcher(providers)) {
    throw new TypeError("Expected the providers Worker");
  }
  await providers.fetch(sampleSyncControlUrl, {
    method: "POST",
    body: JSON.stringify({
      subject,
      sites: Object.keys(sites).map((id) => ({ id, name: id })),
      siteFeeds: Object.fromEntries(
        Object.entries(sites).map(([site, marker]) => [
          site,
          {
            "": {
              changes: [siteFileOf(`${site}-plan`, `Plan ${marker}`, version)],
              next: "1",
              more: false,
            },
            "1": { changes: [], next: "1", more: false },
          },
        ])
      ),
    }),
  });
};

/** Has the account `subject`'s sites `sites` fail every read (500), and the others answer. */
export const sitesFailing = async (
  subject: string,
  sites: readonly string[]
): Promise<void> => {
  const providers = testBinding("CONNECT_PROVIDERS");
  if (!isFetcher(providers)) {
    throw new TypeError("Expected the providers Worker");
  }
  await providers.fetch(sampleSyncControlUrl, {
    method: "POST",
    body: JSON.stringify({ subject, failing: sites }),
  });
};

/**
 * A Microsoft 365 account `admin` connects for the company (GRA-1719),
 * read by the sample sync connector, whose sites to pick are `sites`
 * (`sitesHeld`): its connection, one of the test's own, and the account's
 * subject.
 */
export const connectSharedSites = async (
  admin: Person,
  sites: Record<string, string>
): Promise<{ connectionId: string; subject: string }> => {
  const subject = `shared-${unique()}`;
  await sitesHeld(subject, sites);
  const { url } = await admin.api.connections.start({
    provider: "microsoft",
    scope: "shared",
  });
  const authorization = new URL(url);
  const query = new URLSearchParams({
    code: consentCode(
      authorization,
      acmeTenant,
      subject,
      "openid profile email offline_access User.Read Files.Read.All Sites.Read.All"
    ),
    state: authorization.searchParams.get("state") ?? "",
  });
  await routed(`/api/connections/callback?${query.toString()}`, {
    headers: { cookie: admin.session },
  });
  const listed = await admin.api.connections.list();
  const connection = listed.find(
    ({ accountName }) => accountName === `${subject}@acme.test`
  );
  if (connection === undefined) {
    throw new Error("Expected the shared Microsoft connection");
  }
  // Read by the sample sync connector instead of the suite's own.
  await connectDb()
    .prepare("UPDATE connections SET server = 'sample-sync' WHERE id = ?")
    .bind(connection.id)
    .run();
  ours.add(connection.id);
  return { connectionId: connection.id, subject };
};

/** A message in a mailbox, or a part of one (`partOf`), as a sync item. */
export const mailItem = (
  id: string,
  text: string | null,
  more: {
    kind?: "mail" | "file";
    partOf?: string;
    readers?: unknown;
    version?: string;
  } = {}
) => ({
  gone: false,
  id,
  kind: more.kind ?? "mail",
  version: more.version ?? "1",
  changedAt: "2026-11-12T09:00:00.000Z",
  title: id,
  content: text === null ? null : { type: "text", text },
  readers: more.readers ?? null,
  changedBy: null,
  partOf: more.partOf ?? null,
});

/** A message that went away, as a sync item. */
export const goneItem = (id: string) => ({ gone: true, id, kind: "mail" });

/** A page of a feed: `changes`, read on from `next`, nothing more. */
export const feedPage = (changes: unknown[], next: string) => ({
  changes,
  next,
  more: false,
});

/** A Drive nobody changes: nothing to list, nothing changing. */
export const emptyDrive = (): DriveWorld => ({
  start: "1",
  owned: [],
  changes: { "1": { changes: [], newStartPageToken: "1" } },
  contents: {},
});

/**
 * `person`'s own Google account connected, the one they sign in with,
 * with read access to Drive; its Drive as `drive` says.
 */
export const connectDrive = async (person: Person, drive = emptyDrive()) => {
  // Their own account, the one they sign in with.
  const subject = String(person.person.email).replace(/@.*$/u, "");
  await driveHolds(subject, drive);
  const { url } = await person.api.connections.start({
    provider: "google",
    scope: "personal",
  });
  const authorization = new URL(url);
  const query = new URLSearchParams({
    code: consentCode(
      authorization,
      domain,
      subject,
      "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/drive.readonly"
    ),
    state: authorization.searchParams.get("state") ?? "",
  });
  await routed(`/api/connections/callback?${query.toString()}`, {
    headers: { cookie: person.session },
  });
  const email = `${subject}@${domain}`;
  const listed = await person.api.connections.list();
  const connection = listed.find(({ accountName }) => accountName === email);
  if (connection === undefined) {
    throw new Error(`Expected ${email}'s connection`);
  }
  ours.add(connection.id);
  return { connectionId: connection.id, subject, email };
};

/** A Google Doc the person owns, shared as `permissions`. */
export const docFile = (
  id: string,
  owner: string,
  more: Record<string, unknown> = {}
): DriveFile => ({
  id,
  name: `${id} notes`,
  mimeType: doc,
  modifiedTime: "2026-11-10T09:00:00.000Z",
  version: "1",
  ownedByMe: true,
  lastModifyingUser: { emailAddress: owner },
  permissions: [{ type: "user", role: "owner", emailAddress: owner }],
  ...more,
});

/** Shared with everyone in the company's domain, who can find it. */
export const withDomain = (owner: string) => [
  { type: "user", role: "owner", emailAddress: owner },
  { type: "domain", role: "reader", domain, allowFileDiscovery: true },
];

/** Whether `personId` recalls something holding `marker`, as themselves. */
export const finds = async (
  personId: string,
  marker: string
): Promise<boolean> => {
  const { items } = await recallAs(env, personId, {
    personal: true,
    question: marker,
    budget,
  });
  return items.some(
    ({ found, text }) => found !== "meaning" && text.includes(marker)
  );
};

/** The sync's events about `connectionId`, by action, with their counts. */
export const syncEvents = async (connectionId: string) => {
  const events = await allEvents();
  return events
    .filter(
      (event: AuditEvent) =>
        event.action.startsWith("brain.sync.") &&
        event.target?.type === "connection" &&
        event.target.id === connectionId
    )
    .map(({ action, detail }) => ({ action, detail }));
};

/** The time the clock's next run of the sync is at, `ms` from the last. */
let at = Date.now();

/** The fake clock's time now, as the last `later` set it. */
export const clockAt = (): number => at;

export const later = (ms: number): void => {
  at = Math.max(at, Date.now()) + ms;
};

/** Runs the sync as the clock does, at the fake clock's time, on `given`. */
export const syncOn = async (given: Env): Promise<void> => {
  await parkOthers();
  vi.useFakeTimers({ toFake: ["Date"], now: clockAt() });
  try {
    await runSync(given);
  } finally {
    vi.useRealTimers();
  }
};

/** Another run, inside one under way, a poll later: as overlapping runs meet. */
export const overlappingRun = async (): Promise<void> => {
  later(pollMs);
  vi.setSystemTime(clockAt());
  await parkOthers();
  await runSync(env);
};

/** The hold of a removal for a move (`hold`), as its statement starts. */
export const holdStatement =
  /^update "brain_sync_items" set "held_since" = \?/u;

/** An item claimed by a page (`claim`). */
export const claimStatement = /^insert into "brain_sync_items"/u;

/** A dropped place's erase taking its rows' keys (`eraseDroppedPlace`). */
export const takeKeysStatement = /"leaving" = "brain_sync_items"\."key"/u;

/** A delete of synced items: a dropped place's page of rows, or a disconnect's. */
export const deleteItemsStatement = /^delete from "brain_sync_items"/u;

/** A page's commit: its source's cursor moved (`commit`). */
export const commitStatement = /^update "brain_sync_sources" set "cursor"/u;

/** Due at once: the daily listing of `connectionId`'s folders. */
export const listFoldersNow = async (connectionId: string): Promise<void> => {
  await env.DB.prepare(
    "UPDATE brain_sync_sources SET due_at = 0 WHERE connection_id = ? AND place = ':places'"
  )
    .bind(connectionId)
    .run();
};

/** The end of a dropped place's erase: its source deleted (`eraseDroppedPlace`). */
export const placeGoneStatement = /^delete from "brain_sync_sources"/u;

/** An item taken out (`leave`): the key it leaves named. */
export const leaveStatement =
  /^update "brain_sync_items" set .*"leaving" = \?/u;

/**
 * Runs the sync as the clock does at `time`, a time of the test's own
 * rather than the shared clock's, with `given` to spend: the test's own
 * sources alone.
 */
export const syncAt = async (time: number, given?: Budget): Promise<void> => {
  await parkOthers();
  vi.useFakeTimers({ toFake: ["Date"], now: time });
  try {
    await runSync(env, given);
  } finally {
    vi.useRealTimers();
  }
};

/** Runs the sync as the clock does, at the fake clock's time. */
export const sync = async (): Promise<void> => {
  await parkOthers();
  vi.useFakeTimers({ toFake: ["Date"], now: clockAt() });
  try {
    await runSync(env);
  } finally {
    vi.useRealTimers();
  }
};
