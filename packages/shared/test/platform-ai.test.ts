import { describe, expect, it } from "vite-plus/test";

import { defaultPlatformAi, parsePlatformAi } from "../src/platform-ai.ts";

// The `PLATFORM_AI` var as core reads it: each of Grasp's own AI features'
// provider and model, OpenAI's defaults for what it leaves out, and nothing
// that doesn't parse passed off as a setting.

describe("the platform's AI settings", () => {
  it("are OpenAI's defaults while unset", () => {
    expect(parsePlatformAi()).toStrictEqual(defaultPlatformAi);
    expect(parsePlatformAi({})).toStrictEqual(defaultPlatformAi);
  });

  it("switch a feature by configuration, keeping the defaults for the rest", () => {
    expect(
      parsePlatformAi({
        conversion: { provider: "anthropic", model: "claude-haiku-4-5" },
        speech: {
          provider: "openai",
          model: "tts-1-hd",
          voices: { claire: "sage" },
        },
      })
    ).toStrictEqual({
      conversion: { provider: "anthropic", model: "claude-haiku-4-5" },
      transcription: defaultPlatformAi.transcription,
      speech: {
        provider: "openai",
        model: "tts-1-hd",
        voices: { ...defaultPlatformAi.speech.voices, claire: "sage" },
      },
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
          provider: "openai",
          model: "gpt-4o-mini-tts",
          voices: { stephen: "a voice" },
        },
      },
    ],
    [
      "a speaker there isn't",
      {
        speech: {
          provider: "openai",
          model: "gpt-4o-mini-tts",
          voices: { adam: "ash" },
        },
      },
    ],
  ])("refuse %s", (_, value) => {
    expect(parsePlatformAi(value)).toBeUndefined();
  });
});
