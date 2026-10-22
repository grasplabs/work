import { z } from "zod";

import { METER_PURPOSES } from "./admin/org-record.ts";
import { identifierMaxLength } from "./identifier.ts";
import { interviewPhases, personStates } from "./interview-links.ts";
import {
  agreementsSchema,
  interviewerSchema,
  interviewKindSchema,
  planSchema,
  rosterPersonSchema,
  rosterTeamSchema,
} from "./onboarding.ts";
import { roleSchema } from "./roles.ts";

// What Grasp's admin works its pages out from for one client (core's
// admin-snapshot.ts): the prototype's staff snapshot (`StaffSnapshot` in
// ./admin/org-record.ts), from what core holds. For Grasp's staff only:
// the console asks, signed with the key both derive from the client's
// auth secret for this purpose alone, as it asks for the onboarding
// summary (`onboarding-summary.ts`), and names the staff member Cloudflare
// Access let in, whom core's audit log records as the reader. Unlike the
// summary it names people, so every read is in the company's audit log.
//
// Interviews are here as numbers only: what anyone said, the facts Stephen
// wrote down and the transcripts stay behind the audited staff transcript
// read (`OnboardingStaffApi.transcript`). Nor is any interview link here:
// a link is a credential. Nor any connection's: what the company connected
// comes without tokens, server URLs or what Composio knows an account by,
// and people's own connections, and chats' requests, only as counts by app.
//
// Objects in the answer are read with `z.object`, which drops what it
// doesn't know: the console asks cores on several releases, and a newer
// core's added field mustn't make an older console's read fail. Core
// answers with what this schema keeps of what it built, so nothing it
// doesn't name ever leaves core either.

/** Where the console asks core for the snapshot. Behind the router-secret check. */
export const adminSnapshotPath = "/platform/admin";

/** The purpose the request's signing key is derived for (`hkdfHmacKey`). */
export const adminSnapshotPurpose = "grasp-os admin snapshot key";

/** How far from core's clock a request may have been sent. */
export const adminSnapshotMaxSkewMs = 5 * 60 * 1000;

/** The most bytes a request's body may have. */
export const adminSnapshotMaxBytes = 1024;

/**
 * What the console sends: when, so a request caught on its way can't be
 * sent later, and the staff member asking, as Cloudflare Access verified
 * them, for the audit log.
 */
export const adminSnapshotRequestSchema = z.strictObject({
  sentAt: z.iso.datetime(),
  staff: z.strictObject({
    email: z.email().max(identifierMaxLength).toLowerCase(),
  }),
});
export type AdminSnapshotRequest = z.input<typeof adminSnapshotRequestSchema>;

const isoTime = z.iso.datetime();
const count = z.int().min(0);

/** One person's link, and where they stand: never the link itself. */
export const adminLinkSchema = z.object({
  person: z.string(),
  /** When it went out; null while it waits for its moment, or for the lead. */
  sentAt: isoTime.nullable(),
  openedAt: isoTime.nullable(),
  remindedAt: isoTime.nullable(),
  /** When they deleted their interview, while their link stays theirs. */
  deletedAt: isoTime.nullable(),
  /** As the prototype's admin says it (`personStateOf`). */
  state: z.enum([...personStates, "waiting"]),
});
export type AdminLink = z.output<typeof adminLinkSchema>;

/** One person's interview, in numbers: nothing they said. */
export const adminInterviewSchema = z.object({
  person: z.string(),
  kind: interviewKindSchema,
  startedAt: isoTime.nullable(),
  /** When they agreed to what was read back; null before they did. */
  completedAt: isoTime.nullable(),
  updatedAt: isoTime,
  agreed: z.boolean(),
  /** The part it is in, or stopped in; null before anything was kept. */
  phase: z.enum(interviewPhases).nullable(),
  /** The part they left it in, while it is started and not agreed to. */
  stoppedAt: z.enum(interviewPhases).nullable(),
  /** From its start to its agreement, or to its last save; null before it started. */
  minutes: count.nullable(),
  /** Facts written down and kept, and those they took out in the read-back. */
  facts: count,
  out: count,
  /** Facts read back and agreed to. */
  confirmed: count,
  /** From 1 to 5, when they gave one: it is theirs to give or not. */
  rating: z.int().min(1).max(5).nullable(),
  typed: z.boolean(),
  interviewer: interviewerSchema.nullable(),
});
export type AdminInterview = z.output<typeof adminInterviewSchema>;

/** What the calls to one model took on one day, for one purpose. */
const meteredSchema = z.object({
  calls: count,
  tokensIn: count,
  /** Tokens read from what the model kept of an earlier call. */
  kept: count,
  tokensOut: count,
  /** Seconds of Stephen's voice. */
  seconds: z.number().min(0),
});

/** One day's AI use, by purpose then model: the prototype's `MeterDay`. */
export const adminUsageDaySchema = z.object({
  day: z.iso.date(),
  // A purpose this console doesn't know, from a newer core, is dropped
  // unread, whatever its numbers look like, rather than refusing the whole
  // answer.
  use: z.preprocess(
    (use) =>
      typeof use === "object" && use !== null
        ? Object.fromEntries(
            Object.entries(use).filter(([purpose]) =>
              METER_PURPOSES.some((known) => known === purpose)
            )
          )
        : use,
    z.partialRecord(z.enum(METER_PURPOSES), z.record(z.string(), meteredSchema))
  ),
});

// The roster, plan and agreements as the answer has them: their fields as
// onboarding.ts has them, but in objects that drop a key they don't know
// where onboarding.ts's `z.strictObject` refuses it, and without the
// roster's limits and checks, which core enforced when it kept them.
const rosterReadSchema = z.object({
  teams: z.array(z.object(rosterTeamSchema.shape)),
  people: z.array(z.object(rosterPersonSchema.shape)),
});
const planReadSchema = z.object(planSchema.shape);
const agreementsReadSchema = z.object(agreementsSchema.shape);

/** Who carries out a connection's actions: a native connector, or Composio. */
const sourceSchema = z.enum(["native", "composio"]);

/**
 * How a connection stands: it `works`; it needs someone at the company to
 * sign in `again`; Composio says its account `stopped`; or Composio
 * couldn't be asked now (`unread`).
 */
export const adminConnectionStates = [
  "works",
  "again",
  "stopped",
  "unread",
] as const;

/**
 * One shared connection the company made: a service account, or an app an
 * admin consented to. What it is and how it stands, never its tokens, its
 * server's URL or anything Composio knows it by.
 */
export const adminConnectionSchema = z.object({
  source: sourceSchema,
  /** A native provider (`microsoft`), or a Composio toolkit's slug. */
  provider: z.string(),
  state: z.enum(adminConnectionStates),
  /** An admin took it out of what the company's people may connect. */
  hidden: z.boolean(),
  /** Who connected it, by name, while they are a member. */
  connectedBy: z.string().nullable(),
  connectedAt: isoTime,
  /** The account at the provider, such as a service mailbox's address. */
  account: z.string().nullable(),
  /** A Composio connection's allowed tools, by name: what Grasp may do there. */
  tools: z.array(z.string()).nullable(),
});
export type AdminConnection = z.output<typeof adminConnectionSchema>;

/** People's own connections to one app: how many, and how many stopped. */
export const adminPersonalConnectionsSchema = z.object({
  source: sourceSchema,
  provider: z.string(),
  people: count,
  again: count,
});

/**
 * Why a workflow can't run as it is: one of its current version's
 * connector bindings has no connection an admin approved (`unbound`), or
 * the approved one isn't connected any more (`missing`), stopped
 * (`stopped`: someone must sign in again, or Composio says its account
 * stopped), or is of an app an admin hid (`hidden`).
 */
export const adminNeedStates = [
  "unbound",
  "missing",
  "stopped",
  "hidden",
] as const;

/** One connector binding of a workflow that no working connection serves. */
export const adminNeededSchema = z.object({
  workflow: z.object({ id: z.string(), name: z.string() }),
  /** The binding's alias in the workflow. */
  alias: z.string(),
  /** The app it was approved with; null while none was. */
  app: z.object({ source: sourceSchema, provider: z.string() }).nullable(),
  state: z.enum(adminNeedStates),
});
export type AdminNeeded = z.output<typeof adminNeededSchema>;

/**
 * Connections chats' agents asked for that wait on a decision, by app: on
 * the person in the chat for their own personal one, on an admin for a
 * shared one. Never what the agent said, whose chat, or who.
 */
export const adminConnectionRequestsSchema = z.object({
  source: sourceSchema,
  provider: z.string(),
  decidedBy: z.enum(["person", "admin"]),
  waiting: count,
  /** When the oldest of them was asked. */
  since: isoTime,
});

/** What the company connected, and what its workflows and chats still need. */
export const adminIntegrationsSchema = z.object({
  connected: z.array(adminConnectionSchema),
  personal: z.array(adminPersonalConnectionsSchema),
  needed: z.array(adminNeededSchema),
  requests: z.array(adminConnectionRequestsSchema),
});
export type AdminIntegrations = z.output<typeof adminIntegrationsSchema>;

/**
 * What core doesn't hold yet: null from this core, and whatever a newer
 * one sends is read as null too, for this schema can't say what it is.
 */
const notYetHeld = z.unknown().transform((): null => null);

/** Everything Grasp's admin reads of one client. */
export const adminSnapshotSchema = z.object({
  /** Core's clock when it answered: what the admin counts days to. */
  now: isoTime,
  company: z.object({
    name: z.string(),
    timeZone: z.string(),
    /** Email domains its people sign in with. */
    signInDomains: z.array(z.string()),
    /** Where they sign in. */
    signIn: z.array(z.enum(["microsoft", "google"])),
    /** Who the deployment makes its admins when they first sign in. */
    admins: z.array(z.string()),
  }),
  /**
   * Who Grasp deals with there (sponsor, admin, billing, privacy): null
   * until core holds them, from Attio, with the issue that brings it.
   */
  contacts: notYetHeld,
  roster: rosterReadSchema.nullable(),
  plan: planReadSchema.nullable(),
  /** As staff last said; null before they said anything. */
  agreements: agreementsReadSchema.nullable(),
  /** All the agreements are in. */
  agreed: z.boolean(),
  paused: z.boolean(),
  /** The team is told: a link went out. */
  told: z.boolean(),
  /** Teams whose lead's map of the work is drawn. */
  mapped: z.array(z.string()),
  /** Everyone on the roster, with their link's standing. */
  links: z.array(adminLinkSchema),
  interviews: z.array(adminInterviewSchema),
  /**
   * The work drawn from the interviews, with what each person told: null
   * until core draws it, with the issue that brings the drawing.
   */
  works: notYetHeld,
  kickoff: z
    .object({
      at: isoTime,
      /** How much of what Stephen needs from it is in, 0 to 1. */
      known: z.number().min(0).max(1),
    })
    .nullable(),
  gate: z.object({
    open: z.boolean(),
    closedSince: isoTime.nullable(),
    threshold: z.int().min(0).max(100),
    /** How much Grasp knows, in percent. */
    known: z.int().min(0).max(100),
    ready: z.boolean(),
    over: z.boolean(),
    openedAt: isoTime.nullable(),
  }),
  /**
   * The contract and its papers: null until core holds them, from Rooms
   * and Stripe, with the issue that brings them.
   */
  contract: notYetHeld,
  /** The organization's members, by name. */
  members: z.array(
    z.object({
      userId: z.string(),
      name: z.string(),
      email: z.string(),
      role: roleSchema,
      joinedAt: isoTime,
    })
  ),
  /**
   * What the company connected, and what its workflows still need: null
   * from a core that doesn't send it yet, and when connect didn't answer.
   */
  integrations: adminIntegrationsSchema.nullable(),
  /** The AI the onboarding used, day by day, oldest first. */
  usage: z.array(adminUsageDaySchema),
});
export type AdminSnapshot = z.output<typeof adminSnapshotSchema>;
