import { z } from "zod";

import type { Need } from "./admin/onboarding-admin.ts";
import { onboardingStages } from "./onboarding-summary.ts";

// What the admin reads of every client for its sidebar and its Inbox
// (core's admin-summary.ts): how each one stands, in counts and dates
// only. No person, no name of a team, a workflow or an app, nothing
// anyone wrote: the admin holds no client data, and this keeps it so, as
// the onboarding summary does (`onboarding-summary.ts`). Only the admin
// reads it: the request is signed with the key both derive from the
// client's auth secret for this purpose alone, as platform updates are
// (`platform-change.ts`). Unlike the admin snapshot (`admin-snapshot.ts`)
// it names nobody, so no staff member is named in the request and no read
// is in the company's audit log.
//
// Objects in the answer are read with `z.object`, which drops what it
// doesn't know, and a need of a kind this admin doesn't know is dropped
// unread: the admin asks cores on several releases, and a newer core's
// addition mustn't make an older admin's read fail.

/** Where the admin asks core for the summary. Behind the router-secret check. */
export const adminSummaryPath = "/platform/summary";

/** The purpose the request's signing key is derived for (`hkdfHmacKey`). */
export const adminSummaryPurpose = "grasp-os admin summary key";

/** How far from core's clock a request may have been sent. */
export const adminSummaryMaxSkewMs = 5 * 60 * 1000;

/** The most bytes a request's body may have. */
export const adminSummaryMaxBytes = 1024;

/** What the admin sends: when, so a request caught on its way can't be sent later. */
export const adminSummaryRequestSchema = z.strictObject({
  sentAt: z.iso.datetime(),
});
export type AdminSummaryRequest = z.infer<typeof adminSummaryRequestSchema>;

/** The days of workflow runs the summary counts, today's included. */
export const adminSummaryRunDays = 30;

/** The weeks of active people the summary counts, this one included. */
export const adminSummaryWeeks = 8;

/**
 * The needs core can know: every kind the admin's view of a snapshot
 * gives (`adminViewOf`), which core works out as the admin does. Not
 * `overdue`, which the admin reads from Stripe. A kind added to `Need`
 * fails to compile here until it is named or left out on purpose.
 */
export const coreNeedKinds = {
  paused: "paused",
  go: "go",
  short: "short",
  ending: "ending",
  blocked: "blocked",
  lead: "lead",
  quiet: "quiet",
  transcript: "transcript",
  agreement: "agreement",
  contract: "contract",
  conflict: "conflict",
  ask: "ask",
  budget: "budget",
  signin: "signin",
  split: "split",
  few: "few",
  read: "read",
} as const satisfies {
  [Kind in Exclude<Need["kind"], "overdue">]: Kind;
};
export type CoreNeedKind = keyof typeof coreNeedKinds;

const coreNeedKind = z.enum(coreNeedKinds);

const isoTime = z.iso.datetime();
const count = z.int().min(0);

/** One client as the admin's sidebar and Inbox show it: counts and dates only. */
export const adminSummarySchema = z.object({
  /** Core's clock when it answered. */
  now: isoTime,
  /** Where its onboarding stands (`OnboardingSummary`, with the gate's figures). */
  onboarding: z.object({
    stage: z.enum(onboardingStages),
    /** The day of the interviews it is on, from 1; null outside them. */
    day: z.int().min(1).nullable(),
    /** How many days the interviews run; null without a plan. */
    days: z.int().min(1).nullable(),
    /** How much Grasp knows, in percent, and what it opens at. */
    known: z.int().min(0).max(100),
    threshold: z.int().min(0).max(100),
    /** The team is told: a link went out. */
    told: z.boolean(),
    paused: z.boolean(),
    /** Enough is known: it waits only for Grasp's go. */
    ready: z.boolean(),
    open: z.boolean(),
    openedAt: isoTime.nullable(),
  }),
  /**
   * What needs Grasp there, by kind: how many of each, never what each is
   * about (a team, a lead, a piece of work). Kinds with none are left out.
   */
  needs: z.preprocess(
    (needs) =>
      Array.isArray(needs)
        ? needs.filter(
            (need: unknown) =>
              typeof need === "object" &&
              need !== null &&
              "kind" in need &&
              coreNeedKind.safeParse(need.kind).success
          )
        : needs,
    z.array(z.object({ kind: coreNeedKind, count: z.int().min(1) }))
  ),
  /**
   * The company's shared connections by how they stand: working, waiting
   * for someone to sign in again, stopped at Composio. Null when connect
   * didn't answer.
   */
  connectors: z
    .object({ works: count, again: count, stopped: count })
    .nullable(),
  /** How many apps the company asked Grasp to add. */
  asked: count,
  activity: z.object({
    /** Workflow runs started on each of the last 30 UTC days, oldest first, as they stand now. */
    runs: z.array(z.object({ day: z.iso.date(), done: count, failed: count })),
    /** Workflows published and not paused, Apps live, agents on. */
    workflowsLive: count,
    appsLive: count,
    agentsOn: count,
    /**
     * People who did something themselves in each of the last 8 weeks,
     * oldest first, each week from its Monday (UTC).
     */
    activePeople: z.array(z.object({ week: z.iso.date(), people: count })),
  }),
});
export type AdminSummary = z.output<typeof adminSummarySchema>;
