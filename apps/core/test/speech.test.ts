import type { AuditEvent } from "@grasp-os/shared/audit";
import { maxSpeechChars } from "@grasp-os/shared/voice";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { modelLedger } from "../src/model-ledger.ts";
import { models } from "../src/models.ts";
import type { ModelsEnv } from "../src/models.ts";
import { platformSpeech } from "../src/speech.ts";
import { speechBytesPerChar } from "./ai-providers-fake.ts";
import { allEvents } from "./audit-events.ts";
import { platformElevenLabsKey } from "./connect-providers.ts";
import { carrying, keyPlaces, plan } from "./platform-providers.ts";
import { outcome } from "./sign-in.ts";

// Speech through the model gateway: Grasp's own speech feature
// (@grasp-os/shared/platform-ai), ElevenLabs', says a line, judged by the
// deployment's rules, charged per character against its budgets and
// audited like any model call, through connect with Grasp's own key.
// ElevenLabs is the outside system: a fake behind connect's fetch
// (test/ai-providers-fake.ts), which says each character in 25 ms.
// Connect, the rules, the ledger and the audit log are real.

const speechModel = "elevenlabs/eleven_v4";
const quickModel = "elevenlabs/eleven_v4_turbo";
const textModel = "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** Stephen's voice by default: an ElevenLabs voice ID. */
const voice = "s3TPKV1kjDlVtZbl4Ksh";

/** What a line of `characters` costs at Eleven v4's $0.08 per 1,000: 80 micros each. */
const lineMicrosOf = (characters: number): number => characters * 80;

/**
 * A line of 18 characters no other test says, so what reached the
 * provider with it is this test's.
 */
const newLine = (): string =>
  `Hello there, ${crypto.randomUUID().slice(0, 4)}.`;

const busy = { status: 429, headers: { "retry-after": "7" } };

/** What `promise` threw, or `undefined` if it didn't. */
const thrown = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
};

let monthsUsed = 0;

/** A month no other test counts budgets in: from 2700, clear of other files. */
const newMonth = (): string => {
  monthsUsed += 1;
  return `${2700 + Math.floor(monthsUsed / 12)}-${String((monthsUsed % 12) + 1).padStart(2, "0")}`;
};

/** Core's env under the gateway config `config`, budgets counted in a month of its own. */
const withGateway = (config: Record<string, unknown> = {}) => {
  const month = newMonth();
  const gatewayEnv: ModelsEnv = {
    ...env,
    MODEL_GATEWAY: {
      gateway: "grasp-os-test",
      models: [textModel],
      ...config,
    },
    MODEL_BUDGET_MONTH: month,
  };
  return { gatewayEnv, month };
};

/** A person no other test uses, so their audit events are this test's. */
const newPerson = () =>
  ({ type: "person", userId: `person-${crypto.randomUUID()}` }) as const;

/** One of Stephen's lines in an interview, said for `trigger`. */
const stephen = (
  gatewayEnv: ModelsEnv,
  trigger: ReturnType<typeof newPerson>
) =>
  platformSpeech(gatewayEnv, {
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

/** A request's body, read as JSON. */
const jsonOf = (body: string): unknown => JSON.parse(body);

/** The requests that reached the provider with `line`, as JSON bodies. */
const sentWith = async (line: string) => {
  const carried = await carrying(line);
  return carried.map(({ host, path, body }) => ({
    host,
    path,
    body: jsonOf(body),
  }));
};

// A test waits up to 10 seconds for a line's audit events (`auditedFor`).
describe("speech through the model gateway", { timeout: 30_000 }, () => {
  it("says a line as MP3, with when each word is said, grouped from the characters' timing", async () => {
    const { gatewayEnv } = withGateway();
    const line = newLine();

    const speech = await stephen(gatewayEnv, newPerson()).speak({
      text: line,
      voice,
      language: "en",
    });

    expect({ bytes: speech.audio.byteLength, mime: speech.mime }).toStrictEqual(
      { bytes: line.length * speechBytesPerChar, mime: "audio/mpeg" }
    );
    // Each character takes the fake 25 ms; punctuation stays with its word.
    const last = line.split(" ").at(-1);
    expect(speech.words).toStrictEqual([
      { text: "Hello", startMs: 0, endMs: 125 },
      { text: "there,", startMs: 150, endMs: 300 },
      { text: last, startMs: 325, endMs: 450 },
    ]);
    // ElevenLabs keeps neither the line nor the audio.
    await expect(sentWith(line)).resolves.toStrictEqual([
      {
        host: "api.eu.residency.elevenlabs.io",
        path: `/v1/text-to-speech/${voice}/with-timestamps?enable_logging=false&output_format=mp3_44100_128`,
        body: {
          text: line,
          model_id: "eleven_v4",
          language_code: "en",
          seed: 7,
          voice_settings: { stability: 0.7, similarity_boost: 0.8 },
        },
      },
    ]);
  });

  it("says a quick line in Eleven v4 Turbo, at half the price", async () => {
    const { gatewayEnv, month } = withGateway({
      budgets: { user: { limit: 10 } },
    });
    const person = newPerson();
    const line = newLine();

    await stephen(gatewayEnv, person).speak({
      text: line,
      voice,
      language: "en",
      model: quickModel,
    });

    await expect(sentWith(line)).resolves.toMatchObject([
      { body: { model_id: "eleven_v4_turbo" } },
    ]);
    await expect(spentBy(month, person.userId)).resolves.toMatchObject({
      spentMicros: lineMicrosOf(line.length) / 2,
    });
  });

  it("refuses a voice the speech model doesn't have, charging nothing", async () => {
    const { gatewayEnv, month } = withGateway({
      budgets: { user: { limit: 10 } },
    });
    const person = newPerson();
    const line = newLine();

    await expect(
      outcome(
        stephen(gatewayEnv, person).speak({
          text: line,
          voice: "NotAVoiceOfGrasps0001",
          language: "en",
        })
      )
    ).resolves.toBe("model.failed");
    await expect(spentBy(month, person.userId)).resolves.toMatchObject({
      spentMicros: 0,
      reservedMicros: 0,
    });
  });

  it("sends Grasp's key only from connect, once, to ElevenLabs alone, and never logs or hands it back", async () => {
    const lines: string[] = [];
    for (const level of ["info", "warn", "error"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(JSON.stringify(args));
      });
    }
    const { gatewayEnv } = withGateway();
    const person = newPerson();
    const said = newLine();
    const refused = newLine();

    const speech = await stephen(gatewayEnv, person).speak({
      text: said,
      voice,
      language: "nl",
    });
    await plan(platformElevenLabsKey, [busy, busy]);
    const failed = await thrown(
      stephen(gatewayEnv, person).speak({
        text: refused,
        voice,
        language: "nl",
      })
    );

    const events = await auditedFor(person.userId, 2);
    await expect(keyPlaces(said, platformElevenLabsKey)).resolves.toStrictEqual(
      {
        hosts: ["api.eu.residency.elevenlabs.io"],
        headers: ["xi-api-key"],
        inBody: false,
        placeholder: false,
      }
    );
    const seen = JSON.stringify([speech.words, failed, String(failed), events]);
    expect({
      logged: lines.some((logged) => logged.includes("model.failed")),
      inLogs: lines.some((logged) => logged.includes(platformElevenLabsKey)),
      handedBack: seen.includes(platformElevenLabsKey),
    }).toStrictEqual({ logged: true, inLogs: false, handedBack: false });
  });

  it("charges the line's characters, and audits it as a platform call", async () => {
    const { gatewayEnv, month } = withGateway({
      budgets: { user: { limit: 10 } },
    });
    const person = newPerson();
    const line = newLine();
    const lineMicros = lineMicrosOf(line.length);

    await stephen(gatewayEnv, person).speak({
      text: line,
      voice,
      language: "en",
      model: speechModel,
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
        transport: "connect",
        credential: "platform",
        region: "eu",
        ledger: "settled",
        ledgerRequests: 1,
        ledgerCharged: lineMicros / 1_000_000,
      },
    });
    // Never the line itself.
    expect(JSON.stringify(event)).not.toContain(line);
  });

  it("refuses a line its budget has no room for, sending nothing", async () => {
    // A cent: less than a line of 600 characters costs at Eleven v4 (4.8¢).
    const { gatewayEnv } = withGateway({
      budgets: { user: { limit: 0.01 } },
    });
    const person = newPerson();
    const line = `${newLine()} ${"a".repeat(maxSpeechChars - 19)}`;

    await expect(
      outcome(
        stephen(gatewayEnv, person).speak({ text: line, voice, language: "en" })
      )
    ).resolves.toBe("model.over_budget");
    await expect(carrying(line)).resolves.toStrictEqual([]);
    const [event] = await auditedFor(person.userId, 1);
    expect(event).toMatchObject({
      action: "model.refused",
      detail: { reason: "model.over_budget", purpose: "onboarding.speech" },
    });
  });

  it("refuses a model that isn't a speech model of the gateway's, and a speech model for a text call, sending nothing", async () => {
    const { gatewayEnv } = withGateway();
    const line = newLine();
    const speak = async (model: string) =>
      await stephen(gatewayEnv, newPerson()).speak({
        text: line,
        voice,
        language: "en",
        model,
      });

    // One the gateway doesn't offer.
    await expect(outcome(speak("elevenlabs/eleven_v9"))).resolves.toBe(
      "model.not_allowed"
    );
    // A text model the deployment allows can't say a line.
    await expect(outcome(speak(textModel))).resolves.toBe("model.not_allowed");
    // Nor can a speech model answer a text call.
    await expect(
      outcome(
        models(gatewayEnv).call({
          model: speechModel,
          input: line,
          purpose: "onboarding.kickoff",
          trigger: newPerson(),
          work: { onboarding: true },
        })
      )
    ).resolves.toBe("model.not_allowed");
    await expect(carrying(line)).resolves.toStrictEqual([]);
  });

  it.each([
    [
      "the sensitive-data rule doesn't list it",
      { sensitive: { models: [textModel] } },
      "model.sensitive_data",
    ],
    [
      "the deployment must stay in the EU and Grasp's project is in the US, whatever its EU models list",
      {
        models: [textModel, speechModel],
        eu: { models: [textModel, speechModel], deployment: true },
      },
      "model.eu_only",
      { region: "us" },
    ],
  ])(
    "refuses an onboarding line when %s, sending nothing",
    async (_, rules, code, platform?: unknown) => {
      const { gatewayEnv: rulesEnv } = withGateway(rules);
      const gatewayEnv: ModelsEnv =
        platform === undefined
          ? rulesEnv
          : { ...rulesEnv, PLATFORM_AI: platform };
      const person = newPerson();
      const line = newLine();

      await expect(
        outcome(
          stephen(gatewayEnv, person).speak({
            text: line,
            voice,
            language: "de",
          })
        )
      ).resolves.toBe(code);
      await expect(carrying(line)).resolves.toStrictEqual([]);
      const [event] = await auditedFor(person.userId, 1);
      expect(event).toMatchObject({
        action: "model.refused",
        detail: { reason: code, model: speechModel },
      });
    }
  );

  it("says an EU-only deployment's line at ElevenLabs's EU residency host, where Grasp's account keeps its data, whatever its EU models list", async () => {
    const { gatewayEnv } = withGateway({
      models: [textModel, speechModel],
      sensitive: { models: [speechModel] },
      eu: { models: [textModel], deployment: true },
    });
    const person = newPerson();
    const line = newLine();

    await stephen(gatewayEnv, person).speak({
      text: line,
      voice,
      language: "fr",
    });

    const sent = await carrying(line);
    expect(sent.map(({ host }) => host)).toStrictEqual([
      "api.eu.residency.elevenlabs.io",
    ]);
    const [event] = await auditedFor(person.userId, 1);
    expect(event?.detail).toMatchObject({
      euOnly: "deployment",
      sensitive: "restricted",
      region: "eu",
    });
  });

  it("asks once more when the provider is busy, charging only the line it said", async () => {
    const { gatewayEnv, month } = withGateway({
      budgets: { user: { limit: 10 } },
    });
    const person = newPerson();
    const line = newLine();
    await plan(platformElevenLabsKey, [
      { status: 429, body: { error: { type: "too_many_requests" } } },
    ]);

    const speech = await stephen(gatewayEnv, person).speak({
      text: line,
      voice,
      language: "en",
    });

    expect(speech.words).toHaveLength(3);
    await expect(carrying(line)).resolves.toHaveLength(2);
    await expect(spentBy(month, person.userId)).resolves.toMatchObject({
      spentMicros: lineMicrosOf(line.length),
      reservedMicros: 0,
    });
    const [event] = await auditedFor(person.userId, 1);
    expect(event?.detail).toMatchObject({
      outcome: "answered",
      ledgerRequests: 2,
    });
  });

  it("gives up after asking once more, and says when to try again", async () => {
    const { gatewayEnv } = withGateway();
    const line = newLine();
    await plan(platformElevenLabsKey, [busy, busy]);

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
    await expect(carrying(line)).resolves.toHaveLength(2);
  });

  it("says a line on plain workerd, with no AI binding, as on-prem", async () => {
    const { gatewayEnv } = withGateway();
    const { AI: _binding, ...onPrem } = gatewayEnv;

    const speech = await stephen(onPrem, newPerson()).speak({
      text: newLine(),
      voice,
      language: "en",
    });

    expect(speech.mime).toBe("audio/mpeg");
  });

  it("fails closed while the platform's AI settings don't parse, sending nothing", async () => {
    const { gatewayEnv } = withGateway();
    const line = newLine();

    await expect(
      outcome(
        stephen(
          {
            ...gatewayEnv,
            PLATFORM_AI: { speech: { provider: "openai" } },
          },
          newPerson()
        ).speak({ text: line, voice, language: "en" })
      )
    ).resolves.toBe("model.unconfigured");
    await expect(carrying(line)).resolves.toStrictEqual([]);
  });

  it("refuses a line longer than one request may have said", async () => {
    const { gatewayEnv } = withGateway();
    const line = `${newLine()}${"a".repeat(maxSpeechChars)}`;

    await expect(
      outcome(
        stephen(gatewayEnv, newPerson()).speak({
          text: line,
          voice,
          language: "en",
        })
      )
    ).resolves.toBe("model.invalid_call");
    await expect(carrying(line)).resolves.toStrictEqual([]);
  });
});
