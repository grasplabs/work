import type { ModelEfforts } from "@grasp-os/shared/models";
import { describe, expect, it } from "vite-plus/test";

import { resolveChoice, switchModel } from "./model-choice.ts";

// The model and effort a question names, from what the person last chose
// and what core offers now: pure logic, so tested on its own. Storage is
// the browser's, and the e2e test reloads through it (e2e/chat.e2e.ts).

const large = "mistral/mistral-large-latest";
const small = "mistral/mistral-small-latest";
const opus = "anthropic/claude-opus-4-8";

const models = [large, small, opus];
const efforts: Record<string, ModelEfforts> = {
  [large]: { levels: [], default: null },
  [small]: { levels: ["low", "high", "max"], default: "high" },
  [opus]: {
    levels: ["low", "medium", "high", "xhigh", "max"],
    default: "medium",
  },
};

describe("the model and effort a question names", () => {
  it("is the default model at its default effort until the person chooses", () => {
    expect(resolveChoice([opus, small], efforts, {})).toStrictEqual({
      model: opus,
      effort: "medium",
      levels: ["low", "medium", "high", "xhigh", "max"],
    });
  });

  it("is what the person chose while core still offers it", () => {
    expect(
      resolveChoice(models, efforts, { model: small, effort: "max" })
    ).toMatchObject({ model: small, effort: "max" });
  });

  it("falls back to the model's default effort when it doesn't take the one chosen", () => {
    expect(
      resolveChoice(models, efforts, { model: small, effort: "medium" })
    ).toMatchObject({ model: small, effort: "high" });
  });

  it("names no effort for a model that doesn't think", () => {
    expect(
      resolveChoice(models, efforts, { model: large, effort: "max" })
    ).toStrictEqual({ model: large, effort: undefined, levels: [] });
  });

  it("falls back to the default model when the chosen one is no longer allowed", () => {
    expect(
      resolveChoice(models, efforts, { model: "openai/gone", effort: "max" })
    ).toMatchObject({ model: large, effort: undefined });
  });

  it("starts the model it falls back to at that model's default, not the effort chosen for the one gone", () => {
    expect(
      resolveChoice([opus, small], efforts, {
        model: "openai/gone",
        effort: "max",
      })
    ).toMatchObject({ model: opus, effort: "medium" });
  });

  it("names no effort before core says which models take one", () => {
    expect(resolveChoice(models, {}, { model: opus })).toStrictEqual({
      model: opus,
      effort: undefined,
      levels: [],
    });
  });

  it("keeps the effort shown when the person picks a model that takes it", () => {
    const shown = resolveChoice(models, efforts, {
      model: small,
      effort: "max",
    });
    expect(switchModel(efforts, shown, opus)).toStrictEqual({
      model: opus,
      effort: "max",
    });
  });

  it("never brings back an effort chosen for another model, out of sight since", () => {
    // Max on GLM, then Llama, which doesn't think: Opus starts at its own default.
    const onGlm = resolveChoice(models, efforts, {
      model: small,
      effort: "max",
    });
    const onLlama = switchModel(efforts, onGlm, large);
    const shown = resolveChoice(models, efforts, onLlama);
    expect(
      resolveChoice(models, efforts, switchModel(efforts, shown, opus))
    ).toMatchObject({ model: opus, effort: "medium" });
  });
});
