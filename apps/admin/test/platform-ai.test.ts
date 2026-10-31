import { platformAiSchema } from "@grasp-os/shared/platform-ai";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";

import { auditEvents } from "../src/db/schema.ts";
import {
  fetchPlatformAi,
  setPlatformAiFn,
} from "../src/platform-ai-functions.ts";
import { platformAiOf } from "../src/platform-ai.ts";
import { mockAccess } from "./access.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { db } from "./hosting.ts";
import { callServerFn, page } from "./pages.ts";
import { setStoreSecret, useStoreSecrets } from "./secrets-store.ts";

// Platform → AI: staff choose the provider and model of each of Grasp's
// own AI features once for every company. How it can go wrong, tried
// below: a provider offered or taken that Grasp has no key for, a key's
// value reaching the page, a change nobody can trace, and one made by
// someone Access doesn't vouch for.

const token = "test-deployer-token-platform-ai-7c2d14";
mockCloudflareApi(token);
// After the fake API: Access's keys are served, the rest goes to the fake.
mockAccess();

/** The settings with conversion on Anthropic's Claude Haiku, the rest the defaults. */
const onAnthropic = {
  ...platformAiSchema.parse({}),
  conversion: { provider: "anthropic", model: "claude-haiku-4-5" },
};

describe("Platform → AI", () => {
  useStoreSecrets({ deployer: token });

  it("offers only the providers Grasp has a key for, never showing a key, and takes another once its key is there", async () => {
    const before = await callServerFn(fetchPlatformAi);
    const shown = await page("/platform/ai");
    const refused = await callServerFn(setPlatformAiFn, {
      settings: onAnthropic,
    });
    await setStoreSecret(
      env.ANTHROPIC_API_KEY,
      "ANTHROPIC_API_KEY",
      "grasp-anthropic-key"
    );
    const taken = await callServerFn(setPlatformAiFn, {
      settings: onAnthropic,
    });
    const after = await platformAiOf(db);
    const [event] = await db
      .select({ actor: auditEvents.actor, detail: auditEvents.detail })
      .from(auditEvents)
      .where(eq(auditEvents.action, "platform.ai"));
    const detail: unknown = JSON.parse(event?.detail ?? "null");

    expect({
      keyed: before.keyed,
      settings: before.settings,
      status: shown.status,
      openAi: shown.html.includes("OpenAI"),
      anthropicOffered: shown.html.includes('value="anthropic"'),
      keyShown:
        shown.html.includes("grasp-openai-key") ||
        shown.html.includes("grasp-elevenlabs-key"),
      refused,
      taken,
      after,
      actor: event?.actor,
      detail,
    }).toStrictEqual({
      keyed: ["openai", "elevenlabs"],
      settings: platformAiSchema.parse({}),
      status: 200,
      openAi: true,
      anthropicOffered: false,
      keyShown: false,
      refused: { refused: "key_missing", changed: false },
      taken: { refused: null, changed: true },
      after: onAnthropic,
      actor: "staff@grasp.test",
      detail: {
        from: JSON.stringify(platformAiSchema.parse({})),
        to: JSON.stringify(onAnthropic),
      },
    });
  });

  it("keeps Grasp's OpenAI project and ElevenLabs account in the EU unless set, and refuses a speaker a voice Grasp didn't choose", async () => {
    const shown = await page("/platform/ai");
    const unsupported = await callServerFn(setPlatformAiFn, {
      settings: {
        ...platformAiSchema.parse({}),
        speech: {
          provider: "elevenlabs",
          model: "eleven_v4",
          voices: { stephen: "pNInz6obpgDQGcFmaJgB" },
        },
      },
    });
    const quicker = await callServerFn(setPlatformAiFn, {
      settings: {
        ...platformAiSchema.parse({}),
        speech: {
          provider: "elevenlabs",
          model: "eleven_v3",
          quickModel: "eleven_flash_v2_5",
          voices: { claire: "EXAVITQu4vr4xnSDxMaL" },
        },
      },
    });
    const { speech } = await platformAiOf(db);
    const inTheUs = await callServerFn(setPlatformAiFn, {
      settings: { ...platformAiSchema.parse({}), region: "us" },
    });
    const after = await platformAiOf(db);

    expect({
      region: platformAiSchema.parse({}).region,
      saysEu: [
        shown.html.includes("Runs at OpenAI, European Union"),
        shown.html.includes("Runs at ElevenLabs, European Union"),
      ],
      unsupported,
      quicker,
      speech,
      inTheUs,
      after: after.region,
    }).toStrictEqual({
      region: "eu",
      saysEu: [true, true],
      unsupported: { refused: "invalid", changed: false },
      quicker: { refused: null, changed: true },
      speech: {
        provider: "elevenlabs",
        model: "eleven_v3",
        quickModel: "eleven_flash_v2_5",
        voices: { claire: "EXAVITQu4vr4xnSDxMaL" },
      },
      inTheUs: { refused: null, changed: true },
      after: "us",
    });
  });

  it("is changed only by staff Access vouches for, from the admin's own pages", async () => {
    const settings = { conversion: { provider: "local" } };

    await expect(
      callServerFn(setPlatformAiFn, { settings }, { email: null })
    ).rejects.toThrow("The server function answered 403");
    await expect(
      callServerFn(
        setPlatformAiFn,
        { settings },
        { from: "https://elsewhere.test" }
      )
    ).rejects.toThrow("The server function answered 403");
    const after = await platformAiOf(db);
    expect(after.conversion.provider).not.toBe("local");
  });
});
