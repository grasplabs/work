import { describe, expect, it } from "vite-plus/test";

import {
  defaultPlatformAi,
  defaultVoicesOf,
  parsePlatformAi,
} from "../src/platform-ai.ts";

// The `PLATFORM_AI` var as core reads it: each of Grasp's own AI features'
// provider and model, OpenAI's defaults for what it leaves out, and nothing
// that doesn't parse passed off as a setting.

describe("the platform's AI settings", () => {
  it("are OpenAI's defaults for an empty setting", () => {
    expect(parsePlatformAi({})).toStrictEqual(defaultPlatformAi);
  });

  it("give each speaker one of the ElevenLabs voices Grasp chose when the settings name none", () => {
    expect(
      parsePlatformAi({
        speech: { provider: "elevenlabs", model: "eleven_v3" },
      })?.speech
    ).toStrictEqual({
      provider: "elevenlabs",
      model: "eleven_v3",
      quickModel: "eleven_v4_turbo",
      voices: {
        stephen: "s3TPKV1kjDlVtZbl4Ksh",
        claire: "r1KmysJdVYZjJCm4mL3b",
        lisa: "EXAVITQu4vr4xnSDxMaL",
        mark: "cjVigY5qzO86Huf0OWal",
        tim: "TX3LPaxmHKxFdv7VOQHJ",
      },
    });
  });

  it("keep Grasp's OpenAI and ElevenLabs projects in the EU unless set", () => {
    expect([
      parsePlatformAi({})?.region,
      parsePlatformAi({ region: "us" })?.region,
    ]).toStrictEqual(["eu", "us"]);
  });

  it("switch a feature by configuration, keeping the defaults for the rest", () => {
    expect(
      parsePlatformAi({
        conversion: { provider: "anthropic", model: "claude-haiku-4-5" },
        speech: {
          provider: "elevenlabs",
          model: "eleven_flash_v2_5",
          voices: { claire: "EXAVITQu4vr4xnSDxMaL" },
        },
      })
    ).toStrictEqual({
      conversion: { provider: "anthropic", model: "claude-haiku-4-5" },
      transcription: defaultPlatformAi.transcription,
      speech: {
        provider: "elevenlabs",
        model: "eleven_flash_v2_5",
        quickModel: "eleven_v4_turbo",
        // The rest in the model's own default voices.
        voices: {
          ...defaultVoicesOf.eleven_flash_v2_5,
          claire: "EXAVITQu4vr4xnSDxMaL",
        },
      },
      region: "eu",
    });
  });

  it("read every file locally where conversion says local", () => {
    expect(
      parsePlatformAi({ conversion: { provider: "local" } })?.conversion
    ).toStrictEqual({ provider: "local" });
  });

  it.each([
    [
      "a provider a feature can't use",
      { speech: { provider: "anthropic", model: "x" } },
    ],
    [
      "a provider there isn't",
      { transcription: { provider: "elevenlabs", model: "scribe_v2" } },
    ],
    ["a feature there isn't", { voice: { provider: "openai" } }],
    [
      "a key of a feature's there isn't",
      {
        conversion: { provider: "openai", model: "gpt-5.4-mini", region: "eu" },
      },
    ],
    [
      "a model name that isn't one",
      { conversion: { provider: "openai", model: "../files" } },
    ],
    [
      "a voice that isn't one",
      {
        speech: {
          provider: "elevenlabs",
          model: "eleven_v4",
          voices: { stephen: "a voice" },
        },
      },
    ],
    [
      "a speaker there isn't",
      {
        speech: {
          provider: "elevenlabs",
          model: "eleven_v4",
          voices: { adam: "s3TPKV1kjDlVtZbl4Ksh" },
        },
      },
    ],
    [
      "a voice that isn't one Grasp chose",
      {
        speech: {
          provider: "elevenlabs",
          model: "eleven_v4",
          voices: { stephen: "pNInz6obpgDQGcFmaJgB" },
        },
      },
    ],
    [
      "a speech model there isn't",
      { speech: { provider: "elevenlabs", model: "eleven_v9" } },
    ],
    [
      "speech on a provider other than ElevenLabs",
      { speech: { provider: "openai", model: "gpt-4o-mini-tts" } },
    ],
    ["a region there isn't", { region: "asia" }],
    ["nothing at all", null],
    ["no setting, rather than an empty one", undefined],
  ])("refuse %s", (_, value) => {
    expect(parsePlatformAi(value)).toBeUndefined();
  });
});
