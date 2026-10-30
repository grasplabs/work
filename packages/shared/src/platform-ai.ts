import { z } from "zod";

import { speakers } from "./voice.ts";
import type { Speaker } from "./voice.ts";

// PLATFORM_AI (core's src/platform-ai.ts): which provider and model each of
// Grasp's own AI features uses, the ones Grasp pays for. They go through
// core's model gateway like any model call (metered in the ledger, audited
// as metadata only) and through connect with Grasp's own key for the
// provider (`platformSecret` in ./ai-providers.ts). Switching a feature to
// another provider or model is configuration: the admin's Platform → AI
// page sets this var, and core reads it on every call.
//
// - `conversion`: a PDF uploaded to the Brain, read into Markdown by a
//   model that takes the file itself (OpenAI's `input_file`, Anthropic's
//   `document`, OpenRouter's `file`). Word and Excel files, WebVTT
//   captions, a sensitive collection's files and an EU-only deployment's
//   are read by the local extractor instead, and never sent out.
//   `{ provider: "local" }` reads every file locally (on-prem).
// - `transcription`: what someone says on the onboarding's pages, live
//   over the provider's realtime socket, or from a recording.
// - `speech`: the onboarding's lines said out loud, each speaker in a
//   voice of the provider's.
//
// A feature whose provider Grasp has no key for fails with a clear code,
// never silently, and never on another provider.

/** The providers a document can be converted by: those that take a PDF as is. */
export const conversionProviders = [
  "openai",
  "anthropic",
  "openrouter",
] as const;

/** The providers that write down speech, live and from a recording. */
export const transcriptionProviders = ["openai"] as const;

/** The providers that say a line. */
export const speechProviders = ["openai"] as const;

/**
 * A model as its provider names it, without the provider: `gpt-5.4-mini`,
 * `claude-haiku-4-5`, or OpenRouter's `openai/gpt-5-mini`.
 */
const modelIdSchema = z
  .string()
  .min(1)
  .max(128)
  // Each part starts with a letter or digit: never `.` or `..`.
  .regex(/^[A-Za-z0-9][\w.:@-]*(?:\/[A-Za-z0-9][\w.:@-]*)*$/u);

/** A provider's voice, by its own name for it, such as `cedar`. */
const voiceIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[\w-]+$/u);

const conversionSchema = z.discriminatedUnion("provider", [
  z.strictObject({
    provider: z.enum(conversionProviders),
    model: modelIdSchema,
  }),
  /** Every file read by the local extractor: nothing sent out (on-prem). */
  z.strictObject({ provider: z.literal("local") }),
]);

const transcriptionSchema = z.strictObject({
  provider: z.enum(transcriptionProviders),
  model: modelIdSchema,
});

const speechSchema = z.strictObject({
  provider: z.enum(speechProviders),
  model: modelIdSchema,
  /** A voice for any speaker; the defaults' for the rest. */
  voices: z.partialRecord(z.enum(speakers), voiceIdSchema).default({}),
});

/**
 * Each feature's provider and model, as the defaults have them: OpenAI's
 * GPT-5.4 mini reads PDFs (text and page images, so scans too), GPT-4o
 * Transcribe writes down speech, live and recorded, and GPT-4o mini TTS
 * says the lines, which it can be told the tone of.
 */
export const defaultPlatformAi = {
  conversion: { provider: "openai", model: "gpt-5.4-mini" },
  transcription: { provider: "openai", model: "gpt-4o-transcribe" },
  speech: {
    provider: "openai",
    model: "gpt-4o-mini-tts",
    voices: {
      // Stephen: young, confident, conversational. Claire: warm and bright.
      // The sample speakers: each clearly not Stephen.
      stephen: "cedar",
      claire: "marin",
      mark: "ash",
      lisa: "coral",
      tim: "verse",
    },
  },
} as const satisfies {
  conversion: z.input<typeof conversionSchema>;
  transcription: z.input<typeof transcriptionSchema>;
  speech: z.input<typeof speechSchema> & { voices: Record<Speaker, string> };
};

/**
 * The `PLATFORM_AI` var: JSON, each feature optional, the default for one
 * left out. Unknown keys refuse it, so a typo never passes for a setting.
 */
export const platformAiSchema = z.strictObject({
  conversion: conversionSchema.default(defaultPlatformAi.conversion),
  transcription: transcriptionSchema.default(defaultPlatformAi.transcription),
  speech: speechSchema.default(defaultPlatformAi.speech),
});
export type PlatformAiInput = z.input<typeof platformAiSchema>;

/** Each feature's settings, as core uses them: every speaker with a voice. */
export interface PlatformAi {
  conversion: z.output<typeof conversionSchema>;
  transcription: z.output<typeof transcriptionSchema>;
  speech: Omit<z.output<typeof speechSchema>, "voices"> & {
    voices: Record<Speaker, string>;
  };
}

/** One of Grasp's own AI features. */
export type PlatformAiFeature = keyof PlatformAi;

/**
 * `value` as each feature's settings, the defaults for what it leaves out
 * (a speaker without a voice gets the default's, should the provider be
 * the default's); `undefined` when it doesn't parse.
 */
export const parsePlatformAi = (value?: unknown): PlatformAi | undefined => {
  const parsed = platformAiSchema.safeParse(value ?? {});
  if (!parsed.success) {
    return undefined;
  }
  const { conversion, transcription, speech } = parsed.data;
  const voices = { ...defaultPlatformAi.speech.voices, ...speech.voices };
  return { conversion, transcription, speech: { ...speech, voices } };
};
