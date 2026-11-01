import { z } from "zod";

import { defineErrorFamily } from "./errors.ts";
import { identifierMaxLength } from "./identifier.ts";
import { gateThresholds } from "./onboarding-gate.ts";
import { orgRulesSchema, stephenSetupSchema } from "./onboarding-staff.ts";
import {
  agreementsSchema,
  onboardingPeopleMax,
  rosterPersonSchema,
  rosterTeamSchema,
} from "./onboarding.ts";

// Steering a client's onboarding from Grasp's admin: every change staff
// make to a company's onboarding is a command, one envelope core applies
// in one place (core's admin-command.ts), audited as the staff member
// Cloudflare Access let into the admin. Steering is part of setting up a
// deployment, so it lives in the admin, never in the company's own Grasp.
//
// A command is delivered, not called: today the admin posts it straight to
// the company's core, signed with the key both derive from the client's
// auth secret for this purpose alone, as it asks for the snapshot. An
// on-prem core that only connects out will fetch its pending commands
// instead and hand them to the same handler. So a command never answers
// with data: what changed shows in the next snapshot, and it applies once
// however often it is delivered (by its `id`).
//
// What can go wrong, and what stops it:
//
// - Someone but the admin changing a company's onboarding, or the admin's
//   command for one company applied in another: only an envelope signed
//   with this company's own key for this purpose is taken. A key for the
//   snapshot, the kickoff or another company's opens nothing here.
// - A command delivered twice (a retry, or a delivery caught and sent
//   again): core keeps every id it applied, and applies one only once.
// - A command caught on its way and delivered later for the first time:
//   it carries when it was issued, and core takes it only within a few
//   minutes of that.
// - Grasp steering where the company ended its access, or after the window
//   it gave: core checks the company's staff window before it applies one.
// - A malformed or oversized command: the envelope is bounded in bytes and
//   every payload is checked against its type's schema before anything is
//   applied.

/** Where the admin delivers a command to a company's core. Behind the router-secret check. */
export const adminCommandPath = "/platform/admin/command";

/** The purpose the envelope's signing key is derived for (`hkdfHmacKey`). */
export const adminCommandPurpose = "grasp-os admin command key";

/** How far from core's clock a command may have been issued. */
export const adminCommandMaxSkewMs = 5 * 60 * 1000;

/** The most bytes an envelope may have: Stephen's setup at its longest, and room for the rest. */
export const adminCommandMaxBytes = 128 * 1024;

const personId = rosterPersonSchema.shape.id;

/** A piece of work's id, as the team map makes them. */
const workId = z.string().min(1).max(64);

const none = z.strictObject({});

/** Every command, by type, with what it carries. */
const commandPayloads = {
  /** Where the agreements stand: until all are in, no link opens or goes out. */
  "onboarding.agreements": z.strictObject({ agreements: agreementsSchema }),
  /** Notes the one reminder for each of these people. */
  "onboarding.remind": z.strictObject({
    people: z.array(personId).min(1).max(onboardingPeopleMax),
  }),
  /** Asks a team that doesn't take part in. */
  "onboarding.ask_in": z.strictObject({ team: rosterTeamSchema.shape.id }),
  /** Sends someone's failed mail again. */
  "onboarding.send_mail_again": z.strictObject({ person: personId }),
  /** Gives someone who lost their device a new start: what they said goes. */
  "onboarding.new_start": z.strictObject({ person: personId }),
  /** Grasp's go: opens the company's Grasp to everyone. */
  "onboarding.gate.open": none,
  /** Takes the go back: closes it again to all but its admins. */
  "onboarding.gate.close": none,
  /** How much Grasp has to know before it is ready to open, in percent. */
  "onboarding.gate.threshold": z.strictObject({
    threshold: z.union(gateThresholds.map((each) => z.literal(each))),
  }),
  /** Pauses the interviews: no link opens or goes out. */
  "onboarding.pause": none,
  /** Lets the interviews run again. */
  "onboarding.resume": none,
  /** When a piece of work counts as known here; null takes the defaults back. */
  "onboarding.rules": z.strictObject({ rules: orgRulesSchema.nullable() }),
  /** Counts a piece of work as known by hand, or stops doing so. */
  "onboarding.count_as_known": z.strictObject({
    work: workId,
    counted: z.boolean(),
  }),
  /** Draws a piece of work again from what its people agreed to. */
  "onboarding.draw_again": z.strictObject({ work: workId }),
  /** How Stephen is set up here; null takes the kickoff's suggestion back. */
  "onboarding.stephen": z.strictObject({
    setup: stephenSetupSchema.nullable(),
  }),
} as const;

type CommandPayloads = typeof commandPayloads;

/** A command's type. */
export type AdminCommandType = keyof CommandPayloads;

/** One type's command: what the admin's page asks for. */
const commandOf = <T extends AdminCommandType>(type: T) =>
  z.strictObject({ type: z.literal(type), payload: commandPayloads[type] });

/** A command as staff give it, before it is put in its envelope. */
export const adminCommandSchema = z.discriminatedUnion("type", [
  commandOf("onboarding.agreements"),
  commandOf("onboarding.remind"),
  commandOf("onboarding.ask_in"),
  commandOf("onboarding.send_mail_again"),
  commandOf("onboarding.new_start"),
  commandOf("onboarding.gate.open"),
  commandOf("onboarding.gate.close"),
  commandOf("onboarding.gate.threshold"),
  commandOf("onboarding.pause"),
  commandOf("onboarding.resume"),
  commandOf("onboarding.rules"),
  commandOf("onboarding.count_as_known"),
  commandOf("onboarding.draw_again"),
  commandOf("onboarding.stephen"),
]);
/** What the admin asks: a type and what it carries. */
export type AdminCommand = z.input<typeof adminCommandSchema>;

const staffSchema = z.strictObject({
  email: z.email().max(identifierMaxLength).toLowerCase(),
});

/** One type's envelope: the command and what goes with every one. */
const envelopeOf = <T extends AdminCommandType>(type: T) =>
  z.strictObject({
    /** The command's own id: the same id applies once, however often it is delivered. */
    id: z.uuid(),
    type: z.literal(type),
    payload: commandPayloads[type],
    /** The staff member who gave it, as Cloudflare Access verified them, for the audit log. */
    staff: staffSchema,
    /** When it was given. */
    issuedAt: z.iso.datetime(),
  });

/** A command as it is delivered: `{ id, type, payload, staff, issuedAt }`. */
export const adminCommandEnvelopeSchema = z.discriminatedUnion("type", [
  envelopeOf("onboarding.agreements"),
  envelopeOf("onboarding.remind"),
  envelopeOf("onboarding.ask_in"),
  envelopeOf("onboarding.send_mail_again"),
  envelopeOf("onboarding.new_start"),
  envelopeOf("onboarding.gate.open"),
  envelopeOf("onboarding.gate.close"),
  envelopeOf("onboarding.gate.threshold"),
  envelopeOf("onboarding.pause"),
  envelopeOf("onboarding.resume"),
  envelopeOf("onboarding.rules"),
  envelopeOf("onboarding.count_as_known"),
  envelopeOf("onboarding.draw_again"),
  envelopeOf("onboarding.stephen"),
]);
export type AdminCommandEnvelope = z.output<typeof adminCommandEnvelopeSchema>;
export type AdminCommandEnvelopeInput = z.input<
  typeof adminCommandEnvelopeSchema
>;

/** What core answers a command it took: applied now, or already before under the same id. */
export const adminCommandAnswerSchema = z.object({
  id: z.uuid(),
  applied: z.enum(["now", "before"]),
});
export type AdminCommandAnswer = z.output<typeof adminCommandAnswerSchema>;

/** Why core didn't apply a command it otherwise took. */
export const adminCommandErrors = defineErrorFamily({
  "admin.command_pending":
    "That command is being applied right now. Try again in a moment.",
});
