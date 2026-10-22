import type { AuditEvent } from "@grasp-os/shared/audit";
import { maxSpeechChars } from "@grasp-os/shared/voice";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { modelLedger } from "../src/model-ledger.ts";
import { gatewaySettings, models } from "../src/models.ts";
import type { ModelsEnv } from "../src/models.ts";
import { gatewaySpeech } from "../src/speech.ts";
import { fakeGateway } from "./ai-gateway.ts";
import type { GatewayReply } from "./ai-gateway.ts";
import { allEvents } from "./audit-events.ts";
import { outcome } from "./sign-in.ts";

// Speech through the model gateway: a voice model says a line, judged by
// the deployment's rules, charged per character against its budgets and
// audited like any model call. AI Gateway, and ElevenLabs behind it, is
// the outside system: a fake behind the AI binding. The rules, the ledger
// and the audit log are real.

const voiceModel = "elevenlabs/eleven_v4";
const quickVoice = "elevenlabs/eleven_v4_turbo";
const textModel = "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** Stephen's voice in the prototype: an ElevenLabs voice ID. */
const voice = "s3TPKV1kjDlVtZbl4Ksh";

const said: GatewayReply = { speech: { audio: "mp3 bytes" } };

/** 17 characters: at Eleven v4's $0.08 per 1,000, 80 micros each. */
const line = "Hello there, Ada.";
const lineMicros = 17 * 80;

let monthsUsed = 0;

/** A month no other test counts budgets in: from 2700, clear of other files. */
const newMonth = (): string => {
  monthsUsed += 1;
  return `${2700 + Math.floor(monthsUsed / 12)}-${String((monthsUsed % 12) + 1).padStart(2, "0")}`;
};

/** Core's env with the fake gateway answering `replies`, under `config`. */
const withGateway = (
  replies: GatewayReply[],
  config: Record<string, unknown> = {}
) => {
  const gateway = fakeGateway(...replies);
  const month = newMonth();
  const gatewayEnv: ModelsEnv = {
    ...env,
    AI: gateway.binding,
    MODEL_GATEWAY: {
      gateway: "grasp-os-test",
      models: [textModel, voiceModel, quickVoice],
      ...config,
    },
    MODEL_BUDGET_MONTH: month,
  };
  return { gateway, gatewayEnv, month };
};

/** A person no other test uses, so their audit events are this test's. */
const newPerson = () =>
  ({ type: "person", userId: `person-${crypto.randomUUID()}` }) as const;

/** One of Stephen's lines in an interview, said for `trigger`. */
const stephen = (
  gatewayEnv: ModelsEnv,
  trigger: ReturnType<typeof newPerson>
) =>
  gatewaySpeech(gatewayEnv, {
    purpose: "onboarding.speech",
    trigger,
    work: { onboarding: true },
  });

/** The audit events triggered by `userId`, once `count` have arrived. */
const auditedFor = async (
  userId: string,
  count: number
): Promise<AuditEvent[]> => {
  const mine = async () => {
    const events = await allEvents();
    return events.filter(
      ({ actor }) => actor.type === "person" && actor.userId === userId
    );
  };
  await vi.waitFor(
    async () => {
      await expect(mine()).resolves.toHaveLength(count);
    },
    { timeout: 10_000, interval: 50 }
  );
  return await mine();
};

/** What `userId` spent and holds in `month`, as the ledger counts it. */
const spentBy = async (month: string, userId: string) => {
  const spent = await modelLedger(env).spendOf(month, ["user"], 1000);
  return (
    spent.user?.find(({ key }) => key === userId) ?? {
      spentMicros: 0,
      reservedMicros: 0,
    }
  );
};

// A test waits up to 10 seconds for a line's audit events (`auditedFor`).
describe("speech through the model gateway", { timeout: 30_000 }, () => {
  it("says a line, with when each word is said, grouped from the characters' timing", async () => {
    const { gateway, gatewayEnv } = withGateway([said]);

    const speech = await stephen(gatewayEnv, newPerson()).speak({
      text: line,
      voice,
      language: "en",
      model: voiceModel,
    });

    expect({
      audio: new TextDecoder().decode(speech.audio),
      mime: speech.mime,
    }).toStrictEqual({ audio: "mp3 bytes", mime: "audio/mpeg" });
    // Each character takes the fake 100 ms; punctuation stays with its word.
    expect(speech.words).toStrictEqual([
      { text: "Hello", startMs: 0, endMs: 500 },
      { text: "there,", startMs: 600, endMs: 1200 },
      { text: "Ada.", startMs: 1300, endMs: 1700 },
    ]);
    const sent = gateway.requests.map(({ url, body }) => {
      const { origin, pathname } = new URL(url);
      return { route: `${origin}${pathname}`, body };
    });
    expect(sent).toMatchObject([
      {
        route: `https://workers-binding.ai/ai-gateway/gateways/grasp-os-test/elevenlabs/v1/text-to-speech/${voice}/with-timestamps`,
        body: { text: line, model_id: "eleven_v4", language_code: "en" },
      },
    ]);
  });

  it("sends no provider key, and asks ElevenLabs to keep nothing", async () => {
    const { gateway, gatewayEnv } = withGateway([said]);

    await stephen(gatewayEnv, newPerson()).speak({
      text: line,
      voice,
      language: "nl",
    });

    const [request] = gateway.requests;
    expect(new URL(request?.url ?? "").searchParams.get("enable_logging")).toBe(
      "false"
    );
    const headers = request?.headers ?? new Headers();
    expect(headers.get("xi-api-key")).toBeNull();
    expect(headers.get("authorization")).toBeNull();
    // Only the binding's placeholder, which the gateway strips.
    expect(headers.get("cf-aig-authorization")).toBe(
      "Bearer cloudflare-gateway-binding"
    );
    expect(headers.get("cf-aig-collect-log-payload")).toBe("false");
  });

  it("charges the line's characters against the budgets, and audits it as a model call", async () => {
    const { gatewayEnv, month } = withGateway([said], {
      budgets: { user: { limit: 10 } },
    });
    const person = newPerson();

    await stephen(gatewayEnv, person).speak({
      text: line,
      voice,
      language: "en",
      model: voiceModel,
    });

    await expect(spentBy(month, person.userId)).resolves.toMatchObject({
      spentMicros: lineMicros,
      reservedMicros: 0,
    });
    const [event] = await auditedFor(person.userId, 1);
    expect(event).toMatchObject({
      action: "model.call",
      model: { provider: "elevenlabs", model: "eleven_v4" },
      cost: { amount: lineMicros / 1_000_000, currency: "USD" },
      detail: {
        purpose: "onboarding.speech",
        outcome: "answered",
        characters: line.length,
        ledger: "settled",
        ledgerRequests: 1,
        ledgerCharged: lineMicros / 1_000_000,
      },
    });
    // Never the line itself.
    expect(JSON.stringify(event)).not.toContain("Ada");
  });

  it("refuses a line its budget has no room for, sending nothing", async () => {
    // A cent: less than a line of 600 characters costs at Eleven v4 (4.8¢).
    const { gateway, gatewayEnv } = withGateway([said], {
      budgets: { user: { limit: 0.01 } },
    });
    const person = newPerson();

    await expect(
      outcome(
        stephen(gatewayEnv, person).speak({
          text: "a".repeat(maxSpeechChars),
          voice,
          language: "en",
        })
      )
    ).resolves.toBe("model.over_budget");
    expect(gateway.requests).toStrictEqual([]);
    const [event] = await auditedFor(person.userId, 1);
    expect(event).toMatchObject({
      action: "model.refused",
      detail: { reason: "model.over_budget", purpose: "onboarding.speech" },
    });
  });

  it("refuses a voice model the deployment doesn't allow, and a text model for speech, sending nothing", async () => {
    const { gateway, gatewayEnv } = withGateway([said], {
      models: [textModel, quickVoice],
    });
    const speak = async (model: string) =>
      await stephen(gatewayEnv, newPerson()).speak({
        text: line,
        voice,
        language: "en",
        model,
      });

    // A voice model the gateway offers, but not this deployment.
    await expect(outcome(speak(voiceModel))).resolves.toBe("model.not_allowed");
    // One it doesn't offer at all.
    await expect(outcome(speak("elevenlabs/eleven_v9"))).resolves.toBe(
      "model.not_allowed"
    );
    // A text model the deployment allows can't say a line.
    await expect(outcome(speak(textModel))).resolves.toBe("model.not_allowed");
    expect(gateway.requests).toStrictEqual([]);
  });

  it("refuses a voice model for a text call, sending nothing", async () => {
    const { gateway, gatewayEnv } = withGateway([said]);

    await expect(
      outcome(
        models(gatewayEnv).call({
          model: voiceModel,
          input: "Say hello.",
          purpose: "onboarding.kickoff",
          trigger: newPerson(),
          work: { onboarding: true },
        })
      )
    ).resolves.toBe("model.not_allowed");
    expect(gateway.requests).toStrictEqual([]);
  });

  it("offers voice models apart from text models, so nothing that picks a text model gets one", () => {
    const { gatewayEnv } = withGateway([], {
      models: [voiceModel, textModel],
    });

    expect(gatewaySettings(gatewayEnv)).toMatchObject({
      models: [textModel],
      voices: [voiceModel],
    });
  });

  it.each([
    [
      "the sensitive-data rule doesn't list it",
      { sensitive: { models: [textModel] } },
      "model.sensitive_data",
    ],
    [
      "the deployment must stay in the EU and it isn't hosted there",
      { eu: { models: [textModel], deployment: true } },
      "model.eu_only",
    ],
  ])(
    "refuses an onboarding line when %s, sending nothing",
    async (_, rules, code) => {
      const { gateway, gatewayEnv } = withGateway([said], rules);
      const person = newPerson();

      await expect(
        outcome(
          stephen(gatewayEnv, person).speak({
            text: line,
            voice,
            language: "de",
            model: voiceModel,
          })
        )
      ).resolves.toBe(code);
      expect(gateway.requests).toStrictEqual([]);
      const [event] = await auditedFor(person.userId, 1);
      expect(event).toMatchObject({
        action: "model.refused",
        detail: { reason: code, model: voiceModel },
      });
    }
  );

  it("says an onboarding line in a voice model the rules list for sensitive data and the EU", async () => {
    const { gateway, gatewayEnv } = withGateway([said], {
      sensitive: { models: [voiceModel] },
      eu: { models: [voiceModel], deployment: true },
    });
    const person = newPerson();

    await stephen(gatewayEnv, person).speak({
      text: line,
      voice,
      language: "fr",
      model: voiceModel,
    });

    expect(gateway.requests).toHaveLength(1);
    const [event] = await auditedFor(person.userId, 1);
    expect(event?.detail).toMatchObject({
      euOnly: "deployment",
      sensitive: "restricted",
    });
  });

  it("asks once more when the provider is busy, charging only the line it said", async () => {
    const { gateway, gatewayEnv, month } = withGateway(
      [{ status: 429, errorType: "too_many_concurrent_requests" }, said],
      { budgets: { user: { limit: 10 } } }
    );
    const person = newPerson();

    const speech = await stephen(gatewayEnv, person).speak({
      text: line,
      voice,
      language: "en",
    });

    expect(speech.words).toHaveLength(3);
    expect(gateway.requests).toHaveLength(2);
    await expect(spentBy(month, person.userId)).resolves.toMatchObject({
      spentMicros: lineMicros,
      reservedMicros: 0,
    });
    const [event] = await auditedFor(person.userId, 1);
    expect(event?.detail).toMatchObject({
      outcome: "answered",
      ledgerRequests: 2,
    });
  });

  it("gives up after asking once more, and says when to try again", async () => {
    const busy: GatewayReply = {
      status: 429,
      headers: { "retry-after": "7" },
    };
    const { gateway, gatewayEnv } = withGateway([busy, busy, said]);

    await expect(
      stephen(gatewayEnv, newPerson()).speak({
        text: line,
        voice,
        language: "en",
      })
    ).rejects.toMatchObject({
      code: "model.rate_limited",
      details: { retryAfterSeconds: 7 },
    });
    expect(gateway.requests).toHaveLength(2);
  });

  it("fails closed on plain workerd, with no AI binding", async () => {
    const { gatewayEnv } = withGateway([said]);
    const { AI: _binding, ...onPrem } = gatewayEnv;

    await expect(
      outcome(
        stephen(onPrem, newPerson()).speak({
          text: line,
          voice,
          language: "en",
        })
      )
    ).resolves.toBe("model.unconfigured");
  });

  it("refuses a line longer than one request may have said", async () => {
    const { gateway, gatewayEnv } = withGateway([said]);

    await expect(
      outcome(
        stephen(gatewayEnv, newPerson()).speak({
          text: "a".repeat(maxSpeechChars + 1),
          voice,
          language: "en",
        })
      )
    ).resolves.toBe("model.invalid_call");
    expect(gateway.requests).toStrictEqual([]);
  });
});
