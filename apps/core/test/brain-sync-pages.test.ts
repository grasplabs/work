import { env } from "cloudflare:workers";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { eraseSource } from "../src/brain-next.ts";
import { runSync } from "../src/brain-sync.ts";
import {
  idp,
  setUpTime,
  domain,
  pollMs,
  markerOf,
  driveHolds,
  connectSampleFeed,
  mailItem,
  feedPage,
  connectDrive,
  docFile,
  withDomain,
  finds,
  syncEvents,
  clockAt,
  later,
  sync,
  ownSourcesOnly,
  parkWorkerSources,
} from "./brain-sync-world.ts";
import { countingBinds } from "./counting-binds.ts";
import type { DriveWorld } from "./drive-sync-fake.ts";
import { mockIdpWith } from "./idp.ts";
import { acmeTenant } from "./sign-in-config.ts";
import { signedInApi } from "./sign-in.ts";

const drive = (email: string, marker: string): DriveWorld => ({
  start: "60",
  owned: [docFile("memo", email)],
  changes: { "60": { changes: [], newStartPageToken: "60" } },
  contents: { memo: `Memo ${marker}` },
});

mockIdpWith(idp);

// Native sync (src/brain-sync.ts, GRA-1758): the ordinary page run and its commit: what a page brings, in what order, once, within D1's bound values, and a throttled read. The shared world,
// fakes and clock are in test/brain-sync-world.ts.

describe("native sync", () => {
  beforeAll(parkWorkerSources, setUpTime.timeout);
  beforeEach(ownSourcesOnly);
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
        vi.useFakeTimers({ toFake: ["Date"], now: clockAt() });
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
        vi.useFakeTimers({ toFake: ["Date"], now: clockAt() });
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
        vi.useFakeTimers({ toFake: ["Date"], now: clockAt() });
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
});
