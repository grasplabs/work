import { z } from "zod";

import { defineErrorFamily } from "./errors.ts";
import { interviewLocaleSchema } from "./onboarding.ts";
import { uploadMaxBytes, uploadNameSchema } from "./uploads.ts";

// Documents the company's admin shares in the onboarding (core's
// onboarding/documents.ts): each is kept in Knowledge, in a collection
// only admins read, and read at once for what it is about, the tools and
// teams it names, and what it leaves open about the work, which Stephen
// asks the people who do it. He asks the admin only what nobody else can
// say, with answers to pick from. From the prototype's
// `lib/document-reading.ts`.

/** The Knowledge collection the onboarding keeps shared documents in. */
export const onboardingDocumentsCollection = "onboarding-documents";

/** The longest text of one document that is read, in characters. */
export const documentTextMaxLength = 120_000;

/** The most a document's reading holds of each. */
export const documentReadingMost = {
  about: 220,
  tools: 12,
  teams: 8,
  unclear: 3,
  options: 3,
  word: 60,
  /** A team's name, as long as the staff list lets one be. */
  team: 80,
  question: 160,
  line: 200,
} as const;

/** One question to the admin who shared a document, with answers to pick from. */
export interface DocumentQuestion {
  question: string;
  options: string[];
}

/** What Stephen took from a document. */
export interface DocumentReading {
  /** What it is and what work it covers: one short sentence. */
  about: string;
  /** The software and systems it names, as written. */
  tools: string[];
  /** The teams it is about. */
  teams: string[];
  /** What it leaves open about the work, for the people who do it. */
  unclear: string[];
  /** What only the admin can say, when it can't be used without; none otherwise. */
  ask: DocumentQuestion | null;
}

/** A document shared in the onboarding. */
export interface OnboardingDocument {
  /** Its upload in Knowledge. */
  id: string;
  name: string;
  /** ISO 8601. */
  at: string;
  reading: DocumentReading;
  /** The admin's answer to its question, once given. */
  answer: string | null;
}

/** A document shared: its file, and the language it is read in. */
export const shareDocumentSchema = z.strictObject({
  locale: interviewLocaleSchema,
  // Knowledge's own rule for a file name, checked before any reading.
  name: uploadNameSchema,
  bytes: z
    .instanceof(Uint8Array)
    .refine((bytes) => bytes.byteLength <= uploadMaxBytes, {
      message: "The file is too large",
    }),
});
export type ShareDocumentInput = z.input<typeof shareDocumentSchema>;

/** The longest answer kept to a document's question. */
export const documentAnswerMaxLength = 200;

/** What the company's admin does with documents in the onboarding. */
export interface OnboardingDocumentsApi {
  documents: () => Promise<OnboardingDocument[]>;
  /** Keeps the file in Knowledge and reads it at once. */
  shareDocument: (input: ShareDocumentInput) => Promise<OnboardingDocument>;
  /** Keeps the admin's answer to a document's question. */
  answerDocument: (id: string, answer: string) => Promise<OnboardingDocument>;
}

/** Why a shared document was refused. */
export const documentErrors = defineErrorFamily({
  "document.old_format":
    "That is an old Office file. Save it as .docx, .xlsx or PDF, and share it again.",
  "document.slides":
    "Slides can't be read yet. Save them as a PDF, and share that.",
  "document.unsupported":
    "That kind of file can't be read. Share a PDF, Word or Excel file.",
  "document.too_large": "That file is larger than 10 MB.",
  "document.empty": "There is no text in that file to read.",
  "document.too_complex":
    "That file is too large or complex to read. Share a smaller or simpler one.",
  "document.not_read":
    "The document couldn't be read just now. Try again in a moment.",
  "document.not_found": "There's no such document.",
  "document.invalid": "That isn't something a document takes.",
});
