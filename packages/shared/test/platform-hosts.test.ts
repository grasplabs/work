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
  it("is the provider's EU data residency host, said to run in the EU, unless the deployment was set up otherwise", () => {
    expect([
      platformRouteOf("elevenlabs"),
      platformRouteOf("openai"),
      platformHostOf("elevenlabs"),
    ]).toStrictEqual([
      {
        host: "api.eu.residency.elevenlabs.io",
        region: "eu",
        whereItRuns: "ElevenLabs, European Union",
      },
      {
        host: "eu.api.openai.com",
        region: "eu",
        whereItRuns: "OpenAI, European Union",
      },
      "api.eu.residency.elevenlabs.io",
    ]);
  });

  it("is the provider's usual host, said to run where that is, on a deployment set up to test there", () => {
    expect([
      platformRouteOf("elevenlabs", ["elevenlabs"]),
      platformHostOf("elevenlabs", ["elevenlabs"]),
      // Only the provider named: OpenAI's stays where it was.
      platformHostOf("openai", ["elevenlabs"]),
      platformRouteOf("openai", ["openai"])?.host,
      platformRouteOf("openai", ["openai"])?.region,
    ]).toStrictEqual([
      {
        host: "api.elevenlabs.io",
        region: "us",
        whereItRuns: "ElevenLabs, United States",
      },
      "api.elevenlabs.io",
      "eu.api.openai.com",
      "api.openai.com",
      "us",
    ]);
  });

  it("takes from the setting only providers that have a usual host to test at", () => {
    expect([
      usualHostProviders("elevenlabs"),
      usualHostProviders(" elevenlabs , openai,nonsense,"),
      usualHostProviders("anthropic"),
      usualHostProviders(""),
      usualHostProviders(null),
      usualHostProviders(["elevenlabs"]),
    ]).toStrictEqual([
      ["elevenlabs"],
      ["elevenlabs", "openai"],
      [],
      [],
      [],
      [],
    ]);
    // A provider with no usual host named here goes where it always did.
    expect(platformHostOf("anthropic", ["anthropic"])).toBe(
      platformHostOf("anthropic")
    );
  });
});
