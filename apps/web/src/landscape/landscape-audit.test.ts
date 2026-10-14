import type { AuditRecord } from "@grasp-os/shared/audit-log";
import { describe, expect, it } from "vite-plus/test";

import {
  appAuditEventOf,
  auditCsv,
  detailLabel,
  detailValue,
  eventDate,
  eventDetails,
  eventTime,
  groupByMonth,
  hasAuditFilters,
  hasOlder,
  matchesAudit,
  noAuditFilters,
  parentOf,
  readTrail,
  shortHash,
  startTrail,
  trailRecords,
  visibleCountFor,
} from "./landscape-audit.ts";
import type {
  AppAuditEvent,
  AuditFilters,
  SearchLog,
  TrailRead,
} from "./landscape-audit.ts";

// An app's audit trail, as the prototype tests it (lib/landscape-audit.test.ts),
// and how core's audit records become its events.

const event = (overrides: Partial<AppAuditEvent>): AppAuditEvent => ({
  id: "evt",
  timestamp: "2026-04-20T08:00:00Z",
  actor: "Grasp",
  actorType: "pipeline",
  category: "detection",
  title: "Scan completed",
  description: "Scanned with 40 users.",
  ...overrides,
});

const scan = event({ id: "scan" });
const signOff = event({
  id: "sign-off",
  timestamp: "2026-04-02T14:30:00Z",
  actor: "Eva Bakker",
  actorType: "human",
  category: "access",
  title: "Access reviewed",
  description: 'Quarterly review, "all clear", no changes',
  parentEventId: "scan",
  oldValue: "Pending",
  newValue: "Approved",
  payload: { reviewedUsers: 12, escalated: false, note: null },
});
const older = event({
  id: "older",
  timestamp: "2026-03-30T09:00:00Z",
  category: "policy",
  title: "Flagged by policy",
});
const trail = [scan, signOff, older];

const matching = (filters: Partial<AuditFilters>, query = "") =>
  trail
    .filter((each) =>
      matchesAudit(each, { ...noAuditFilters, ...filters }, query)
    )
    .map(({ id }) => id);

describe(matchesAudit, () => {
  it("shows every event without filters", () => {
    expect(matching({})).toStrictEqual(["scan", "sign-off", "older"]);
  });

  it("matches any choice within a facet and every facet", () => {
    expect(matching({ category: ["detection", "policy"] })).toStrictEqual([
      "scan",
      "older",
    ]);
    expect(
      matching({ category: ["detection", "access"], actor: ["human"] })
    ).toStrictEqual(["sign-off"]);
  });

  it("searches title, actor, description and the category name, ignoring case", () => {
    expect(matching({}, "eva")).toStrictEqual(["sign-off"]);
    expect(matching({}, "QUARTERLY")).toStrictEqual(["sign-off"]);
    expect(matching({}, "ACCESS")).toStrictEqual(["sign-off"]);
    expect(matching({}, "  flagged ")).toStrictEqual(["older"]);
  });

  it("knows when anything narrows the list", () => {
    expect(hasAuditFilters(noAuditFilters, " ")).toBeFalsy();
    expect(hasAuditFilters(noAuditFilters, "x")).toBeTruthy();
    expect(
      hasAuditFilters({ ...noAuditFilters, actor: ["human"] }, "")
    ).toBeTruthy();
  });
});

describe("timeline", () => {
  it("groups consecutive events by month, in order", () => {
    const groups = groupByMonth(trail);
    expect(groups.map(({ label }) => label)).toStrictEqual([
      "Apr 2026",
      "Mar 2026",
    ]);
    expect(groups[0]?.events.map(({ id }) => id)).toStrictEqual([
      "scan",
      "sign-off",
    ]);
  });

  it("formats date and time as recorded, in UTC", () => {
    expect(eventDate("2026-04-02T23:30:00Z")).toBe("Apr 2, 2026");
    expect(eventTime("2026-04-02T14:30:00Z")).toBe("14:30");
    expect(eventTime("2026-04-02")).toBe("");
  });

  it("finds the parent event only when it is in the trail", () => {
    expect(parentOf(signOff, trail)).toBe(scan);
    expect(parentOf(signOff, [signOff])).toBeUndefined();
    expect(parentOf(scan, trail)).toBeUndefined();
  });

  it("pages in whole pages so an event comes into view", () => {
    expect(visibleCountFor(3, 25)).toBe(25);
    expect(visibleCountFor(25, 25)).toBe(50);
    expect(visibleCountFor(60, 25)).toBe(75);
    expect(visibleCountFor(2, 50)).toBe(50);
  });
});

describe("details", () => {
  it("turns recorded keys and values into words", () => {
    expect([
      detailLabel("usersScanned"),
      detailLabel("inbox_item_type"),
    ]).toStrictEqual(["Users scanned", "Inbox item type"]);
    expect([
      detailValue(true),
      detailValue(null),
      detailValue(12),
    ]).toStrictEqual(["Yes", "—", "12"]);
  });

  it("lists an event's recorded details as label and value", () => {
    expect(eventDetails(signOff)).toStrictEqual([
      { label: "Reviewed users", value: "12" },
      { label: "Escalated", value: "No" },
      { label: "Note", value: "—" },
    ]);
  });

  it("shortens a fingerprint to its ends", () => {
    expect(shortHash("0123456789abcdef0123")).toBe("01234567…0123");
    expect(shortHash("short")).toBe("short");
  });
});

describe(auditCsv, () => {
  it("writes one row per event with a header, quoting where needed", () => {
    const [header, row, ...rest] = auditCsv([signOff], trail).split("\n");
    expect(rest).toStrictEqual([]);
    expect(header).toMatch(/^Date,Time \(UTC\),Category,Event/u);
    expect(row).toBe(
      [
        '"Apr 2, 2026",14:30,Access,Access reviewed',
        '"Quarterly review, ""all clear"", no changes"',
        "Eva Bakker,Person,Pending,Approved,Scan completed",
        "Reviewed users: 12; Escalated: No; Note: —,",
      ].join(",")
    );
  });
});

/** A record of core's audit log holding `stored`. */
const record = (seq: number, stored: AuditRecord["event"]): AuditRecord => ({
  seq,
  receivedAt: "2026-09-02T10:00:00.000Z",
  eventJson: JSON.stringify(stored),
  event: stored,
  type: "config",
  version: 1,
  prevHash: "0".repeat(64),
  hash: "a".repeat(64),
  verified: true,
});

describe("from core's audit log", () => {
  const directory = {
    people: new Map([["u1", "Eva Bakker"]]),
    apps: new Map(),
  };
  const accounts = new Map([["c1", "eva@acme.test"]]);
  const base = {
    id: "00000000-0000-4000-8000-000000000000",
    at: "2026-09-02T10:00:00.000Z",
    source: "connect" as const,
    target: { type: "connection", id: "c1" },
    provenance: [],
  };

  it("names who connected an account, in words, as how Grasp found the app", () => {
    expect(
      appAuditEventOf(
        record(7, {
          ...base,
          actor: { type: "person", userId: "u1" },
          action: "connection.connect",
          detail: { provider: "microsoft", outcome: "connected" },
        }),
        directory,
        accounts
      )
    ).toStrictEqual({
      id: "7",
      timestamp: "2026-09-02T10:00:00.000Z",
      actor: "Eva Bakker",
      actorType: "human",
      category: "detection",
      title: "Connected an account",
      description: "On the connection eva@acme.test",
      payload: { provider: "microsoft", outcome: "connected" },
      hash: "a".repeat(64),
    });
  });

  it("files what Grasp itself did as automated access", () => {
    expect(
      appAuditEventOf(
        record(8, {
          ...base,
          actor: { type: "system" },
          action: "connection.needs_reauth",
          detail: {},
        }),
        directory,
        accounts
      )
    ).toMatchObject({
      actor: "Grasp",
      actorType: "pipeline",
      category: "access",
      title: "A connection needs signing in again",
    });
  });

  it("leaves out a record whose event can't be read", () => {
    expect(
      appAuditEventOf(record(9, null), directory, accounts)
    ).toBeUndefined();
  });
});

/**
 * Core's audit log as `audit.search` reads it: newest first, below
 * `before`, at most `stretch` entries a page and at most `limit` matches,
 * `next` where the page stopped (core's src/audit-log.ts).
 */
const auditLog =
  (entries: readonly AuditRecord[], stretch: number, limit = 100): SearchLog =>
  async (filter, before) => {
    const lowest = Math.min(...entries.map(({ seq }) => seq));
    const read = entries
      .filter(({ seq }) => before === undefined || seq < before)
      .toSorted((one, other) => other.seq - one.seq)
      .slice(0, stretch);
    const records: AuditRecord[] = [];
    let last: number | undefined;
    for (const entry of read) {
      last = entry.seq;
      const target = entry.event?.target;
      if (
        (filter?.targetType === undefined ||
          target?.type === filter.targetType) &&
        (filter?.targetId === undefined || target?.id === filter.targetId)
      ) {
        records.push(entry);
        if (records.length === limit) {
          break;
        }
      }
    }
    return await Promise.resolve({
      records,
      next: last === undefined || last === lowest ? null : last,
    });
  };

const seqs = (records: readonly AuditRecord[]) => records.map(({ seq }) => seq);

/** Reads on, a page of each search at a time, until nothing older is left. */
const readToTheEnd = async (search: SearchLog, from: TrailRead) => {
  let read = from;
  while (hasOlder(read)) {
    // oxlint-disable-next-line no-await-in-loop -- each read starts where the last ended
    read = await readTrail(search, read, 1);
  }
  return read;
};

describe("reading an app's trail from core's audit log", () => {
  const stored = {
    id: "00000000-0000-4000-8000-000000000000",
    at: "2026-09-02T10:00:00.000Z",
    source: "core" as const,
    actor: { type: "person" as const, userId: "u1" },
    provenance: [],
  };
  const onConnection = (seq: number, id: string) =>
    record(seq, {
      ...stored,
      action: "connection.call",
      target: { type: "connection", id },
      detail: {},
    });
  const onPermission = (seq: number, connectionId?: string) =>
    record(seq, {
      ...stored,
      action: "permission.granted",
      target: { type: "permission", id: `p${String(seq)}` },
      detail:
        connectionId === undefined
          ? { objectType: "dependencies" }
          : { objectType: "connection", connectionId, actions: "read" },
    });

  it("keeps the permissions granted on the app's connections, named by the account they're on", async () => {
    const search = auditLog(
      [
        onConnection(1, "c1"),
        onPermission(2, "c1"),
        onPermission(3, "elsewhere"),
        onPermission(4),
        onConnection(5, "elsewhere"),
      ],
      100
    );
    const read = await readTrail(search, startTrail(["c1"]));
    const [granted] = trailRecords(read);
    expect(seqs(trailRecords(read))).toStrictEqual([2, 1]);
    expect(
      granted === undefined
        ? undefined
        : appAuditEventOf(
            granted,
            { people: new Map([["u1", "Eva Bakker"]]), apps: new Map() },
            new Map([["c1", "eva@acme.test"]])
          )
    ).toMatchObject({
      title: "Granted a permission",
      description: "On the connection eva@acme.test",
      actor: "Eva Bakker",
      category: "access",
    });
  });

  it("reads a stretch of the log at a time, and older stretches as asked for, until none is left", async () => {
    const entries = Array.from({ length: 60 }, (_, index) =>
      index % 3 === 0
        ? onPermission(index + 1, "c1")
        : onConnection(index + 1, index % 3 === 1 ? "c1" : "c2")
    );
    const search = auditLog(entries, 5);
    const first = await readTrail(search, startTrail(["c1", "c2"]), 2);
    expect(hasOlder(first)).toBeTruthy();
    expect(seqs(trailRecords(first))).toStrictEqual([
      60, 59, 58, 57, 56, 55, 54, 53, 52, 51,
    ]);
    const second = await readTrail(search, first, 2);
    expect(seqs(trailRecords(second))).toHaveLength(20);
    const whole = await readToTheEnd(search, second);
    expect(hasOlder(whole)).toBeFalsy();
    expect(seqs(trailRecords(whole))).toStrictEqual(seqs(entries).toReversed());
  });

  it("shows an older event only once every search has read past the newer ones", async () => {
    // Each page holds at most 2 matches: the busy connection's search
    // falls behind the permission search, which reads further back.
    const entries = Array.from({ length: 30 }, (_, index) =>
      index % 5 === 0
        ? onPermission(index + 1, "c1")
        : onConnection(index + 1, "c1")
    );
    const search = auditLog(entries, 10, 2);
    const expected = seqs(entries).toReversed();
    let read = startTrail(["c1"]);
    while (hasOlder(read)) {
      // oxlint-disable-next-line no-await-in-loop -- each read starts where the last ended
      read = await readTrail(search, read, 1);
      const shown = seqs(trailRecords(read));
      expect(shown).toStrictEqual(expected.slice(0, shown.length));
    }
    expect(seqs(trailRecords(read))).toStrictEqual(expected);
  });
});
