import { defaultGatewayModels } from "@grasp-os/shared/deployment-config";
import { describe, expect, it } from "vite-plus/test";

import { makerOf } from "./model-maker.ts";

describe("a model's maker", () => {
  it("is the org of a model Workers AI runs, not Workers AI", () => {
    expect(defaultGatewayModels.map(makerOf)).toStrictEqual([
      "DeepSeek",
      "Z.ai",
    ]);
    expect(
      [
        "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        "workers-ai/@cf/mistralai/mistral-small-3.1-24b-instruct",
        "workers-ai/@cf/google/gemma-3-12b-it",
        "workers-ai/@cf/openai/gpt-oss-120b",
        "workers-ai/@cf/cloudflare/clef",
      ].map(makerOf)
    ).toStrictEqual(["Meta", "Mistral AI", "Google", "OpenAI", "Cloudflare"]);
  });

  it("is the provider for a model its maker serves", () => {
    expect(
      [
        "anthropic/claude-opus-4-8",
        "bedrock-eu/eu.anthropic.claude-sonnet-4-5",
        "openai/gpt-4.1-mini",
      ].map(makerOf)
    ).toStrictEqual(["Anthropic", "Anthropic", "OpenAI"]);
  });

  it("is the org or provider itself when it isn't known", () => {
    expect(
      ["workers-ai/@cf/typesafe/jev", "elsewhere/model", ""].map(makerOf)
    ).toStrictEqual(["typesafe", "elsewhere", ""]);
  });
});
