import { aiProviderIds } from "@grasp-os/shared/ai-providers";
import {
  aiStatusReportPath,
  aiStatusReportPurpose,
  aiStatusReportSchema,
} from "@grasp-os/shared/ai-status-report";
import { hkdfHmacKey } from "@grasp-os/shared/client-secrets";
import { toHex } from "@grasp-os/shared/encoding";
import { platformUpdateSignatureHeader } from "@grasp-os/shared/platform-change";
import { quotaPolicyReportPurpose } from "@grasp-os/shared/quota-policy-report";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { models } from "../src/models.ts";
import { platformSpeech } from "../src/speech.ts";
import { platformOpenAiKey } from "./connect-providers.ts";
import { mockIdp } from "./idp.ts";
import {
  answeringProvider,
  connectModels,
  keyChanger,
  streamText,
} from "./model-provider.ts";
import { plan } from "./platform-providers.ts";
import { routed, signedInApi } from "./sign-in.ts";

// The organization's AI, for the admin: which providers it connected and
// how their calls last fared, from real calls through the gateway, and
// never a key. The ways it can fail, tried first: anyone but the admin
// reading it (unsigned, signed with another key or for another purpose,
// sent long ago, no request at all), and an answer that carries a key or
// its mask. And what Grasp's own features cost on its keys this month and
// last, from the ledger's charges for real calls through the gateway,
// where a call on the organization's own key never counts. The providers
// are faked behind connect's fetch (test/ai-providers-fake.ts).

const idp = mockIdp();

/** `body`'s signature as the admin makes it, for `purpose`. */
const signatureOf = async (
  body: string,
  secret = env.BETTER_AUTH_SECRET,
  purpose = aiStatusReportPurpose
): Promise<string> => {
  const key = await hkdfHmacKey(secret, purpose, ["sign"]);
  return toHex(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))
    )
  );
};

/** Asks core for its AI's status through the router, signed with `signature`. */
const ask = async (
  body: string,
  signature: string | null,
  method = "POST"
): Promise<Response> => {
  const headers = new Headers({ "content-type": "application/json" });
  if (signature !== null) {
    headers.set(platformUpdateSignatureHeader, signature);
  }
  return await routed(aiStatusReportPath, {
    method,
    headers,
    ...(method === "POST" ? { body } : {}),
  });
};

/** GPT-4o mini TTS at $0.03 per 1,000 characters: 30 micros each. */
const speechMicrosPerChar = 30;

/** GPT-4o Transcribe at $0.60 an hour, as the ledger pins it: micros per million seconds. */
const heardMicrosPerMillionSeconds = Math.ceil((0.6 / 3600) * 1e12);

/** The UTC month `monthsBack` before this one, such as `2026-09`. */
const monthBack = (monthsBack: number): string => {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsBack, 1)
  )
    .toISOString()
    .slice(0, 7);
};

/** Core's env with its model calls counted in `month`. */
const inMonth = (month: string): Env => ({
  ...env,
  MODEL_GATEWAY: {},
  MODEL_BUDGET_MONTH: month,
});

/** A person no other test uses. */
const newPerson = () =>
  ({ type: "person", userId: `person-${crypto.randomUUID()}` }) as const;

/** One of Stephen's lines said in `month`, on Grasp's key: its characters. */
const said = async (month: string): Promise<number> => {
  const text = `Hello there, ${crypto.randomUUID().slice(0, 4)}.`;
  await platformSpeech(inMonth(month), {
    purpose: "onboarding.speech",
    trigger: newPerson(),
    work: { onboarding: true },
  }).speak({ text, voice: "cedar", language: "en" });
  return text.length;
};

/** `seconds` of a recording heard in `month`, on Grasp's key. */
const heard = async (month: string, seconds: number): Promise<void> => {
  const listening = await models(inMonth(month)).listen({
    model: "openai/gpt-4o-transcribe",
    seconds,
    openMs: 60_000,
    purpose: "onboarding.hear",
    trigger: { type: "system" },
    work: { onboarding: true },
  });
  await listening.heard(seconds, "answered");
};

/** A PDF converted in `month`, on Grasp's key. */
const converted = async (month: string): Promise<void> => {
  await plan(platformOpenAiKey, [
    {
      sse: streamText("openai-responses", {
        text: "# Expense policy",
        inputTokens: 2000,
        outputTokens: 100,
      }),
    },
  ]);
  await models(inMonth(month)).platformCall({
    model: "openai/gpt-5.4-mini",
    purpose: "knowledge.conversion",
    trigger: newPerson(),
    work: { platform: "document_conversion" },
    input: "Write out this document as Markdown.",
    document: {
      name: "policy.pdf",
      mediaType: "application/pdf",
      bytes: new TextEncoder().encode("%PDF-1.4\n%%EOF\n"),
    },
  });
};

const bodyAt = (sentAt = new Date().toISOString()) =>
  JSON.stringify({ sentAt });

/** What core answers the admin's signed request, as its raw text. */
const reportText = async (): Promise<string> => {
  const body = bodyAt();
  const response = await ask(body, await signatureOf(body));
  expect(response.status).toBe(200);
  return await response.text();
};

/** The organization's providers as the report has them. */
const organizationOf = async () => {
  const { providers } = aiStatusReportSchema.parse(
    JSON.parse(await reportText())
  );
  return providers.filter(({ kind }) => kind === "organization");
};

describe("the organization's AI, for the admin", () => {
  it("answers none before a provider is connected, then each connected one, its default's first, with how its real calls last fared, and never a key", async () => {
    for (const provider of aiProviderIds) {
      // oxlint-disable-next-line no-await-in-loop -- one at a time
      await env.CONNECT.removeAiProviderKey(provider, keyChanger);
    }
    const none = await organizationOf();

    const key = `test-status-key-${crypto.randomUUID()}`;
    await connectModels(key, [
      "mistral/mistral-large-latest",
      "anthropic/claude-sonnet-4-5",
    ]);
    const unused = await organizationOf();

    // One call that works, then one the provider fails: as the gateway
    // noted them, by the organization's key.
    let fail = false;
    await answeringProvider(
      () =>
        fail ? undefined : { text: "OK", inputTokens: 10, outputTokens: 1 },
      { models: ["mistral/mistral-large-latest"] }
    );
    const { api } = await signedInApi(idp, "admin");
    const before = Date.now();
    await api.aiProviders.test("mistral");
    const working = await organizationOf();
    fail = true;
    await api.aiProviders.test("mistral");
    const failing = await organizationOf();
    const text = await reportText();

    const [worked] = working;
    const [failed] = failing;
    const unread = {
      kind: "organization",
      lastOkAt: null,
      lastFailedAt: null,
      lastFailure: null,
      failingClass: null,
      failingSince: null,
    };

    expect({
      none,
      unused,
      worked: {
        since: (worked?.lastOkAt ?? 0) >= before,
        failed: worked?.lastFailedAt,
      },
      failed: {
        provider: failed?.provider,
        after:
          (failed?.lastFailedAt ?? 0) >=
          (worked?.lastOkAt ?? Number.POSITIVE_INFINITY),
        how: typeof failed?.lastFailure,
        // Failing since that failure, the first after the call that worked.
        since: failed?.failingSince === failed?.lastFailedAt,
      },
      // Neither the key nor any part of its mask.
      keyShown: text.includes(key.slice(-4)) || text.includes("…"),
    }).toStrictEqual({
      none: [],
      unused: [
        { provider: "mistral", ...unread },
        { provider: "anthropic", ...unread },
      ],
      worked: { since: true, failed: null },
      failed: { provider: "mistral", after: true, how: "string", since: true },
      keyShown: false,
    });
  });

  it("sums what Grasp's own features cost on its keys this month and last, by feature and model, never a call on the organization's key", async () => {
    const thisMonth = monthBack(0);
    const lastMonth = monthBack(1);
    // On the organization's own key: never Grasp's cost.
    await connectModels(`test-spend-key-${crypto.randomUUID()}`, [
      "mistral/mistral-large-latest",
    ]);
    await answeringProvider(
      () => ({ text: "OK", inputTokens: 1000, outputTokens: 10 }),
      { models: ["mistral/mistral-large-latest"] }
    );
    const { api } = await signedInApi(idp, "admin");
    await api.aiProviders.test("mistral");

    await converted(thisMonth);
    const spoken = (await said(thisMonth)) + (await said(thisMonth));
    await heard(thisMonth, 30);
    const spokenBefore = await said(lastMonth);

    const { platformSpend } = aiStatusReportSchema.parse(
      JSON.parse(await reportText())
    );
    const conversion = platformSpend.thisMonth.rows.find(
      ({ feature }) => feature === "conversion"
    );

    expect({
      thisMonth: {
        period: platformSpend.thisMonth.period,
        rows: platformSpend.thisMonth.rows
          .filter(({ feature }) => feature !== "conversion")
          .toSorted((one, other) =>
            String(one.feature).localeCompare(String(other.feature))
          ),
        conversion: {
          model: conversion?.model,
          charged: (conversion?.micros ?? 0) > 0,
        },
      },
      lastMonth: platformSpend.lastMonth,
    }).toStrictEqual({
      thisMonth: {
        period: thisMonth,
        rows: [
          {
            feature: "speech",
            model: "openai/gpt-4o-mini-tts",
            micros: spoken * speechMicrosPerChar,
          },
          {
            feature: "transcription",
            model: "openai/gpt-4o-transcribe",
            micros: Math.ceil((30 * heardMicrosPerMillionSeconds) / 1e6),
          },
        ],
        conversion: { model: "openai/gpt-5.4-mini", charged: true },
      },
      lastMonth: {
        period: lastMonth,
        rows: [
          {
            feature: "speech",
            model: "openai/gpt-4o-mini-tts",
            micros: spokenBefore * speechMicrosPerChar,
          },
        ],
      },
    });
  });

  it("refuses anyone but the admin: unsigned, signed otherwise or for another purpose, sent long ago, or no request at all", async () => {
    const fresh = bodyAt();
    const old = bodyAt(new Date(Date.now() - 10 * 60 * 1000).toISOString());
    const statuses = await Promise.all([
      ask(fresh, null),
      ask(fresh, await signatureOf(fresh, "another-secret")),
      // The quota policy report's key reads nothing here.
      ask(
        fresh,
        await signatureOf(
          fresh,
          env.BETTER_AUTH_SECRET,
          quotaPolicyReportPurpose
        )
      ),
      ask(old, await signatureOf(old)),
      ask("{}", await signatureOf("{}")),
      ask(fresh, await signatureOf(fresh), "GET"),
    ]);

    expect(statuses.map(({ status }) => status)).toStrictEqual([
      403, 403, 403, 403, 403, 404,
    ]);
  });
});
