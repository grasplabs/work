import type { ModelEfforts } from "@grasp-os/shared/models";
import { describe, expect, it } from "vite-plus/test";

import { resolveChoice } from "./model-choice.ts";

// The model and effort a question names, from what the person last chose
// and what core offers now: pure logic, so tested on its own. Storage is
// the browser's, and the e2e test reloads through it (e2e/chat.e2e.ts).

const llama = "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const glm = "workers-ai/@cf/zai-org/glm-5.3-flash";
const opus = "anthropic/claude-opus-4-8";

const models = [llama, glm, opus];
const efforts: Record<string, ModelEfforts> = {
  [llama]: { levels: [], default: null },
  [glm]: { levels: ["low", "high", "max"], default: "high" },
  [opus]: {
    levels: ["low", "medium", "high", "xhigh", "max"],
    default: "medium",
  },
};

describe("the model and effort a question names", () => {
  it("is the default model at its default effort until the person chooses", () => {
    expect(resolveChoice([opus, glm], efforts, {})).toStrictEqual({
      model: opus,
      effort: "medium",
      levels: ["low", "medium", "high", "xhigh", "max"],
    });
  });

  it("is what the person chose while core still offers it", () => {
    expect(
      resolveChoice(models, efforts, { model: glm, effort: "max" })
    ).toMatchObject({ model: glm, effort: "max" });
  });

  it("falls back to the model's default effort when it doesn't take the one chosen", () => {
    expect(
      resolveChoice(models, efforts, { model: glm, effort: "medium" })
    ).toMatchObject({ model: glm, effort: "high" });
  });

  it("names no effort for a model that doesn't think", () => {
    expect(
      resolveChoice(models, efforts, { model: llama, effort: "max" })
    ).toStrictEqual({ model: llama, effort: undefined, levels: [] });
  });

  it("falls back to the default model when the chosen one is no longer allowed", () => {
    expect(
      resolveChoice(models, efforts, { model: "openai/gone", effort: "max" })
    ).toMatchObject({ model: llama, effort: undefined });
  });

  it("names no effort before core says which models take one", () => {
    expect(resolveChoice(models, {}, { model: opus })).toStrictEqual({
      model: opus,
      effort: undefined,
      levels: [],
    });
  });
});
