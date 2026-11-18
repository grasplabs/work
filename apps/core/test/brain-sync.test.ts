import type { AuditEvent } from "@grasp-os/shared/audit";
import { minTeamShown } from "@grasp-os/shared/onboarding";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { drainAuditOutboxes } from "../src/audit-drains.ts";
import { eraseSource, recallAs } from "../src/brain-next.ts";
import { overdueRelists, runSync } from "../src/brain-sync.ts";
import { allEvents } from "./audit-events.ts";
import { newTeam } from "./brain-next-leaks-harness.ts";
import { inStoreOf } from "./brain-next-out-reads.ts";
import { consentCode } from "./connect-providers.ts";
import { countingBinds } from "./counting-binds.ts";
import { interleaving } from "./d1-interleaving.ts";
import { driveSyncControlUrl } from "./drive-sync-fake.ts";
import type { DriveFile, DriveWorld } from "./drive-sync-fake.ts";
import { mockIdp } from "./idp.ts";
import { sampleSyncControlUrl } from "./sample-sync-fake.ts";
import { acmeTenant, signInConfig } from "./sign-in-config.ts";
import { routed, signedInApi, signedInWithRole, unique } from "./sign-in.ts";
import { connectDb, testBinding } from "./test-env.ts";

// Native sync's run (src/brain-sync.ts, GRA-1758), through the real
// connect and its Google Workspace connector, with Google Drive mocked at
// its host (test/drive-sync-fake.ts). The ways it can fail come first
// (the threat model on GRA-1758): a page's adds landing before what it
// took away; a sharing change, which moves no timestamp, lost; a file
// deleted while the cursor was lost kept after a relist; a stopped or
// throttled run losing or doubling something; one source holding up the
// others; and a disconnect leaving a copy behind.

const idp = mockIdp();

/** Signing people in and connecting can be slow on CI. */
const setUpTime = { timeout: 90_000 };

const domain = signInConfig.google.hostedDomain;
const doc = "application/vnd.google-apps.document";
const budget = { tokens: 2000 };

/** When the clock runs the sync next: its period, a minute. */
const pollMs = 60_000;

/** A word nothing else holds. */
const markerOf = (): string => `sync${unique().replaceAll("-", "")}`;

type Person = Awaited<ReturnType<typeof signedInApi>>;

const isFetcher = (value: unknown): value is Fetcher =>
  typeof value === "object" && value !== null && "fetch" in value;

/** Sets what `subject`'s Drive holds. */
const driveHolds = async (subject: string, drive: DriveWorld) => {
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
 * `person`'s own Microsoft 365 account connected, read by connect's sample
 * sync connector (built into core's test bundle, test/build-connect.ts),
 * whose change feed is `pages` (test/sample-sync-fake.ts): a mailbox
 * whose items name what they are part of.
 */
const connectSampleFeed = async (
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
  return { connectionId: connection.id, post, world, fetchedOf };
};

/** A message in a mailbox, or a part of one (`partOf`), as a sync item. */
const mailItem = (
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
const goneItem = (id: string) => ({ gone: true, id, kind: "mail" });

/** A page of a feed: `changes`, read on from `next`, nothing more. */
const feedPage = (changes: unknown[], next: string) => ({
  changes,
  next,
  more: false,
});

/** A Drive nobody changes: nothing to list, nothing changing. */
const emptyDrive = (): DriveWorld => ({
  start: "1",
  owned: [],
  changes: { "1": { changes: [], newStartPageToken: "1" } },
  contents: {},
});

/**
 * `person`'s own Google account connected, the one they sign in with,
 * with read access to Drive; its Drive as `drive` says.
 */
const connectDrive = async (person: Person, drive = emptyDrive()) => {
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
  return { connectionId: connection.id, subject, email };
};

/** A Google Doc the person owns, shared as `permissions`. */
const docFile = (
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
const withDomain = (owner: string) => [
  { type: "user", role: "owner", emailAddress: owner },
  { type: "domain", role: "reader", domain, allowFileDiscovery: true },
];

/** Whether `personId` recalls something holding `marker`, as themselves. */
const finds = async (personId: string, marker: string): Promise<boolean> => {
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
const syncEvents = async (connectionId: string) => {
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
let clockAt = Date.now();
const later = (ms: number): void => {
  clockAt = Math.max(clockAt, Date.now()) + ms;
};

/** Runs the sync as the clock does, at the fake clock's time, on `given`. */
const syncOn = async (given: Env): Promise<void> => {
  vi.useFakeTimers({ toFake: ["Date"], now: clockAt });
  try {
    await runSync(given);
  } finally {
    vi.useRealTimers();
  }
};

/** Another run, inside one under way, a poll later: as overlapping runs meet. */
const overlappingRun = async (): Promise<void> => {
  later(pollMs);
  vi.setSystemTime(clockAt);
  await runSync(env);
};

/** The hold of a removal for a move (`hold`), as its statement starts. */
const holdStatement = /^update "brain_sync_items" set "held_since" = \?/u;

/** An item claimed by a page (`claim`). */
const claimStatement = /^insert into "brain_sync_items"/u;

/** The end of a dropped place's erase: its source deleted (`eraseDroppedPlace`). */
const placeGoneStatement = /^delete from "brain_sync_sources"/u;

/** An item taken out (`leave`): the key it leaves named. */
const leaveStatement = /^update "brain_sync_items" set .*"leaving" = \?/u;

/** Runs the sync as the clock does, at the fake clock's time. */
const sync = async (): Promise<void> => {
  vi.useFakeTimers({ toFake: ["Date"], now: clockAt });
  try {
    await runSync(env);
  } finally {
    vi.useRealTimers();
  }
};

describe("native sync", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it(
    "finishes an erase a stopped run owed, even while the provider fails every read",
    setUpTime,
    async () => {
      const owner = await signedInApi(idp, "user");
      const marker = markerOf();
      const { connectionId, post, world } = await connectSampleFeed(owner, {
        "": feedPage([mailItem("memo", `Memo ${marker}`)], "m1"),
        m1: feedPage([], "m1"),
      });
      later(pollMs);
      await sync();
      await post({
        "": feedPage([mailItem("memo", `Memo ${marker}`)], "m1"),
        m1: feedPage([goneItem("memo")], "m2"),
        m2: feedPage([], "m2"),
      });
      // Runs stopped at each step in turn, until one stops between the
      // removal's record and its erase: all at one time, so a source whose
      // page is done isn't due again, and each run's stop moves on by a call.
      // First in the file, so no other test's sources share these runs.
      let owed = false;
      later(pollMs);
      for (let left = 4; left < 80 && !owed; left += 1) {
        vi.useFakeTimers({ toFake: ["Date"], now: clockAt });
        try {
          // oxlint-disable-next-line no-await-in-loop -- one run after another
          await runSync(env, { left });
        } finally {
          vi.useRealTimers();
        }
        // oxlint-disable-next-line no-await-in-loop -- read after each run
        const leaving = await env.DB.prepare(
          "SELECT count(*) AS count FROM brain_sync_items WHERE connection_id = ? AND leaving IS NOT NULL"
        )
          .bind(connectionId)
          .first<{ count: number }>();
        owed = (leaving?.count ?? 0) > 0;
      }
      const owedFound = await finds(owner.userId, marker);
      // The provider fails every read from now on.
      await world({ failing: ["files"] });
      later(pollMs);
      await sync();

      expect({
        owed,
        owedFound,
        after: await finds(owner.userId, marker),
      }).toStrictEqual({ owed: true, owedFound: true, after: false });
    }
  );

  it(
    "brings a person's own Drive in on the first run, then only what changed, each where its readers may read it",
    setUpTime,
    async () => {
      const [owner, colleague] = await Promise.all([
        signedInApi(idp, "user"),
        signedInApi(idp, "user"),
      ]);
      // The colleague holds the company's Google domain by their own
      // connection: what the domain may read is theirs to read.
      await connectDrive(colleague);
      const [mine, everyones, added] = [markerOf(), markerOf(), markerOf()];
      const { connectionId, subject, email } = await connectDrive(owner);
      await driveHolds(subject, {
        start: "10",
        owned: [
          docFile("private", email),
          docFile("handbook", email, { permissions: withDomain(email) }),
        ],
        changes: { "10": { changes: [], newStartPageToken: "10" } },
        contents: {
          private: `Salary bands ${mine}`,
          handbook: `Travel policy ${everyones}`,
        },
      });
      later(pollMs);
      await sync();
      const first = {
        ownerMine: await finds(owner.userId, mine),
        ownerEveryones: await finds(owner.userId, everyones),
        colleagueMine: await finds(colleague.userId, mine),
        colleagueEveryones: await finds(colleague.userId, everyones),
      };

      // A file made since: the change feed brings it, and only it.
      await driveHolds(subject, {
        start: "10",
        owned: [],
        changes: {
          "10": {
            changes: [
              {
                fileId: "new",
                time: "2026-11-11T09:00:00.000Z",
                file: docFile("new", email),
              },
            ],
            newStartPageToken: "11",
          },
          "11": { changes: [], newStartPageToken: "11" },
        },
        contents: { new: `Offsite plan ${added}` },
      });
      later(pollMs);
      await sync();

      expect({
        first,
        later: await finds(owner.userId, added),
        events: await syncEvents(connectionId),
      }).toStrictEqual({
        first: {
          ownerMine: true,
          ownerEveryones: true,
          colleagueMine: false,
          colleagueEveryones: true,
        },
        later: true,
        events: [
          {
            action: "brain.sync.applied",
            detail: {
              feed: "drive",
              added: 2,
              changed: 0,
              removed: 0,
              skipped: 0,
            },
          },
          {
            action: "brain.sync.applied",
            detail: {
              feed: "drive",
              added: 1,
              changed: 0,
              removed: 0,
              skipped: 0,
            },
          },
        ],
      });
    }
  );

  it(
    "takes an unshared or deleted file away at the next run, though a sharing change moves no timestamp",
    setUpTime,
    async () => {
      const [owner, colleague] = await Promise.all([
        signedInApi(idp, "user"),
        signedInApi(idp, "user"),
      ]);
      await connectDrive(colleague);
      const [narrowed, unshared, deleted] = [
        markerOf(),
        markerOf(),
        markerOf(),
      ];
      const { subject, email } = await connectDrive(owner);
      const group = {
        type: "group",
        role: "reader",
        emailAddress: `sales@${domain}`,
      };
      const files = {
        narrowed: docFile("narrowed", email, {
          permissions: [...withDomain(email), group],
        }),
        unshared: docFile("unshared", email, {
          permissions: withDomain(email),
        }),
        deleted: docFile("deleted", email, { permissions: withDomain(email) }),
      };
      const contents = {
        narrowed: `Price list ${narrowed}`,
        unshared: `Board deck ${unshared}`,
        deleted: `Old roadmap ${deleted}`,
      };
      await driveHolds(subject, {
        start: "20",
        owned: Object.values(files),
        changes: { "20": { changes: [], newStartPageToken: "20" } },
        contents,
      });
      later(pollMs);
      await sync();
      const before = await Promise.all(
        [narrowed, unshared, deleted].map(
          async (marker) => await finds(colleague.userId, marker)
        )
      );

      // The same version and time, other readers: the domain taken off one
      // (a group, which no one holds yet, stays), the other kept for its
      // owner alone; and one deleted.
      const at = "2026-11-10T09:00:00.000Z";
      await driveHolds(subject, {
        start: "20",
        owned: [],
        changes: {
          "20": {
            changes: [
              {
                fileId: "narrowed",
                time: at,
                file: {
                  ...files.narrowed,
                  permissions: [
                    { type: "user", role: "owner", emailAddress: email },
                    group,
                  ],
                },
              },
              {
                fileId: "unshared",
                time: at,
                file: docFile("unshared", email),
              },
              { fileId: "deleted", time: at, removed: true },
            ],
            newStartPageToken: "21",
          },
          "21": { changes: [], newStartPageToken: "21" },
        },
        contents,
      });
      // Within one poll interval and one run.
      later(pollMs);
      await sync();

      expect({
        before,
        colleague: await Promise.all(
          [narrowed, unshared, deleted].map(
            async (marker) => await finds(colleague.userId, marker)
          )
        ),
        owner: await Promise.all(
          [narrowed, unshared, deleted].map(
            async (marker) => await finds(owner.userId, marker)
          )
        ),
      }).toStrictEqual({
        before: [true, true, true],
        colleague: [false, false, false],
        owner: [true, true, false],
      });
    }
  );

  it(
    "applies a page stopped part-way at any point exactly once, from the same cursor",
    setUpTime,
    async () => {
      const owner = await signedInApi(idp, "user");
      const { connectionId, subject, email } = await connectDrive(owner);
      const markers = [markerOf(), markerOf(), markerOf(), markerOf()];
      await driveHolds(subject, {
        start: "30",
        owned: markers.map((_, index) =>
          docFile(
            `file${index}`,
            email,
            index % 2 === 0 ? { permissions: withDomain(email) } : {}
          )
        ),
        changes: { "30": { changes: [], newStartPageToken: "30" } },
        contents: Object.fromEntries(
          markers.map((marker, index) => [`file${index}`, `Memo ${marker}`])
        ),
      });
      later(pollMs);
      // Runs whose budgets run out at every step of the page in turn: a
      // Brain write done, its record or the cursor not yet.
      for (let left = 6; left < 40; left += 1) {
        vi.useFakeTimers({ toFake: ["Date"], now: clockAt });
        try {
          // oxlint-disable-next-line no-await-in-loop -- one run after another, as the clock runs them
          await runSync(env, { left });
        } finally {
          vi.useRealTimers();
        }
      }
      await sync();
      const events = await syncEvents(connectionId);
      const applied = events.flatMap(({ detail }) =>
        typeof detail.added === "number" ? [detail] : []
      );

      expect({
        found: await Promise.all(
          markers.map(async (marker) => await finds(owner.userId, marker))
        ),
        added: applied.reduce((sum, { added }) => sum + Number(added ?? 0), 0),
        changed: applied.reduce(
          (sum, { changed }) => sum + Number(changed ?? 0),
          0
        ),
      }).toStrictEqual({
        found: [true, true, true, true],
        added: markers.length,
        changed: 0,
      });
    }
  );

  it(
    "never shows what a page adds before what the same page took away",
    setUpTime,
    async () => {
      const [owner, colleague] = await Promise.all([
        signedInApi(idp, "user"),
        signedInApi(idp, "user"),
      ]);
      await connectDrive(colleague);
      const { subject, email } = await connectDrive(owner);
      const [unshared, added] = [markerOf(), markerOf()];
      const contents = {
        unshared: `Bonus plan ${unshared}`,
        added: `Holiday rota ${added}`,
      };
      const at = "2026-11-12T09:00:00.000Z";
      const shared = (id: string) => ({
        fileId: id,
        time: at,
        file: docFile(id, email, { permissions: withDomain(email) }),
      });
      const first = 6;
      await driveHolds(subject, {
        start: `s${first}`,
        owned: [docFile("unshared", email, { permissions: withDomain(email) })],
        changes: {
          [`s${first}`]: { changes: [], newStartPageToken: `s${first}` },
        },
        contents,
      });
      later(pollMs);
      await sync();
      // The page stopped at each step in turn, each time from the same
      // state: the file shared with the domain, the new one not there.
      // Its new file comes first in it, the one taken away after.
      const both: number[] = [];
      for (let left = first; left < 24; left += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one step after another
        await driveHolds(subject, {
          start: `s${left}`,
          owned: [],
          changes: {
            [`s${left}`]: {
              changes: [
                shared("unshared"),
                { fileId: "added", time: at, removed: true },
              ],
              newStartPageToken: `m${left}`,
            },
            [`m${left}`]: {
              changes: [
                shared("added"),
                {
                  fileId: "unshared",
                  time: at,
                  file: docFile("unshared", email),
                },
              ],
              newStartPageToken: `s${left + 1}`,
            },
          },
          contents,
        });
        later(pollMs);
        // oxlint-disable-next-line no-await-in-loop -- one step after another
        await sync();
        later(pollMs);
        vi.useFakeTimers({ toFake: ["Date"], now: clockAt });
        try {
          // oxlint-disable-next-line no-await-in-loop -- one step after another
          await runSync(env, { left });
        } finally {
          vi.useRealTimers();
        }
        if (
          // oxlint-disable-next-line no-await-in-loop -- read after each stop
          (await finds(colleague.userId, added)) &&
          // oxlint-disable-next-line no-await-in-loop -- read after each stop
          (await finds(colleague.userId, unshared))
        ) {
          both.push(left);
        }
        later(pollMs);
        // oxlint-disable-next-line no-await-in-loop -- the rest of the page
        await sync();
      }

      expect({
        both,
        end: {
          added: await finds(colleague.userId, added),
          unshared: await finds(colleague.userId, unshared),
        },
      }).toStrictEqual({
        both: [],
        end: { added: true, unshared: false },
      });
    }
  );

  it(
    "takes away a reader removed with no change in the feed, and a file gone the same way, at the daily relist",
    setUpTime,
    async () => {
      const [owner, colleague] = await Promise.all([
        signedInApi(idp, "user"),
        signedInApi(idp, "user"),
      ]);
      await connectDrive(colleague);
      const { subject, email } = await connectDrive(owner);
      const [quiet, vanished] = [markerOf(), markerOf()];
      const contents = {
        quiet: `Pay scales ${quiet}`,
        vanished: `Pitch ${vanished}`,
      };
      const feed = { "80": { changes: [], newStartPageToken: "80" } };
      await driveHolds(subject, {
        start: "80",
        owned: [
          docFile("quiet", email, { permissions: withDomain(email) }),
          docFile("vanished", email),
        ],
        changes: feed,
        contents,
      });
      later(pollMs);
      await sync();
      const before = [
        await finds(colleague.userId, quiet),
        await finds(owner.userId, vanished),
      ];
      // Unshared and deleted at the source, and the feed says nothing.
      await driveHolds(subject, {
        start: "80",
        owned: [docFile("quiet", email)],
        changes: feed,
        contents,
      });
      later(pollMs);
      await sync();
      const noSignal = [
        await finds(colleague.userId, quiet),
        await finds(owner.userId, vanished),
      ];
      // A day on: the relist has read every file and its readers again.
      later(24 * 60 * 60 * 1000);
      await sync();

      expect({
        before,
        noSignal,
        relisted: [
          await finds(colleague.userId, quiet),
          await finds(owner.userId, vanished),
          await finds(owner.userId, quiet),
        ],
      }).toStrictEqual({
        before: [true, true],
        noSignal: [true, true],
        relisted: [false, false, true],
      });
    }
  );

  it(
    "keeps a message and its attachments for its mailbox's person alone, and takes the attachments out with a gone message",
    setUpTime,
    async () => {
      const [owner, colleague] = await Promise.all([
        signedInApi(idp, "user"),
        signedInApi(idp, "user"),
      ]);
      // The colleague holds the company's Microsoft tenant by their own
      // connection.
      const quiet = { changes: [], next: "c", more: false };
      await connectSampleFeed(colleague, { "": quiet, c: quiet });
      const [message, attachment] = [markerOf(), markerOf()];
      const first = {
        changes: [
          mailItem("message", `Invoice due ${message}`),
          // An attachment whose readers would reach the whole tenant, were
          // it not part of a message.
          mailItem("attachment", `Invoice lines ${attachment}`, {
            kind: "file",
            partOf: "message",
            readers: [{ kind: "tenant", id: acmeTenant }],
          }),
        ],
        next: "p2",
        more: false,
      };
      const { post } = await connectSampleFeed(owner, {
        "": first,
        p2: { changes: [], next: "p2", more: false },
      });
      later(pollMs);
      await sync();
      const before = {
        owner: [
          await finds(owner.userId, message),
          await finds(owner.userId, attachment),
        ],
        colleague: await finds(colleague.userId, attachment),
      };
      // The mailbox names the message gone, never its attachment.
      await post({
        "": first,
        p2: {
          changes: [{ gone: true, id: "message", kind: "mail" }],
          next: "p3",
          more: false,
        },
        p3: { changes: [], next: "p3", more: false },
      });
      later(pollMs);
      await sync();

      expect({
        before,
        after: [
          await finds(owner.userId, message),
          await finds(owner.userId, attachment),
        ],
      }).toStrictEqual({
        before: { owner: [true, true], colleague: false },
        after: [false, false],
      });
    }
  );

  it(
    "keeps nothing that names a person or their address past their erasure",
    setUpTime,
    async () => {
      const [admin, person] = await Promise.all([
        signedInApi(idp, "admin"),
        signedInApi(idp, "builder"),
      ]);
      const oid = String(person.person.oid);
      const email = `${oid}@acme.test`;
      const page = {
        changes: [
          mailItem("rota", `Rota ${markerOf()}`, {
            kind: "file",
            readers: [
              { kind: "account", id: oid },
              { kind: "tenant", id: acmeTenant },
            ],
          }),
          mailItem("note", `Note ${markerOf()}`),
        ],
        next: "n",
        more: false,
      };
      await connectSampleFeed(person, {
        "": page,
        n: { changes: [], next: "n", more: false },
      });
      later(pollMs);
      await sync();
      await admin.api.members.remove(person.userId);

      const erased = await admin.api.members.erase(
        person.userId,
        String(person.person.name)
      );
      const naming = await env.DB.prepare(
        `SELECT
          (SELECT count(*) FROM brain_sync_sources WHERE person_id = ?1 OR lower(account) = lower(?2) OR account = ?3)
          + (SELECT count(*) FROM brain_sync_items WHERE instr(lower(coalesce(change, '') || item_id || key || coalesce(part_of, '')), lower(?2)) > 0 OR instr(lower(coalesce(change, '') || item_id || key || coalesce(part_of, '')), lower(?3)) > 0 OR instr(item_id || key, ?1) > 0)
          AS count`
      )
        .bind(person.userId, email, oid)
        .first<{ count: number }>();

      expect({
        connect: erased.areas.find(({ area }) => area === "connect")?.state,
        naming: naming?.count,
      }).toStrictEqual({ connect: "complete", naming: 0 });
    }
  );

  it(
    "finishes the daily relist after a restart in it, while changes go on applying",
    setUpTime,
    async () => {
      const owner = await signedInApi(idp, "user");
      const { subject, email } = await connectDrive(owner);
      const [vanished, added] = [markerOf(), markerOf()];
      const contents = {
        vanished: `Pitch ${vanished}`,
        added: `Memo ${added}`,
      };
      await driveHolds(subject, {
        start: "100",
        owned: [docFile("vanished", email)],
        changes: { "100": { changes: [], newStartPageToken: "100" } },
        contents,
      });
      later(pollMs);
      await sync();
      // Deleted with no signal, which only the relist's end takes out; and
      // the relist's own change feed (from "R") is lost to it once, so it
      // starts again.
      await driveHolds(subject, {
        start: "R",
        owned: [],
        changes: { "100": { changes: [], newStartPageToken: "100" } },
        contents,
      });
      later(24 * 60 * 60 * 1000);
      await sync();
      const afterRestart = await finds(owner.userId, vanished);
      // A change arrives on the ordinary feed meanwhile, and the relist's
      // feed is there again.
      await driveHolds(subject, {
        start: "R",
        owned: [],
        changes: {
          "100": {
            changes: [
              {
                fileId: "added",
                time: "2026-11-13T09:00:00.000Z",
                file: docFile("added", email),
              },
            ],
            newStartPageToken: "101",
          },
          "101": { changes: [], newStartPageToken: "101" },
          R: { changes: [], newStartPageToken: "R" },
        },
        contents,
      });
      later(pollMs);
      await sync();

      expect({
        afterRestart,
        relisted: await finds(owner.userId, vanished),
        change: await finds(owner.userId, added),
      }).toStrictEqual({ afterRestart: true, relisted: false, change: true });
    }
  );

  it(
    "applies a page that removes and passes over, stopped at each step, and takes back what comes again",
    setUpTime,
    async () => {
      const [owner, colleague] = await Promise.all([
        signedInApi(idp, "user"),
        signedInApi(idp, "user"),
      ]);
      const quiet = { changes: [], next: "c", more: false };
      await connectSampleFeed(colleague, { "": quiet, c: quiet });
      const [kept, mail, file, late] = [
        markerOf(),
        markerOf(),
        markerOf(),
        markerOf(),
      ];
      const tenant = [{ kind: "tenant", id: acmeTenant }];
      const shared = (id: string, text: string | null, version = "1") =>
        mailItem(id, text, { kind: "file", readers: tenant, version });
      const first = {
        changes: [
          mailItem("kept", `Kept ${kept}`),
          mailItem("mail", `Mail ${mail}`),
          shared("file", `File ${file}`),
          shared("late", `Late ${late}`),
        ],
        next: "p2",
        more: false,
      };
      const { post } = await connectSampleFeed(owner, {
        "": first,
        p2: { changes: [], next: "p2", more: false },
      });
      later(pollMs);
      await sync();
      // A message and a shared file gone, a file passed over at the
      // version held (its content late): stopped at each step in turn.
      await post({
        "": first,
        p2: {
          changes: [
            { gone: true, id: "mail", kind: "mail" },
            { gone: true, id: "file", kind: "file" },
            shared("late", null),
          ],
          next: "p3",
          more: false,
        },
        p3: { changes: [], next: "p3", more: false },
      });
      later(pollMs);
      for (let left = 6; left < 40; left += 1) {
        vi.useFakeTimers({ toFake: ["Date"], now: clockAt });
        try {
          // oxlint-disable-next-line no-await-in-loop -- one run after another, as the clock runs them
          await runSync(env, { left });
        } finally {
          vi.useRealTimers();
        }
      }
      later(pollMs);
      await sync();
      const removed = {
        mail: await finds(owner.userId, mail),
        file: await finds(colleague.userId, file),
        late: await finds(colleague.userId, late),
        kept: await finds(owner.userId, kept),
      };
      // The message out of the bin as it was, the file at a new version,
      // the late one with its content after all.
      await post({
        "": first,
        p2: { changes: [], next: "p3", more: false },
        p3: {
          changes: [
            mailItem("mail", `Mail ${mail}`),
            shared("file", `File ${file}`, "2"),
            shared("late", `Late ${late}`),
          ],
          next: "p4",
          more: false,
        },
        p4: { changes: [], next: "p4", more: false },
      });
      later(pollMs);
      await sync();

      expect({
        removed,
        back: {
          mail: await finds(owner.userId, mail),
          file: await finds(colleague.userId, file),
          late: await finds(colleague.userId, late),
        },
      }).toStrictEqual({
        removed: { mail: false, file: false, late: true, kept: true },
        back: { mail: true, file: true, late: true },
      });
    }
  );

  it(
    "takes an item back that returns after a removal stopped at any step",
    setUpTime,
    async () => {
      const [owner, colleague] = await Promise.all([
        signedInApi(idp, "user"),
        signedInApi(idp, "user"),
      ]);
      const quiet = { changes: [], next: "c", more: false };
      await connectSampleFeed(colleague, { "": quiet, c: quiet });
      const [mail, file] = [markerOf(), markerOf()];
      const tenant = [{ kind: "tenant", id: acmeTenant }];
      const message = mailItem("mail", `Mail ${mail}`);
      const fileAt = (version: string) =>
        mailItem("file", `File ${file} ${version}`, {
          kind: "file",
          readers: tenant,
          version,
        });
      const first = 6;
      const { post } = await connectSampleFeed(owner, {
        "": { changes: [message, fileAt("1")], next: `c${first}`, more: false },
        [`c${first}`]: { changes: [], next: `c${first}`, more: false },
      });
      later(pollMs);
      await sync();
      // For each step in turn: the message and the file go, the run stops
      // there, and the same position then names them back (the message as
      // it was, out of the bin; the file at a new version).
      const missing: number[] = [];
      for (let left = first; left < 30; left += 1) {
        const at = `c${left}`;
        const next = { changes: [], next: `c${left + 1}`, more: false };
        // oxlint-disable-next-line no-await-in-loop -- one step after another
        await post({
          [at]: {
            changes: [
              { gone: true, id: "mail", kind: "mail" },
              { gone: true, id: "file", kind: "file" },
            ],
            next: `d${left}`,
            more: false,
          },
        });
        later(pollMs);
        vi.useFakeTimers({ toFake: ["Date"], now: clockAt });
        try {
          // oxlint-disable-next-line no-await-in-loop -- one step after another
          await runSync(env, { left });
        } finally {
          vi.useRealTimers();
        }
        const back = {
          changes: [message, fileAt(String(left))],
          next: `c${left + 1}`,
          more: false,
        };
        // oxlint-disable-next-line no-await-in-loop -- one step after another
        await post({ [at]: back, [`d${left}`]: back, [`c${left + 1}`]: next });
        later(pollMs);
        // oxlint-disable-next-line no-await-in-loop -- one step after another
        await sync();
        if (
          // oxlint-disable-next-line no-await-in-loop -- read after each step
          !(await finds(owner.userId, mail)) ||
          // oxlint-disable-next-line no-await-in-loop -- read after each step
          !(await finds(colleague.userId, `${file} ${left}`))
        ) {
          missing.push(left);
        }
      }

      expect(missing).toStrictEqual([]);
    }
  );

  it(
    "adds an item again under its next key when the Brain erased the one it held",
    setUpTime,
    async () => {
      const owner = await signedInApi(idp, "user");
      const marker = markerOf();
      const memo = (version: string) =>
        mailItem("memo", `Memo ${marker} ${version}`, { version });
      const { connectionId, post } = await connectSampleFeed(owner, {
        "": { changes: [memo("1")], next: "e1", more: false },
        e1: { changes: [], next: "e1", more: false },
      });
      later(pollMs);
      await sync();
      // Erased in the Brain from outside the sync (a staff erasure, a
      // restore that replays one): the row still names the key.
      const held = await env.DB.prepare(
        "SELECT key FROM brain_sync_items WHERE connection_id = ? AND item_id = 'memo'"
      )
        .bind(connectionId)
        .first<{ key: string }>();
      await eraseSource(env, {
        source: { producer: "sync", id: held?.key ?? "" },
        readers: { kind: "owner", personId: owner.userId },
        reason: "deleted",
      });
      await post({
        "": { changes: [memo("1")], next: "e1", more: false },
        e1: { changes: [memo("2")], next: "e2", more: false },
        e2: { changes: [], next: "e2", more: false },
      });
      later(pollMs);
      await sync();

      await expect(finds(owner.userId, `${marker} 2`)).resolves.toBeTruthy();
    }
  );

  it(
    "finishes an overdue relist when changes alone would fill every run, and says it is overdue",
    setUpTime,
    async () => {
      const [owner, ...others] = await Promise.all([
        signedInApi(idp, "user"),
        signedInApi(idp, "user"),
        signedInApi(idp, "user"),
        signedInApi(idp, "user"),
      ]);
      for (const other of others) {
        // oxlint-disable-next-line no-await-in-loop -- one connection at a time
        await connectDrive(other);
      }
      const { connectionId, subject, email } = await connectDrive(owner);
      const vanished = markerOf();
      const feed = { "110": { changes: [], newStartPageToken: "110" } };
      await driveHolds(subject, {
        start: "110",
        owned: [docFile("vanished", email)],
        changes: feed,
        contents: { vanished: `Pitch ${vanished}` },
      });
      later(pollMs);
      await sync();
      // Deleted with no signal: only the relist's end takes it out.
      await driveHolds(subject, {
        start: "110",
        owned: [],
        changes: feed,
        contents: {},
      });
      // Two days on, its relist past its day.
      later(2 * 24 * 60 * 60 * 1000);
      vi.useFakeTimers({ toFake: ["Date"], now: clockAt });
      const overdue = await overdueRelists(env);
      vi.useRealTimers();
      const warned: unknown[] = [];
      const spy = vi.spyOn(console, "warn").mockImplementation((...line) => {
        warned.push(line);
      });
      // Runs a call short of reading every source's changes (claim, read,
      // commit each, after the run's own three), a minute apart, until the
      // relist ends: far within its day.
      const sources = await env.DB.prepare(
        "SELECT count(*) AS count FROM brain_sync_sources"
      ).first<{ count: number }>();
      const left = 3 + 3 * (sources?.count ?? 0) - 1;
      let minutes = 0;
      try {
        for (; minutes < 240; minutes += 1) {
          later(pollMs);
          vi.useFakeTimers({ toFake: ["Date"], now: clockAt });
          try {
            // oxlint-disable-next-line no-await-in-loop -- one run after another, as the clock runs them
            await runSync(env, { left });
          } finally {
            vi.useRealTimers();
          }
          // oxlint-disable-next-line no-await-in-loop -- read after each run
          if (!(await finds(owner.userId, vanished))) {
            break;
          }
        }
      } finally {
        spy.mockRestore();
      }

      expect({
        overdue: overdue > 0,
        said: JSON.stringify(warned).includes("brain.sync.relist_overdue"),
        saidOf: JSON.stringify(warned).includes(connectionId),
        relisted: await finds(owner.userId, vanished),
        withinItsDay: minutes < 240,
      }).toStrictEqual({
        overdue: true,
        said: true,
        saidOf: true,
        relisted: false,
        withinItsDay: true,
      });
    }
  );

  it(
    "keeps one source per listed place: a new one from no cursor, a dropped one's copies erased, a failed listing changing nothing",
    setUpTime,
    async () => {
      const owner = await signedInApi(idp, "user");
      const [inboxed, archived] = [markerOf(), markerOf()];
      const quiet = { changes: [], next: "q", more: false };
      const { world } = await connectSampleFeed(owner, { "": quiet, q: quiet });
      const folder = (id: string, text: string) => ({
        changes: {
          "": { changes: [mailItem(id, text)], next: "f1", more: false },
          f1: { changes: [], next: "f1", more: false },
        },
      });
      const folders = {
        inbox: folder("inbox/a", `Invoice ${inboxed}`),
        archive: folder("archive/b", `Contract ${archived}`),
      };
      await world({ places: ["inbox"], folders });
      later(pollMs);
      await sync();
      const first = [
        await finds(owner.userId, inboxed),
        await finds(owner.userId, archived),
      ];
      // A folder made since: seen at the next listing of the folders, a
      // day on (`relistMs`), a new source read from the start.
      await world({ places: ["inbox", "archive"] });
      later(24 * 60 * 60 * 1000);
      await sync();
      later(pollMs);
      await sync();
      const added = await finds(owner.userId, archived);
      // The folders couldn't be listed at the next day's listing: nothing
      // changes.
      await world({ places: null });
      later(24 * 60 * 60 * 1000);
      await sync();
      const failed = [
        await finds(owner.userId, inboxed),
        await finds(owner.userId, archived),
      ];
      // The folder deleted: the listing, tried again at the next run, drops
      // its source, and the clock erases every copy it made.
      await world({ places: ["inbox"] });
      later(pollMs);
      await sync();
      later(pollMs);
      await sync();

      expect({
        first,
        added,
        failed,
        dropped: [
          await finds(owner.userId, inboxed),
          await finds(owner.userId, archived),
        ],
      }).toStrictEqual({
        first: [true, false],
        added: true,
        failed: [true, true],
        dropped: [true, false],
      });
    }
  );

  it(
    "lists the folders again from the start when the connector no longer knows the listing's position, dropping nothing for the abandoned one",
    setUpTime,
    async () => {
      const owner = await signedInApi(idp, "user");
      const marks = { a: markerOf(), b: markerOf(), c: markerOf() };
      const quiet = feedPage([], "q");
      const { world } = await connectSampleFeed(owner, { "": quiet, q: quiet });
      const folder = (name: keyof typeof marks) => ({
        changes: {
          "": feedPage([mailItem(`${name}/x`, `Mail ${marks[name]}`)], "f1"),
          f1: feedPage([], "f1"),
        },
      });
      const folders = { a: folder("a"), b: folder("b"), c: folder("c") };
      // The folders listed over two reads.
      await world({
        placePages: {
          "": { folders: ["a"], next: "t1" },
          t1: { folders: ["b"] },
        },
        folders,
      });
      later(pollMs);
      await sync();
      later(pollMs);
      await sync();
      const first = [
        await finds(owner.userId, marks.a),
        await finds(owner.userId, marks.b),
      ];
      // A day on, the listing gets partway and then the folder list's
      // position is gone: the connector answers "restart".
      await world({
        placePages: { "": { folders: ["a"], next: "t2" } },
      });
      later(24 * 60 * 60 * 1000);
      await sync();
      const abandoned = [
        await finds(owner.userId, marks.a),
        await finds(owner.userId, marks.b),
      ];
      // The next run lists from the start, and finishes: c made, b gone.
      await world({ placePages: { "": { folders: ["a", "c"] } } });
      later(pollMs);
      await sync();
      later(pollMs);
      await sync();

      expect({
        first,
        abandoned,
        after: [
          await finds(owner.userId, marks.a),
          await finds(owner.userId, marks.b),
          await finds(owner.userId, marks.c),
        ],
      }).toStrictEqual({
        first: [true, true],
        abandoned: [true, true],
        after: [true, false, true],
      });
    }
  );

  it(
    "never loses a message moved between two folders for a run, read in either order, and lets a deleted one go",
    setUpTime,
    async () => {
      const owner = await signedInApi(idp, "user");
      const marks = { m: markerOf(), m2: markerOf(), m3: markerOf() };
      const message = (folder: string, name: keyof typeof marks) =>
        mailItem(`${folder}/${name}`, `Mail ${marks[name]}`);
      const quiet = { changes: [], next: "q", more: false };
      const { world } = await connectSampleFeed(owner, { "": quiet, q: quiet });
      // Folder pages by position, each step adding the next.
      const a: Record<string, unknown> = {
        "": feedPage(
          [message("a", "m"), message("a", "m2"), message("a", "m3")],
          "a1"
        ),
        a1: feedPage([], "a1"),
      };
      const b: Record<string, unknown> = {
        "": feedPage([], "b1"),
        b1: feedPage([], "b1"),
      };
      const set = async (failing: string[]) => {
        await world({
          places: ["a", "b"],
          folders: { a: { changes: a }, b: { changes: b } },
          failing,
        });
      };
      await set([]);
      later(pollMs);
      await sync();
      /** Whether the owner reads each message now, after one more run. */
      const run = async () => {
        later(pollMs);
        await sync();
        return {
          m: await finds(owner.userId, marks.m),
          m2: await finds(owner.userId, marks.m2),
          m3: await finds(owner.userId, marks.m3),
        };
      };
      const seen: Record<string, unknown>[] = [];
      // Moved from a to b, a read first: b fails (backing off) meanwhile.
      a.a1 = feedPage([goneItem("a/m")], "a2");
      a.a2 = feedPage([], "a2");
      b.b1 = feedPage([message("b", "m")], "b2");
      b.b2 = feedPage([], "b2");
      await set(["b"]);
      seen.push(await run());
      await set([]);
      seen.push(await run(), await run());
      // Moved from a to b again, b read first: a fails meanwhile.
      a.a2 = feedPage([goneItem("a/m2")], "a3");
      a.a3 = feedPage([], "a3");
      b.b2 = feedPage([message("b", "m2")], "b3");
      b.b3 = feedPage([], "b3");
      await set(["a"]);
      seen.push(await run());
      await set([]);
      seen.push(await run(), await run());
      // Deleted for good from a, nothing new anywhere.
      a.a3 = feedPage([goneItem("a/m3")], "a4");
      a.a4 = feedPage([], "a4");
      await set([]);
      const held = await run();
      const later1 = await run();
      const later2 = await run();

      expect({
        moved: seen.map(({ m, m2 }) => ({ m, m2 })),
        deleted: [held.m3, later2.m3],
        stillThere: [later1.m, later1.m2],
      }).toStrictEqual({
        moved: [
          { m: true, m2: true },
          { m: true, m2: true },
          { m: true, m2: true },
          { m: true, m2: true },
          { m: true, m2: true },
          { m: true, m2: true },
        ],
        deleted: [true, false],
        stillThere: [true, true],
      });
    }
  );

  it(
    "keeps a message that comes back as it was while its removal is held, in the place it left or in another, read in either order",
    setUpTime,
    async () => {
      const owner = await signedInApi(idp, "user");
      const marks = { m1: markerOf(), m2: markerOf(), m3: markerOf() };
      // One ID wherever the message is, as a provider with stable IDs
      // gives it.
      const message = (name: keyof typeof marks) =>
        mailItem(name, `Mail ${marks[name]}`);
      const quiet = { changes: [], next: "q", more: false };
      const { world } = await connectSampleFeed(owner, { "": quiet, q: quiet });
      const a: Record<string, unknown> = {
        "": feedPage([message("m1"), message("m2"), message("m3")], "a1"),
        a1: feedPage([], "a1"),
      };
      const b: Record<string, unknown> = {
        "": feedPage([], "b1"),
        b1: feedPage([], "b1"),
      };
      const set = async (failing: string[]) => {
        await world({
          places: ["a", "b"],
          folders: { a: { changes: a }, b: { changes: b } },
          failing,
        });
      };
      await set([]);
      later(pollMs);
      await sync();
      later(pollMs);
      await sync();
      const run = async () => {
        later(pollMs);
        await sync();
      };
      const found = async () => ({
        m1: await finds(owner.userId, marks.m1),
        m2: await finds(owner.userId, marks.m2),
        m3: await finds(owner.userId, marks.m3),
      });
      // m1 and m2 go from a, b failing: both held.
      a.a1 = feedPage([goneItem("m1"), goneItem("m2")], "a2");
      a.a2 = feedPage([], "a2");
      await set(["b"]);
      await run();
      // m1 comes back to a as it was, while b still fails; then b comes
      // back with m2 as it was, which ends every hold.
      a.a2 = feedPage([message("m1")], "a3");
      a.a3 = feedPage([], "a3");
      b.b1 = feedPage([message("m2")], "b2");
      b.b2 = feedPage([], "b2");
      await run();
      await set([]);
      await run();
      await run();
      await run();
      const returned = await found();
      // m3 moves from a to b, b read first: a fails meanwhile, then names
      // it gone.
      b.b2 = feedPage([message("m3")], "b3");
      b.b3 = feedPage([], "b3");
      await set(["a"]);
      await run();
      a.a3 = feedPage([goneItem("m3")], "a4");
      a.a4 = feedPage([], "a4");
      await set([]);
      await run();
      await run();
      await run();

      expect({ returned, after: await found() }).toStrictEqual({
        returned: { m1: true, m2: true, m3: true },
        after: { m1: true, m2: true, m3: true },
      });
    }
  );

  it(
    "leaves a message another folder brought back between a folder's read of its removal and the hold, the held removal's end, or a relist's sweep",
    setUpTime,
    async () => {
      const owner = await signedInApi(idp, "user");
      const marks = {
        held: markerOf(),
        finished: markerOf(),
        swept: markerOf(),
        kept: markerOf(),
      };
      // One ID wherever the message is.
      const message = (name: keyof typeof marks) =>
        mailItem(name, `Mail ${marks[name]}`);
      const quiet = { changes: [], next: "q", more: false };
      const { world } = await connectSampleFeed(owner, { "": quiet, q: quiet });
      const a: Record<string, unknown> = {
        "": feedPage(
          [
            message("held"),
            message("finished"),
            message("swept"),
            message("kept"),
          ],
          "a1"
        ),
        a1: feedPage([], "a1"),
      };
      const b: Record<string, unknown> = {
        "": feedPage([], "b1"),
        b1: feedPage([], "b1"),
      };
      // The daily names-only listings: a names only `kept`, b what it has.
      const aNames = { "": feedPage([mailItem("kept", null)], "n") };
      const bNames: Record<string, unknown> = { "": feedPage([], "n") };
      const set = async (failing: string[] = []) => {
        await world({
          places: ["a", "b"],
          folders: {
            a: { changes: a, names: aNames, items: {} },
            b: { changes: b, names: bNames, items: {} },
          },
          failing,
        });
      };
      await set();
      later(pollMs);
      await sync();
      later(pollMs);
      await sync();
      const found = async () => ({
        held: await finds(owner.userId, marks.held),
        finished: await finds(owner.userId, marks.finished),
        swept: await finds(owner.userId, marks.swept),
        kept: await finds(owner.userId, marks.kept),
      });
      const runs = async (count: number) => {
        for (let run = 0; run < count; run += 1) {
          later(pollMs);
          // oxlint-disable-next-line no-await-in-loop -- one run after another
          await sync();
        }
      };
      /**
       * b has `name` from its next read on, as a move into it does: once in
       * its changes, at the position its cursor is at, and in its listings.
       */
      const inB: string[] = [];
      let bAt = 1;
      const intoB = async (name: keyof typeof marks) => {
        inB.push(name);
        b[`b${bAt}`] = feedPage([message(name)], `b${bAt + 1}`);
        bAt += 1;
        b[`b${bAt}`] = feedPage([], `b${bAt}`);
        bNames[""] = feedPage(
          inB.map((id) => mailItem(id, null)),
          "n"
        );
        await set();
      };

      // a reads `held` gone; b brings it over before a's hold lands (a is
      // read first: both are due at once).
      a.a1 = feedPage([goneItem("held")], "a2");
      a.a2 = feedPage([], "a2");
      await set();
      later(pollMs);
      await syncOn(
        interleaving(holdStatement, async () => {
          await intoB("held");
          await overlappingRun();
        })
      );
      await runs(4);
      const afterHold = await finds(owner.userId, marks.held);

      // a reads `finished` gone while b fails: held. b comes back empty,
      // which ends the hold; b brings it over before a's end of it lands.
      a.a2 = feedPage([goneItem("finished")], "a3");
      a.a3 = feedPage([], "a3");
      await set(["b"]);
      await runs(1);
      await set();
      await runs(1);
      later(pollMs);
      await syncOn(
        interleaving(leaveStatement, async () => {
          await intoB("finished");
          await overlappingRun();
        })
      );
      await runs(3);
      const afterFinish = await finds(owner.userId, marks.finished);

      // A day on, a's names-only relist doesn't name `swept`; b (failing
      // until then) brings it over before a's sweep takes it out.
      await set(["b"]);
      later(24 * 60 * 60 * 1000);
      await syncOn(
        interleaving(leaveStatement, async () => {
          await intoB("swept");
          await overlappingRun();
        })
      );
      await runs(3);

      expect({ afterHold, afterFinish, end: await found() }).toStrictEqual({
        afterHold: true,
        afterFinish: true,
        end: { held: true, finished: true, swept: true, kept: true },
      });
    }
  );

  it(
    "keeps each synced change as one event for each of the owner's teams of five or more, two teammates' identical copies apart, once however often its page is applied",
    setUpTime,
    async () => {
      const owner = await signedInApi(idp, "user");
      const teammate = await signedInApi(idp, "user");
      const others = await Promise.all(
        Array.from({ length: minTeamShown - 2 }, async () => {
          const { userId } = await signedInWithRole(idp, "user");
          return userId;
        })
      );
      // Five with both of them, and four with the owner alone.
      const [five, four] = await Promise.all([
        newTeam(owner.userId, teammate.userId, ...others),
        newTeam(owner.userId, ...others),
      ]);
      const note = markerOf();
      // Each with a copy of the same file: same ID, title, text, version.
      const feed = {
        "": feedPage(
          [mailItem("note", `Note ${note}`, { kind: "file" })],
          "p1"
        ),
        p1: feedPage([], "p1"),
      };
      const connections = [
        await connectSampleFeed(owner, feed),
        await connectSampleFeed(teammate, feed),
      ];
      const eventsOf = async () =>
        await inStoreOf("brain", (sql) =>
          sql
            .exec<Record<string, SqlStorageValue>>(
              "SELECT team, step, system, writes, item FROM events WHERE team IN (?, ?) ORDER BY team, key",
              `team:${five}`,
              `team:${four}`
            )
            .toArray()
        );
      later(pollMs);
      await sync();
      const kept = await eventsOf();
      // The same pages applied again, from the start.
      for (const { connectionId } of connections) {
        // oxlint-disable-next-line no-await-in-loop -- one connection at a time
        await env.DB.prepare(
          "UPDATE brain_sync_sources SET cursor = NULL WHERE connection_id = ?"
        )
          .bind(connectionId)
          .run();
      }
      later(pollMs);
      await sync();

      expect({
        kept: kept.map(({ team, step, system, writes }) => ({
          team,
          step,
          system,
          writes,
        })),
        itemNamed: kept.every(
          ({ item }) => typeof item === "string" && item !== "note"
        ),
        found: [
          await finds(owner.userId, note),
          await finds(teammate.userId, note),
        ],
        again: await eventsOf(),
      }).toStrictEqual({
        kept: [
          {
            team: `team:${five}`,
            step: "file.added",
            system: "microsoft",
            writes: 0,
          },
          {
            team: `team:${five}`,
            step: "file.added",
            system: "microsoft",
            writes: 0,
          },
        ],
        itemNamed: true,
        found: [true, true],
        again: kept,
      });
    }
  );

  it(
    "relists mail in full from a connector that reads no names or IDs: refreshes what changed past its first page, and asks nothing by ID",
    setUpTime,
    async () => {
      const owner = await signedInApi(idp, "user");
      const marks = {
        kept: markerOf(),
        draft: markerOf(),
        final: markerOf(),
        went: markerOf(),
      };
      const quiet = { changes: [], next: "q", more: false };
      const { world, fetchedOf } = await connectSampleFeed(owner, {
        "": quiet,
        q: quiet,
      });
      const changes: Record<string, unknown> = {
        "": feedPage(
          [
            mailItem("a/kept", `Kept ${marks.kept}`),
            mailItem("a/changed", `Draft ${marks.draft}`),
            mailItem("a/went", `Gone ${marks.went}`),
          ],
          "c1"
        ),
        c1: feedPage([], "c1"),
      };
      const set = async () => {
        await world({
          places: ["a"],
          folders: { a: { changes, ignores: true } },
        });
      };
      await set();
      later(pollMs);
      await sync();
      // The mailbox's listing now: two pages, the change on the second,
      // the message that went in neither.
      changes[""] = {
        changes: [mailItem("a/kept", `Kept ${marks.kept}`)],
        next: "p2",
        more: true,
      };
      changes.p2 = feedPage(
        [mailItem("a/changed", `Final ${marks.final}`, { version: "2" })],
        "c1"
      );
      await set();
      later(24 * 60 * 60 * 1000);
      for (let run = 0; run < 4; run += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one run after another
        await sync();
        later(pollMs);
      }

      expect({
        kept: await finds(owner.userId, marks.kept),
        draft: await finds(owner.userId, marks.draft),
        final: await finds(owner.userId, marks.final),
        went: await finds(owner.userId, marks.went),
        askedById: await fetchedOf("a"),
      }).toStrictEqual({
        kept: true,
        draft: false,
        final: true,
        went: false,
        askedById: [],
      });
    }
  );

  it(
    "fetches by ID only what an answer covers: asks again what a partial answer left, and ends the day's catch-up when an answer covers none of it",
    setUpTime,
    async () => {
      const owner = await signedInApi(idp, "user");
      const marks = { x: markerOf(), y: markerOf(), z: markerOf() };
      const quiet = { changes: [], next: "q", more: false };
      const { world, fetchedOf } = await connectSampleFeed(owner, {
        "": quiet,
        q: quiet,
      });
      const named = (id: string) => mailItem(id, null);
      const day = async () => {
        later(24 * 60 * 60 * 1000);
        for (let run = 0; run < 5; run += 1) {
          // oxlint-disable-next-line no-await-in-loop -- one run after another
          await sync();
          later(pollMs);
        }
      };
      await world({
        places: ["a", "b"],
        folders: {
          // Answers by ID, one at a time.
          a: {
            changes: {
              "": feedPage([mailItem("a/x", `Mail ${marks.x}`)], "c1"),
              c1: feedPage([], "c1"),
            },
            names: {
              "": feedPage([named("a/x"), named("a/y"), named("a/z")], "n"),
            },
            items: {
              "a/y": mailItem("a/y", `Mail ${marks.y}`),
              "a/z": mailItem("a/z", `Mail ${marks.z}`),
            },
            itemsMax: 1,
          },
          // Reads no IDs, and passes its messages over: its listing names
          // `b/later` on a second page, which an ID read never reaches.
          b: {
            changes: {
              "": {
                changes: [named("b/first")],
                next: "p2",
                more: true,
              },
              p2: feedPage([named("b/later")], "p2"),
            },
            ignores: true,
          },
        },
      });
      later(pollMs);
      await sync();
      later(pollMs);
      await sync();
      await day();
      const askedFirstDay = await fetchedOf("b");
      await day();

      expect({
        a: await fetchedOf("a"),
        found: [
          await finds(owner.userId, marks.y),
          await finds(owner.userId, marks.z),
        ],
        // Within a day, never again once an answer covers nothing; still
        // owed the next day.
        bFirstDay: askedFirstDay,
        b: await fetchedOf("b"),
      }).toStrictEqual({
        a: [["a/y", "a/z"], ["a/z"]],
        found: [true, true],
        // Neither held (passed over from the start): both asked; its first
        // page covers `b/first`, so `b/later` is asked again, covered by
        // nothing, and left owed until the next day's.
        bFirstDay: [["b/first", "b/later"], ["b/later"]],
        b: [
          ["b/first", "b/later"],
          ["b/later"],
          ["b/first", "b/later"],
          ["b/later"],
        ],
      });
    }
  );

  it(
    "keeps nothing of a folder dropped while a page of it is under way, the drop landing between the page's read and its claim and the erase ending after it",
    setUpTime,
    async () => {
      const owner = await signedInApi(idp, "user");
      const marks = { old: markerOf(), late: markerOf(), other: markerOf() };
      const quiet = { changes: [], next: "q", more: false };
      const { connectionId, world } = await connectSampleFeed(owner, {
        "": quiet,
        q: quiet,
      });
      const a: Record<string, unknown> = {
        "": feedPage([mailItem("a/old", `Mail ${marks.old}`)], "a1"),
        a1: feedPage([], "a1"),
      };
      const b = {
        "": feedPage([mailItem("b/other", `Mail ${marks.other}`)], "b1"),
        b1: feedPage([], "b1"),
      };
      const set = async (places: string[]) => {
        await world({
          places,
          folders: { a: { changes: a }, b: { changes: b } },
        });
      };
      await set(["a", "b"]);
      later(pollMs);
      await sync();
      later(pollMs);
      await sync();
      // a's next page brings `late`; the folder is deleted meanwhile.
      a.a1 = feedPage([mailItem("a/late", `Mail ${marks.late}`)], "a2");
      a.a2 = feedPage([], "a2");
      await set(["b"]);
      // The page may claim once the erase has found nothing left; the
      // erase goes on once the claim has run.
      const claimMay = Promise.withResolvers<null>();
      const claimDone = Promise.withResolvers<null>();
      let erasing: Promise<void> = Promise.resolve();
      later(pollMs);
      await syncOn(
        interleaving(
          claimStatement,
          async () => {
            // The folder list read without a, as its daily listing does:
            // a dropped.
            await env.DB.prepare(
              "UPDATE brain_sync_sources SET due_at = 0 WHERE connection_id = ? AND place = ':places'"
            )
              .bind(connectionId)
              .run();
            await runSync(env);
            // a's erase, up to its last step: the page's claim lands
            // after it found nothing left, before it deletes the source.
            erasing = runSync(
              interleaving(placeGoneStatement, async () => {
                claimMay.resolve(null);
                await claimDone.promise;
              })
            ).finally(() => {
              claimMay.resolve(null);
            });
            await claimMay.promise;
          },
          () => {
            claimDone.resolve(null);
          }
        )
      );
      await erasing;
      for (let run = 0; run < 3; run += 1) {
        later(pollMs);
        // oxlint-disable-next-line no-await-in-loop -- one run after another
        await sync();
      }
      const { results } = await env.DB.prepare(
        "SELECT count(*) AS count FROM brain_sync_items WHERE connection_id = ? AND place = 'a'"
      )
        .bind(connectionId)
        .all<{ count: number }>();

      expect({
        late: await finds(owner.userId, marks.late),
        old: await finds(owner.userId, marks.old),
        other: await finds(owner.userId, marks.other),
        rowsOfA: results[0]?.count,
      }).toStrictEqual({ late: false, old: false, other: true, rowsOfA: 0 });
    }
  );

  it(
    "keeps a message's attachments across the daily names-only pass, takes them with a message that went, and drops one the message no longer has",
    setUpTime,
    async () => {
      const owner = await signedInApi(idp, "user");
      const marks = {
        message: markerOf(),
        first: markerOf(),
        second: markerOf(),
        went: markerOf(),
        wentFile: markerOf(),
      };
      const quiet = { changes: [], next: "q", more: false };
      const { world } = await connectSampleFeed(owner, { "": quiet, q: quiet });
      const message = (version: string) =>
        mailItem("a/m", `Mail ${marks.message}`, { version });
      const first = mailItem("a/m/1", `File ${marks.first}`, {
        partOf: "a/m",
      });
      const second = mailItem("a/m/2", `File ${marks.second}`, {
        partOf: "a/m",
      });
      const changes: Record<string, unknown> = {
        "": feedPage(
          [
            message("1"),
            first,
            second,
            mailItem("a/x", `Gone ${marks.went}`),
            mailItem("a/x/1", `File ${marks.wentFile}`, { partOf: "a/x" }),
          ],
          "c1"
        ),
        c1: feedPage([], "c1"),
      };
      const set = async () => {
        await world({
          places: ["a"],
          folders: {
            a: {
              changes,
              // The list call names the message alone, as a mailbox's
              // does: no attachment, and not the message that went.
              names: {
                "": feedPage([mailItem("a/m", null, { version: "1" })], "n"),
              },
              items: {},
            },
          },
        });
      };
      await set();
      later(pollMs);
      await sync();
      later(pollMs);
      await sync();
      const found = async () => ({
        message: await finds(owner.userId, marks.message),
        first: await finds(owner.userId, marks.first),
        second: await finds(owner.userId, marks.second),
        went: await finds(owner.userId, marks.went),
        wentFile: await finds(owner.userId, marks.wentFile),
      });
      const before = await found();
      // A day on: the names-only relist, and runs after it.
      later(24 * 60 * 60 * 1000);
      await sync();
      later(pollMs);
      await sync();
      later(pollMs);
      await sync();
      const relisted = await found();
      // The message read in full again, without its second attachment.
      changes.c1 = feedPage([message("2"), first], "c2");
      changes.c2 = feedPage([], "c2");
      await set();
      later(pollMs);
      await sync();

      expect({ before, relisted, reread: await found() }).toStrictEqual({
        before: {
          message: true,
          first: true,
          second: true,
          went: true,
          wentFile: true,
        },
        relisted: {
          message: true,
          first: true,
          second: true,
          went: false,
          wentFile: false,
        },
        reread: {
          message: true,
          first: true,
          second: false,
          went: false,
          wentFile: false,
        },
      });
    }
  );

  it(
    "keeps every statement within the values D1 binds, at a page of 30 and at a names-only listing of a thousand",
    setUpTime,
    async () => {
      const owner = await signedInApi(idp, "user");
      const quiet = { changes: [], next: "q", more: false };
      const { world, fetchedOf } = await connectSampleFeed(owner, {
        "": quiet,
        q: quiet,
      });
      const marks = Array.from({ length: 30 }, () => markerOf());
      const held = marks.map((mark, index) =>
        mailItem(`a/held${index}`, `Mail ${mark}`)
      );
      // The largest page a list call gives: Drive's thousand, Gmail's 500.
      const unknown = Array.from(
        { length: 1000 - held.length },
        (_, index) => `a/new${String(index).padStart(4, "0")}`
      );
      await world({
        places: ["a"],
        folders: {
          a: {
            changes: {
              "": feedPage(held, "c1"),
              c1: feedPage([], "c1"),
            },
            names: {
              "": feedPage(
                [
                  ...held.map(({ id }) => mailItem(id, null)),
                  ...unknown.map((id) => mailItem(id, null)),
                ],
                "n"
              ),
            },
            // Each gone by the time it is fetched: what the catch-up asks
            // is what counts.
            items: {},
          },
        },
      });
      const { db, bound } = countingBinds();
      const countedSync = async () => {
        vi.useFakeTimers({ toFake: ["Date"], now: clockAt });
        try {
          await runSync({ ...env, DB: db });
        } finally {
          vi.useRealTimers();
        }
      };
      later(pollMs);
      await countedSync();
      later(pollMs);
      await countedSync();
      later(24 * 60 * 60 * 1000);
      for (let run = 0; run < 3; run += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one run after another
        await countedSync();
        later(pollMs);
      }
      const asked = await fetchedOf("a");
      const requests = Array.isArray(asked) ? asked : [];

      expect({
        overLimit: bound.filter((count) => count > 100),
        held: await Promise.all(
          [marks[0], marks.at(-1)].map(
            async (mark) => await finds(owner.userId, String(mark))
          )
        ),
        asked: requests
          .flat()
          .map(String)
          .toSorted((one, other) => one.localeCompare(other)),
        largest: Math.max(
          ...requests.map((ids: unknown) =>
            Array.isArray(ids) ? ids.length : 0
          )
        ),
      }).toStrictEqual({
        overLimit: [],
        held: [true, true],
        asked: unknown,
        largest: 50,
      });
    }
  );

  it(
    "relists mail by names once a day: keeps what it holds, fetches what changed or is new once, and takes out what went",
    setUpTime,
    async () => {
      const owner = await signedInApi(idp, "user");
      const marks = {
        kept: markerOf(),
        changed: markerOf(),
        changedNow: markerOf(),
        unknown: markerOf(),
        went: markerOf(),
      };
      const quiet = { changes: [], next: "q", more: false };
      const { world, fetchedOf } = await connectSampleFeed(owner, {
        "": quiet,
        q: quiet,
      });
      const changes = {
        "": {
          changes: [
            mailItem("a/kept", `Kept ${marks.kept}`),
            mailItem("a/changed", `Draft ${marks.changed}`),
            mailItem("a/went", `Gone ${marks.went}`),
          ],
          next: "c1",
          more: false,
        },
        c1: { changes: [], next: "c1", more: false },
      };
      const named = (id: string, version = "1") =>
        mailItem(id, null, { version });
      await world({
        places: ["a"],
        folders: {
          a: {
            changes,
            // A names-only listing: what is there, by ID and version.
            names: {
              "": {
                changes: [
                  named("a/kept"),
                  named("a/changed", "2"),
                  named("a/unknown"),
                ],
                next: "n",
                more: false,
              },
            },
            items: {
              "a/changed": mailItem("a/changed", `Final ${marks.changedNow}`, {
                version: "2",
              }),
              "a/unknown": mailItem("a/unknown", `Late ${marks.unknown}`),
            },
          },
        },
      });
      later(pollMs);
      await sync();
      const before = await finds(owner.userId, marks.kept);
      // A day on: the relist, its catch-up, and a run after it.
      later(24 * 60 * 60 * 1000);
      await sync();
      later(pollMs);
      await sync();
      later(pollMs);
      await sync();

      expect({
        before,
        kept: await finds(owner.userId, marks.kept),
        changed: await finds(owner.userId, marks.changedNow),
        unknown: await finds(owner.userId, marks.unknown),
        went: await finds(owner.userId, marks.went),
        fetched: await fetchedOf("a"),
      }).toStrictEqual({
        before: true,
        kept: true,
        changed: true,
        unknown: true,
        went: false,
        // Only what it didn't hold at the version named, once.
        fetched: [["a/changed", "a/unknown"]],
      });
    }
  );

  it(
    "lists mailboxes' folders as work in the queue: removals keep their turn, and every mailbox gets its folders",
    setUpTime,
    async () => {
      // A person whose note goes away: a removal waiting for its page.
      const remover = await signedInApi(idp, "user");
      const note = markerOf();
      const removing = await connectSampleFeed(remover, {
        "": feedPage([mailItem("note", `Note ${note}`)], "n1"),
        n1: feedPage([], "n1"),
      });
      later(pollMs);
      await sync();
      // Many mailboxes whose folders are still to be listed.
      const mailboxes = await Promise.all(
        Array.from({ length: 8 }, async () => await signedInApi(idp, "user"))
      );
      const markers = mailboxes.map(() => markerOf());
      for (const [index, mailbox] of mailboxes.entries()) {
        // oxlint-disable-next-line no-await-in-loop -- one connection at a time
        const { world } = await connectSampleFeed(mailbox, {
          "": feedPage([], "q"),
          q: feedPage([], "q"),
        });
        // oxlint-disable-next-line no-await-in-loop -- one connection at a time
        await world({
          places: ["inbox"],
          folders: {
            inbox: {
              changes: {
                "": feedPage(
                  [mailItem("inbox/x", `Mail ${markers[index] ?? ""}`)],
                  "i1"
                ),
                i1: feedPage([], "i1"),
              },
            },
          },
        });
      }
      await removing.post({
        "": feedPage([mailItem("note", `Note ${note}`)], "n1"),
        n1: feedPage([goneItem("note")], "n2"),
        n2: feedPage([], "n2"),
      });
      // Runs with room for the run's own four calls, one call for each sync
      // that lists places, and one mail item's page more (claim, read, rows,
      // the item's key, its add in its owner's store, its record, the
      // commit: 10): listing every mailbox's folders ahead of the pages on
      // every run would leave less than one item's page, for good.
      const listings = await env.DB.prepare(
        "SELECT count(*) AS count FROM brain_sync_sources WHERE place = ':places'"
      ).first<{ count: number }>();
      const left =
        4 + Math.max(listings?.count ?? 0, mailboxes.length) + 10 - 1;
      let removedAt: number | undefined;
      let listedAt: number | undefined;
      for (let run = 0; run < 120 && listedAt === undefined; run += 1) {
        later(pollMs);
        vi.useFakeTimers({ toFake: ["Date"], now: clockAt });
        try {
          // oxlint-disable-next-line no-await-in-loop -- one run after another, as the clock runs them
          await runSync(env, { left });
        } finally {
          vi.useRealTimers();
        }
        // oxlint-disable-next-line no-await-in-loop -- read after each run
        if (removedAt === undefined && !(await finds(remover.userId, note))) {
          removedAt = run;
        }
        // oxlint-disable-next-line no-await-in-loop -- read after each run
        const found = await Promise.all(
          mailboxes.map(
            async (mailbox, index) =>
              await finds(mailbox.userId, markers[index] ?? "")
          )
        );
        if (found.every(Boolean)) {
          listedAt = run;
        }
      }

      expect({
        removed: removedAt !== undefined && removedAt < 60,
        listed: listedAt !== undefined,
      }).toStrictEqual({ removed: true, listed: true });
    }
  );

  it(
    "lets a held removal go after a day when another folder never catches up",
    setUpTime,
    async () => {
      const owner = await signedInApi(idp, "user");
      const marker = markerOf();
      const quiet = feedPage([], "q");
      const { world } = await connectSampleFeed(owner, { "": quiet, q: quiet });
      const a: Record<string, unknown> = {
        "": feedPage([mailItem("a/m", `Mail ${marker}`)], "a1"),
        a1: feedPage([], "a1"),
      };
      const b = { "": feedPage([], "b1"), b1: feedPage([], "b1") };
      await world({
        places: ["a", "b"],
        folders: { a: { changes: a }, b: { changes: b } },
        failing: [],
      });
      later(pollMs);
      await sync();
      later(pollMs);
      await sync();
      // Gone from a; b fails from now on and never reads again.
      a.a1 = feedPage([goneItem("a/m")], "a2");
      a.a2 = feedPage([], "a2");
      await world({
        folders: { a: { changes: a }, b: { changes: b } },
        failing: ["b"],
      });
      later(pollMs);
      await sync();
      const held = await finds(owner.userId, marker);
      later(24 * 60 * 60 * 1000 + pollMs);
      await sync();

      expect({ held, after: await finds(owner.userId, marker) }).toStrictEqual({
        held: true,
        after: false,
      });
    }
  );

  it(
    "never holds the removal of what others may read: a shared file gone from a folder goes at once",
    setUpTime,
    async () => {
      const [owner, colleague] = await Promise.all([
        signedInApi(idp, "user"),
        signedInApi(idp, "user"),
      ]);
      const quiet = feedPage([], "q");
      await connectSampleFeed(colleague, { "": quiet, q: quiet });
      const marker = markerOf();
      const { world } = await connectSampleFeed(owner, { "": quiet, q: quiet });
      const shared = mailItem("a/f", `Plan ${marker}`, {
        kind: "file",
        readers: [{ kind: "tenant", id: acmeTenant }],
      });
      const a: Record<string, unknown> = {
        "": feedPage([shared], "a1"),
        a1: feedPage([], "a1"),
      };
      const b = { "": feedPage([], "b1"), b1: feedPage([], "b1") };
      await world({
        places: ["a", "b"],
        folders: { a: { changes: a }, b: { changes: b } },
        failing: [],
      });
      later(pollMs);
      await sync();
      later(pollMs);
      await sync();
      const before = await finds(colleague.userId, marker);
      // Gone from a while b fails, which would hold a removal.
      a.a1 = feedPage([goneItem("a/f")], "a2");
      a.a2 = feedPage([], "a2");
      await world({
        folders: { a: { changes: a }, b: { changes: b } },
        failing: ["b"],
      });
      later(pollMs);
      await sync();

      expect({
        before,
        after: await finds(colleague.userId, marker),
      }).toStrictEqual({ before: true, after: false });
    }
  );

  it(
    "after a restart, takes out what the relist no longer names",
    setUpTime,
    async () => {
      const owner = await signedInApi(idp, "user");
      const { subject, email } = await connectDrive(owner);
      const [kept, gone] = [markerOf(), markerOf()];
      const contents = { kept: `Contract ${kept}`, gone: `Draft ${gone}` };
      await driveHolds(subject, {
        start: "40",
        owned: [docFile("kept", email), docFile("gone", email)],
        changes: { "40": { changes: [], newStartPageToken: "40" } },
        contents,
      });
      later(pollMs);
      await sync();
      const before = [
        await finds(owner.userId, kept),
        await finds(owner.userId, gone),
      ];

      // Google lost the cursor (404), and the file went while it was lost:
      // the relist names it nowhere, and no change says it went.
      await driveHolds(subject, {
        start: "50",
        owned: [docFile("kept", email)],
        changes: { "50": { changes: [], newStartPageToken: "50" } },
        contents,
      });
      // The run that meets the lost cursor, then the one that lists again.
      later(pollMs);
      await sync();
      later(pollMs);
      await sync();

      expect({
        before,
        after: [
          await finds(owner.userId, kept),
          await finds(owner.userId, gone),
        ],
      }).toStrictEqual({ before: [true, true], after: [true, false] });
    }
  );

  it(
    "waits as long as a throttled read asks, from the same cursor, while other sources go on",
    setUpTime,
    async () => {
      const [throttled, other] = await Promise.all([
        signedInApi(idp, "user"),
        signedInApi(idp, "user"),
      ]);
      const slow = await connectDrive(throttled);
      const fast = await connectDrive(other);
      const [waiting, going] = [markerOf(), markerOf()];
      const drive = (email: string, marker: string): DriveWorld => ({
        start: "60",
        owned: [docFile("memo", email)],
        changes: { "60": { changes: [], newStartPageToken: "60" } },
        contents: { memo: `Memo ${marker}` },
      });
      await driveHolds(slow.subject, {
        ...drive(slow.email, waiting),
        throttle: 300,
      });
      await driveHolds(fast.subject, drive(fast.email, going));
      later(pollMs);
      await sync();
      const throttledRun = {
        waiting: await finds(throttled.userId, waiting),
        going: await finds(other.userId, going),
      };
      await driveHolds(slow.subject, drive(slow.email, waiting));
      later(pollMs);
      await sync();
      const beforeItsTime = await finds(throttled.userId, waiting);
      later(300_000);
      await sync();

      expect({
        throttledRun,
        beforeItsTime,
        afterItsTime: await finds(throttled.userId, waiting),
      }).toStrictEqual({
        throttledRun: { waiting: false, going: true },
        beforeItsTime: false,
        afterItsTime: true,
      });
    }
  );

  it(
    "erases everything a connection synced once it is disconnected, its own and the shared store's",
    setUpTime,
    async () => {
      const [owner, colleague] = await Promise.all([
        signedInApi(idp, "user"),
        signedInApi(idp, "user"),
      ]);
      await connectDrive(colleague);
      const [mine, everyones] = [markerOf(), markerOf()];
      const { connectionId, subject, email } = await connectDrive(owner);
      await driveHolds(subject, {
        start: "70",
        owned: [
          docFile("mine", email),
          docFile("everyones", email, { permissions: withDomain(email) }),
        ],
        changes: { "70": { changes: [], newStartPageToken: "70" } },
        contents: { mine: `Notes ${mine}`, everyones: `Guide ${everyones}` },
      });
      later(pollMs);
      await sync();
      const before = [
        await finds(owner.userId, mine),
        await finds(colleague.userId, everyones),
      ];

      await owner.api.connections.disconnect(connectionId);
      // connect's record of the disconnect drained: its own store's copies
      // erased at once.
      await drainAuditOutboxes(env);
      const atDrain = await finds(owner.userId, mine);
      later(pollMs);
      await sync();
      const erasedEvents = await syncEvents(connectionId);
      // Its event says who disconnected; nothing else keeps their ID.
      const naming = await env.DB.prepare(
        "SELECT count(*) AS count FROM brain_sync_disconnects WHERE instr(coalesce(actor, ''), ?) > 0"
      )
        .bind(owner.userId)
        .first<{ count: number }>();

      expect({
        before,
        atDrain,
        after: [
          await finds(owner.userId, mine),
          await finds(colleague.userId, everyones),
          await finds(owner.userId, everyones),
        ],
        erased: erasedEvents.filter(
          ({ action }) => action === "brain.sync.erased"
        ),
        naming: naming?.count,
      }).toStrictEqual({
        before: [true, true],
        atDrain: false,
        after: [false, false, false],
        erased: [{ action: "brain.sync.erased", detail: { sources: 2 } }],
        naming: 0,
      });
    }
  );
});
