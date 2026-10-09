import { z } from "zod";

import { defineErrorFamily } from "./errors.ts";
import { interviewLocaleSchema } from "./onboarding.ts";

// The kickoff (core's onboarding/kickoff.ts): Grasp's first conversation
// with the company's sponsor, brought in by Grasp's staff and read for the
// ten things Stephen needs before his first interview. A field counts only
// when the words it rests on are in the transcript; whatever it doesn't
// say becomes a question for the sponsor, whose answer is kept beside it.
// From the prototype's `lib/first-conversation.ts` and `VISION_FIELDS`.

/** What Stephen needs from the kickoff, in the order the area shows it. */
export const visionFields = [
  "business",
  "teams",
  "goals",
  "success",
  "stakeholders",
  "pain",
  "limits",
  "sensitivities",
  "systems",
  "languages",
] as const;
export type VisionField = (typeof visionFields)[number];
export const visionFieldSchema = z.enum(visionFields);

/** The longest transcript taken, in characters: about three hours of talk. */
export const transcriptMaxLength = 240_000;
/** Too short to be a conversation. */
export const transcriptMinLength = 200;
/** The largest transcript file taken, in bytes: a `.docx` is zipped XML. */
export const transcriptFileMaxBytes = 5 * 1024 * 1024;
/** The longest answer from the sponsor kept for one field. */
export const answerMaxLength = 2000;
/** The longest team name kept from a kickoff. */
export const kickoffTeamNameMaxLength = 60;

/** The kinds of transcript file taken, by extension. */
export const transcriptFileKinds = ["txt", "vtt", "srt", "docx"] as const;
export type TranscriptFileKind = (typeof transcriptFileKinds)[number];

/** What the kickoff said about one field, and the words it rests on. */
export interface VisionSaid {
  text: string;
  quote: string;
}

/** A team the company named in the kickoff, before the staff list is in. */
export interface KickoffTeam {
  name: string;
  does: string;
  /** How many people work in it, when that was said. */
  people?: number;
}

/** The kickoff as Stephen read it. */
export interface KickoffReading {
  /** The fields it said, each with its quote. */
  fields: Partial<Record<VisionField, VisionSaid>>;
  /** The fields it didn't: the question to put to the sponsor. */
  ask: Partial<Record<VisionField, string>>;
  teams: KickoffTeam[];
}

/** The kickoff as Grasp's staff see it. */
export interface KickoffView {
  /** When the transcript came in, and from where; null before it did. */
  transcript: {
    /** ISO 8601. */
    at: string;
    /** The file's name, or null when it was pasted. */
    fileName: string | null;
    characters: number;
  } | null;
  reading: KickoffReading | null;
  /** The sponsor's answers to what the kickoff left open. */
  answers: Partial<Record<VisionField, string>>;
}

/**
 * A transcript brought in: pasted, or a file read for its text; and the
 * language the area is in, which the reading is written in.
 */
export const kickoffInputSchema = z.strictObject({
  locale: interviewLocaleSchema,
  transcript: z.union([
    z.strictObject({
      text: z.string().max(transcriptMaxLength * 2),
    }),
    z.strictObject({
      file: z.strictObject({
        name: z.string().min(1).max(255),
        bytes: z
          .instanceof(Uint8Array)
          .refine((bytes) => bytes.byteLength <= transcriptFileMaxBytes, {
            message: "The file is too large",
          }),
      }),
    }),
  ]),
});
export type KickoffInput = z.input<typeof kickoffInputSchema>;

/** What only Grasp's staff do with the kickoff (`onboardingStaff`). */
export interface KickoffApi {
  kickoff: () => Promise<KickoffView>;
  /** Brings the transcript in, replacing any before it, and reads it. */
  saveKickoff: (input: KickoffInput) => Promise<KickoffView>;
  /** Keeps the sponsor's answer to a field; an empty one takes it back. */
  answerKickoff: (field: VisionField, text: string) => Promise<KickoffView>;
}

/** Why the kickoff was refused. */
export const kickoffErrors = defineErrorFamily({
  "kickoff.too_short": "That is too short to be a conversation.",
  "kickoff.too_long":
    "That transcript is too long. Bring in the conversation itself, without attachments.",
  "kickoff.unreadable":
    "That file couldn't be read. Bring in a .txt, .vtt, .srt or .docx transcript, or paste it.",
  "kickoff.not_read":
    "The conversation couldn't be read just now. Try again in a moment.",
  "kickoff.invalid": "That isn't something the kickoff takes.",
});
