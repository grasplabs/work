import { z } from "zod";

import { platformRegions } from "./ai-providers.ts";
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
//   voice the model has (`speechVoicesOf`).
// - `region`: where Grasp's own OpenAI project keeps its data, the EU by
//   default (`platformRouteOf` in ./ai-providers.ts makes it a host). An
//   EU-only deployment uses an OpenAI feature only while it is the EU.
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

/** The speech models a line can be said in. */
export const speechModels = ["gpt-4o-mini-tts", "tts-1", "tts-1-hd"] as const;
export type SpeechModel = (typeof speechModels)[number];

/** The voices `tts-1` and `tts-1-hd` have; GPT-4o mini TTS has more. */
const classicVoices = [
  "alloy",
  "ash",
  "coral",
  "echo",
  "fable",
  "nova",
  "onyx",
  "sage",
  "shimmer",
] as const;

/**
 * The voices each speech model has, by OpenAI's names (OpenAI's text to
 * speech guide, read on 2026-10-31): a voice it doesn't have fails every
 * line said in it.
 */
export const speechVoicesOf: Readonly<Record<SpeechModel, readonly string[]>> =
  {
    "gpt-4o-mini-tts": [...classicVoices, "ballad", "verse", "marin", "cedar"],
    "tts-1": classicVoices,
    "tts-1-hd": classicVoices,
  };

/**
 * Each speaker's voice when the settings name none, by the model: each a
 * voice the model has. Stephen: young, confident, conversational. Claire:
 * warm and bright. The sample speakers: each clearly not Stephen.
 */
export const defaultVoicesOf: Readonly<
  Record<SpeechModel, Readonly<Record<Speaker, string>>>
> = {
  "gpt-4o-mini-tts": {
    stephen: "cedar",
    claire: "marin",
    mark: "ash",
    lisa: "coral",
    tim: "verse",
  },
  "tts-1": {
    stephen: "onyx",
    claire: "nova",
    mark: "ash",
    lisa: "coral",
    tim: "echo",
  },
  "tts-1-hd": {
    stephen: "onyx",
    claire: "nova",
    mark: "ash",
    lisa: "coral",
    tim: "echo",
  },
};

const speechSchema = z
  .strictObject({
    provider: z.enum(speechProviders),
    model: z.enum(speechModels),
    /** A voice for any speaker; the model's default for the rest. */
    voices: z.partialRecord(z.enum(speakers), voiceIdSchema).default({}),
  })
  .superRefine(({ model, voices }, context) => {
    for (const [speaker, voice] of Object.entries(voices)) {
      if (voice !== undefined && !speechVoicesOf[model].includes(voice)) {
        context.addIssue({
          code: "custom",
          message: `${model} has no voice ${voice}`,
          path: ["voices", speaker],
        });
      }
    }
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
    voices: defaultVoicesOf["gpt-4o-mini-tts"],
  },
  region: "eu",
} as const satisfies {
  conversion: z.input<typeof conversionSchema>;
  transcription: z.input<typeof transcriptionSchema>;
  speech: z.input<typeof speechSchema> & {
    voices: Readonly<Record<Speaker, string>>;
  };
  region: (typeof platformRegions)[number];
};

/**
 * The `PLATFORM_AI` var: JSON, each feature optional, the default for one
 * left out. Unknown keys refuse it, so a typo never passes for a setting.
 */
export const platformAiSchema = z.strictObject({
  conversion: conversionSchema.default(defaultPlatformAi.conversion),
  transcription: transcriptionSchema.default(defaultPlatformAi.transcription),
  speech: speechSchema.default(defaultPlatformAi.speech),
  /** Where Grasp's own OpenAI project keeps its data: the EU unless set. */
  region: z.enum(platformRegions).default(defaultPlatformAi.region),
});
export type PlatformAiInput = z.input<typeof platformAiSchema>;

/** Each feature's settings, as core uses them: every speaker with a voice. */
export interface PlatformAi {
  conversion: z.output<typeof conversionSchema>;
  transcription: z.output<typeof transcriptionSchema>;
  speech: Omit<z.output<typeof speechSchema>, "voices"> & {
    voices: Record<Speaker, string>;
  };
  region: z.output<typeof platformAiSchema>["region"];
}

/** One of Grasp's own AI features: each setting but the region. */
export type PlatformAiFeature = Exclude<keyof PlatformAi, "region">;

/**
 * `value` as each feature's settings, the defaults for what it leaves out
 * (a speaker without a voice gets the model's default voice); `undefined`
 * when it doesn't parse, `null` included, or names a voice its speech
 * model doesn't have.
 */
export const parsePlatformAi = (value: unknown): PlatformAi | undefined => {
  // Nothing in it is `{}`; anything else that isn't an object (`null`, a
  // broken var) doesn't parse.
  const parsed = platformAiSchema.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }
  const { conversion, transcription, speech, region } = parsed.data;
  const voices = { ...defaultVoicesOf[speech.model], ...speech.voices };
  return { conversion, transcription, speech: { ...speech, voices }, region };
};
