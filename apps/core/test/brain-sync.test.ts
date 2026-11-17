import type { AuditEvent } from "@grasp-os/shared/audit";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { drainAuditOutboxes } from "../src/audit-drains.ts";
import { recallAs } from "../src/brain-next.ts";
import { runSync } from "../src/brain-sync.ts";
import { allEvents } from "./audit-events.ts";
import { consentCode } from "./connect-providers.ts";
import { driveSyncControlUrl } from "./drive-sync-fake.ts";
import type { DriveFile, DriveWorld } from "./drive-sync-fake.ts";
import { mockIdp } from "./idp.ts";
import { signInConfig } from "./sign-in-config.ts";
import { routed, signedInApi, unique } from "./sign-in.ts";
import { testBinding } from "./test-env.ts";

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
      }).toStrictEqual({
        before: [true, true],
        atDrain: false,
        after: [false, false, false],
        erased: [{ action: "brain.sync.erased", detail: { sources: 2 } }],
      });
    }
  );
});
