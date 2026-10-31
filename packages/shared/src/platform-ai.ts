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
// - `speech`: the onboarding's lines said out loud by ElevenLabs, each
//   speaker in one of the voices Grasp chose (`speechVoicesOf`).
// - `region`: where Grasp's own projects at OpenAI and ElevenLabs keep
//   their data, the EU by default (`platformRouteOf` in ./ai-providers.ts
//   makes it a host). An EU-only deployment uses those features only
//   while it is the EU.
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

/** The providers that say a line: ElevenLabs. */
export const speechProviders = ["elevenlabs"] as const;

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

/** A voice, by its ElevenLabs ID, such as `s3TPKV1kjDlVtZbl4Ksh`. */
const voiceIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9]+$/u);

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

/**
 * The speech models a line can be said in, ElevenLabs's: Eleven v4, the
 * most expressive, in which Stephen's lines are said; v4 Turbo, quicker,
 * with the same voices and directions, for a line only known as it is
 * said; and v3 and Flash v2.5.
 */
export const speechModels = [
  "eleven_v4",
  "eleven_v4_turbo",
  "eleven_v3",
  "eleven_flash_v2_5",
] as const;
export type SpeechModel = (typeof speechModels)[number];

/**
 * Each speaker's voice when the settings name none, by its ElevenLabs ID.
 * Stephen's is "Adam", the voice Eleven v4 is shown with: young,
 * confident, conversational. Claire's is "Jessica": playful, bright and
 * warm, checked by ElevenLabs in English, Dutch, German and Spanish, not
 * in French. The sample speakers are ElevenLabs's own voices, each
 * clearly not Stephen.
 */
const elevenLabsVoices = {
  stephen: "s3TPKV1kjDlVtZbl4Ksh",
  claire: "r1KmysJdVYZjJCm4mL3b",
  lisa: "EXAVITQu4vr4xnSDxMaL",
  mark: "cjVigY5qzO86Huf0OWal",
  tim: "TX3LPaxmHKxFdv7VOQHJ",
} as const satisfies Record<Speaker, string>;

/**
 * The voices each speech model may say a line in: the ones Grasp chose
 * and checked, which every model of ElevenLabs's here has. A voice
 * outside them is refused rather than tried on a deployment's people.
 */
export const speechVoicesOf: Readonly<Record<SpeechModel, readonly string[]>> =
  {
    eleven_v4: Object.values(elevenLabsVoices),
    eleven_v4_turbo: Object.values(elevenLabsVoices),
    eleven_v3: Object.values(elevenLabsVoices),
    eleven_flash_v2_5: Object.values(elevenLabsVoices),
  };

/** Each speaker's voice when the settings name none, by the model. */
export const defaultVoicesOf: Readonly<
  Record<SpeechModel, Readonly<Record<Speaker, string>>>
> = {
  eleven_v4: elevenLabsVoices,
  eleven_v4_turbo: elevenLabsVoices,
  eleven_v3: elevenLabsVoices,
  eleven_flash_v2_5: elevenLabsVoices,
};

const speechSchema = z
  .strictObject({
    provider: z.enum(speechProviders),
    model: z.enum(speechModels),
    /** The model a line only known as it is said is said in: quicker. */
    quickModel: z.enum(speechModels).default("eleven_v4_turbo"),
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
 * Transcribe writes down speech, live and recorded, and ElevenLabs's
 * Eleven v4 says the lines, in the tone each is directed to.
 */
export const defaultPlatformAi = {
  conversion: { provider: "openai", model: "gpt-5.4-mini" },
  transcription: { provider: "openai", model: "gpt-4o-transcribe" },
  speech: {
    provider: "elevenlabs",
    model: "eleven_v4",
    quickModel: "eleven_v4_turbo",
    voices: defaultVoicesOf.eleven_v4,
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
  /** Where Grasp's own OpenAI and ElevenLabs projects keep their data: the EU unless set. */
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

/** Grasp's own AI features, as the settings name them and the ledger records them. */
export const platformAiFeatures = [
  "conversion",
  "transcription",
  "speech",
] as const satisfies readonly (keyof PlatformAi)[];

/** One of Grasp's own AI features. */
export type PlatformAiFeature = (typeof platformAiFeatures)[number];

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
