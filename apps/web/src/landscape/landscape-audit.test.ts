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
  matchesAudit,
  noAuditFilters,
  parentOf,
  shortHash,
  visibleCountFor,
} from "./landscape-audit.ts";
import type { AppAuditEvent, AuditFilters } from "./landscape-audit.ts";

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
