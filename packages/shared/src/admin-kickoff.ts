import { z } from "zod";

import { identifierMaxLength } from "./identifier.ts";
import {
  answerMaxLength,
  transcriptFileMaxBytes,
  transcriptMaxLength,
  visionFields,
  visionFieldSchema,
} from "./kickoff.ts";
import type { KickoffView, VisionField } from "./kickoff.ts";
import { interviewLocaleSchema } from "./onboarding.ts";

// The kickoff from Grasp's admin (GRA-1099): a Grasp admin brings in a
// company's first conversation with its sponsor from that organization's
// page in the admin, and fills in the sponsor's answers to what it left
// open. The admin asks the company's core, signed with the key both derive
// from the client's auth secret for this purpose alone, as it asks for the
// admin snapshot (`admin-snapshot.ts`), and names the staff member
// Cloudflare Access let in, whom core's audit log records. Core reads the
// transcript and keeps it exactly as the staff page in the company's Grasp
// did (core's onboarding/kickoff.ts), so what it brought seeds Stephen's
// context for the first interviews the same way.
//
// What can go wrong, and what stops it:
//
// - Someone but the admin bringing in a transcript, or bringing one into
//   another company: only a request signed with this company's own key
//   for this purpose is taken (core's console-signed.ts). A key for the
//   snapshot, the chat, or another company's opens nothing here.
// - A request caught on its way sent again later: it carries when it was
//   sent, and core takes it only within a few minutes of that.
// - Grasp acting where the company ended its access, or after the window
//   it gave: core checks the company's staff window, as a staff session
//   is checked, before and again after the transcript is read.
// - An oversized or malformed file: the request is bounded in bytes before
//   it is read, the file in bytes once decoded, its kind by its name, and
//   its text in characters; a Word file is read in the extractor's
//   sandbox, never in core (core's onboarding/kickoff.ts).
// - What was said leaving the company's Grasp: the admin's view of the
//   kickoff says which of the ten things it brought and the questions it
//   left for the sponsor, never the words or quotes it rests on.

/** Where the admin brings the kickoff to a company's core. Behind the router-secret check. */
export const adminKickoffPath = "/platform/admin/kickoff";

/** The purpose the request's signing key is derived for (`hkdfHmacKey`). */
export const adminKickoffPurpose = "grasp-os admin kickoff key";

/** How far from core's clock a request may have been sent. */
export const adminKickoffMaxSkewMs = 5 * 60 * 1000;

/** The longest a transcript file may be in base64: four characters for every three bytes. */
export const transcriptBase64MaxLength =
  4 * Math.ceil(transcriptFileMaxBytes / 3);

/**
 * The most bytes a request's body may have: a file at its largest in
 * base64, or a pasted transcript at its longest with every character
 * escaped, and room for the rest.
 */
export const adminKickoffMaxBytes =
  Math.max(transcriptBase64MaxLength, 6 * transcriptMaxLength * 2) + 16 * 1024;

const base64Pattern = /^[A-Za-z0-9+/]*={0,2}$/u;

/** A transcript as the admin brings it: pasted, or a file's bytes in base64. */
export const adminTranscriptSchema = z.union([
  z.strictObject({ text: z.string().max(transcriptMaxLength * 2) }),
  z.strictObject({
    file: z.strictObject({
      name: z.string().min(1).max(255),
      base64: z
        .string()
        .max(transcriptBase64MaxLength)
        .regex(base64Pattern)
        .refine((text) => text.length % 4 === 0, "Padded base64"),
    }),
  }),
]);
export type AdminTranscript = z.input<typeof adminTranscriptSchema>;

/** What the admin asks of the kickoff: how it stands, a transcript to read, or the sponsor's answer to a field. */
export const adminKickoffAskSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("read") }),
  z.strictObject({
    kind: z.literal("save"),
    /** The language the reading is written in. */
    locale: interviewLocaleSchema,
    transcript: adminTranscriptSchema,
  }),
  z.strictObject({
    kind: z.literal("answer"),
    field: visionFieldSchema,
    /** The sponsor's answer; empty takes it back. */
    text: z.string().max(answerMaxLength),
  }),
]);
export type AdminKickoffAsk = z.input<typeof adminKickoffAskSchema>;

/**
 * What the admin sends: when, so a request caught on its way can't be
 * sent later; the staff member asking, as Cloudflare Access verified
 * them, for the audit log; and what they ask.
 */
export const adminKickoffRequestSchema = z.strictObject({
  sentAt: z.iso.datetime(),
  staff: z.strictObject({
    email: z.email().max(identifierMaxLength).toLowerCase(),
  }),
  ask: adminKickoffAskSchema,
});
export type AdminKickoffRequest = z.input<typeof adminKickoffRequestSchema>;

/** Where one of the ten things stands: said in the kickoff, answered by the sponsor, or still open. */
export const adminKickoffFieldSchema = z.object({
  field: visionFieldSchema,
  state: z.enum(["said", "answered", "open"]),
  /** The question for the sponsor, when the kickoff left it open; empty when it gave none. */
  ask: z.string(),
  /** The sponsor's answer as staff keep it, when there is one. */
  answer: z.string().nullable(),
});
export type AdminKickoffField = z.output<typeof adminKickoffFieldSchema>;

/** The kickoff as the admin shows it: never what was said, only what it brought. */
export const adminKickoffViewSchema = z.object({
  /** When the transcript came in, and from where; null before it did. */
  transcript: z
    .object({
      at: z.iso.datetime(),
      fileName: z.string().nullable(),
      characters: z.int().min(0),
    })
    .nullable(),
  /** Whether Stephen has read it. */
  read: z.boolean(),
  /** The ten, in the area's order. */
  fields: z.array(adminKickoffFieldSchema),
  /** How many teams it named. */
  teams: z.int().min(0),
});
export type AdminKickoffView = z.output<typeof adminKickoffViewSchema>;

/** What of the kickoff the admin may see: which of the ten it brought, and the questions it left. */
export const adminKickoffViewOf = (kickoff: KickoffView): AdminKickoffView => ({
  transcript: kickoff.transcript,
  read: kickoff.reading !== null,
  fields: visionFields.map((field: VisionField) => {
    const answer = kickoff.answers[field] ?? null;
    const said = kickoff.reading?.fields[field] !== undefined;
    let state: AdminKickoffField["state"] = "open";
    if (said) {
      state = "said";
    } else if (answer !== null) {
      state = "answered";
    }
    return {
      field,
      state,
      ask: said ? "" : (kickoff.reading?.ask[field] ?? ""),
      answer,
    };
  }),
  teams: kickoff.reading?.teams.length ?? 0,
});

/** Standard, padded base64 (RFC 4648 §4) as bytes; undefined for anything else. */
export const bytesOfBase64 = (
  text: string
): Uint8Array<ArrayBuffer> | undefined => {
  if (!base64Pattern.test(text) || text.length % 4 !== 0) {
    return undefined;
  }
  try {
    const binary = atob(text);
    return Uint8Array.from(binary, (char) => char.codePointAt(0) ?? 0);
  } catch {
    return undefined;
  }
};
