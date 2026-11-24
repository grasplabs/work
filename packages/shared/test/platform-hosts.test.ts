import { describe, expect, it } from "vite-plus/test";

import {
  platformHostOf,
  platformRouteOf,
  usualHostProviders,
} from "../src/ai-providers.ts";

// Where Grasp's own key for a provider goes. These start from the ways it
// can fail: a platform feature leaving the EU on a deployment nobody set
// up for it; a setting sending more providers out than the one it is
// for; a deployment telling its admins a feature runs in the EU when it
// was sent elsewhere.

describe("where a platform feature's requests go", () => {
  it("is the provider's EU host, said to run in the EU, unless the deployment was set up otherwise", () => {
    expect([
      platformRouteOf("mistral"),
      platformRouteOf("openai"),
      platformHostOf("mistral"),
    ]).toStrictEqual([
      // Mistral's one host is in the EU.
      {
        host: "api.mistral.ai",
        region: "eu",
        whereItRuns: "Mistral AI, European Union (France)",
      },
      {
        host: "eu.api.openai.com",
        region: "eu",
        whereItRuns: "OpenAI, European Union",
      },
      "api.mistral.ai",
    ]);
  });

  it("is the provider's usual host, said to run where that is, on a deployment set up to test there", () => {
    expect([
      platformRouteOf("openai", ["openai"]),
      platformHostOf("openai", ["openai"]),
      // Only the provider named: with another named, OpenAI's stays where
      // it was.
      platformHostOf("openai", ["anthropic"]),
    ]).toStrictEqual([
      {
        host: "api.openai.com",
        region: "us",
        whereItRuns: "OpenAI, United States",
      },
      "api.openai.com",
      "eu.api.openai.com",
    ]);
  });

  it("takes from the setting only providers that have a usual host to test at", () => {
    expect([
      usualHostProviders("openai"),
      usualHostProviders(" mistral , openai,nonsense,"),
      usualHostProviders("mistral"),
      usualHostProviders("anthropic"),
      usualHostProviders(""),
      usualHostProviders(null),
      usualHostProviders(["openai"]),
    ]).toStrictEqual([["openai"], ["openai"], [], [], [], [], []]);
    // A provider with no usual host named here goes where it always did:
    // Mistral's speech stays at its EU host.
    expect([
      platformRouteOf("mistral", ["mistral"]),
      platformHostOf("anthropic", ["anthropic"]),
    ]).toStrictEqual([platformRouteOf("mistral"), platformHostOf("anthropic")]);
  });
});
