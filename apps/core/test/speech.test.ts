import type { AuditEvent } from "@grasp-os/shared/audit";
import { maxSpeechChars } from "@grasp-os/shared/voice";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { modelLedger } from "../src/model-ledger.ts";
import { models } from "../src/models.ts";
import { platformSpeech } from "../src/speech.ts";
import { speechPcmBytesPerChar } from "./ai-providers-fake.ts";
import { allEvents } from "./audit-events.ts";
import { platformOpenAiKey } from "./connect-providers.ts";
import { fakeProviderFor } from "./model-provider.ts";
import { carrying, keyPlaces, plan } from "./platform-providers.ts";
import { outcome } from "./sign-in.ts";

// Speech through the model gateway: Grasp's own speech feature
// (@grasp-os/shared/platform-ai), OpenAI's by default, says a line, judged
// by the deployment's rules, charged per character to Grasp's own key
// (never the organization's budgets, which limit its own keys only) and
// audited like any model call, through connect with Grasp's own key.
// OpenAI is the outside system: a fake behind connect's fetch
// (test/ai-providers-fake.ts), which says 25 ms of silence a character.
// Connect, the rules, the ledger and the audit log are real.

const speechModel = "openai/gpt-4o-mini-tts";
/** A text model, as an organization chooses one: no speech model. */
const textModel = "mistral/mistral-large-latest";

/** Stephen's voice by default: an OpenAI voice. */
const voice = "cedar";

/** At GPT-4o mini TTS's $0.03 per 1,000 characters: 30 micros each. */
const microsPerChar = 30;

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

/** Core's env under the deployment's rules `config`, budgets counted in a month of its own. */
const withRules = (config: Record<string, unknown> = {}) => {
  const month = newMonth();
  const rulesEnv: Env = {
    ...env,
    MODEL_GATEWAY: config,
    MODEL_BUDGET_MONTH: month,
  };
  return { rulesEnv, month };
};

/** A person no other test uses, so their audit events are this test's. */
const newPerson = () =>
  ({ type: "person", userId: `person-${crypto.randomUUID()}` }) as const;

/** One of Stephen's lines in an interview, said for `trigger`. */
const stephen = (rulesEnv: Env, trigger: ReturnType<typeof newPerson>) =>
  platformSpeech(rulesEnv, {
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

/**
 * What Grasp's own key spent and holds in `month`: a line is charged
 * there, never against the organization's budgets.
 */
const graspSpent = async (month: string) => {
  const spent = await modelLedger(env).spendOf(month, ["platform"], 10);
  const [row] = spent.platform ?? [];
  return row ?? { spentMicros: 0, reservedMicros: 0 };
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
  it("says a line as WAV, with when each word is said, timed by the length of the audio", async () => {
    const { rulesEnv } = withRules();
    const line = newLine();

    const speech = await stephen(rulesEnv, newPerson()).speak({
      text: line,
      voice,
      language: "en",
    });

    const pcmBytes = line.length * speechPcmBytesPerChar;
    const header = new DataView(speech.audio.buffer, speech.audio.byteOffset);
    expect({
      riff: new TextDecoder().decode(speech.audio.subarray(0, 4)),
      wave: new TextDecoder().decode(speech.audio.subarray(8, 12)),
      sampleRate: header.getUint32(24, true),
      dataBytes: header.getUint32(40, true),
      bytes: speech.audio.byteLength,
      mime: speech.mime,
    }).toStrictEqual({
      riff: "RIFF",
      wave: "WAVE",
      sampleRate: 24_000,
      dataBytes: pcmBytes,
      bytes: 44 + pcmBytes,
      mime: "audio/wav",
    });
    // 18 characters at 25 ms: 450 ms, shared out by each word's characters
    // (16 but the spaces); punctuation stays with its word.
    const last = line.split(" ").at(-1);
    expect(speech.words).toStrictEqual([
      { text: "Hello", startMs: 0, endMs: 141 },
      { text: "there,", startMs: 141, endMs: 309 },
      { text: last, startMs: 309, endMs: 450 },
    ]);
    await expect(sentWith(line)).resolves.toStrictEqual([
      {
        host: "api.openai.com",
        path: "/v1/audio/speech",
        body: {
          model: "gpt-4o-mini-tts",
          input: line,
          voice,
          response_format: "pcm",
        },
      },
    ]);
  });

  it("sends how a line is said apart from the line, never said", async () => {
    const { rulesEnv } = withRules();
    const line = newLine();

    const speech = await stephen(rulesEnv, newPerson()).speak({
      text: line,
      voice,
      language: "en",
      instructions: "Say it in this tone: warm, relaxed.",
    });

    expect(speech.words.map(({ text }) => text).join(" ")).toBe(line);
    await expect(sentWith(line)).resolves.toMatchObject([
      {
        body: {
          input: line,
          instructions: "Say it in this tone: warm, relaxed.",
        },
      },
    ]);
  });

  it("sends Grasp's key only from connect, once, to OpenAI alone, and never logs or hands it back", async () => {
    const lines: string[] = [];
    for (const level of ["info", "warn", "error"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(JSON.stringify(args));
      });
    }
    const { rulesEnv } = withRules();
    const person = newPerson();
    const said = newLine();
    const refused = newLine();

    const speech = await stephen(rulesEnv, person).speak({
      text: said,
      voice,
      language: "nl",
    });
    await plan(platformOpenAiKey, [busy, busy]);
    const failed = await thrown(
      stephen(rulesEnv, person).speak({
        text: refused,
        voice,
        language: "nl",
      })
    );

    const events = await auditedFor(person.userId, 2);
    await expect(keyPlaces(said, platformOpenAiKey)).resolves.toStrictEqual({
      hosts: ["api.openai.com"],
      headers: ["authorization"],
      inBody: false,
      placeholder: false,
    });
    const seen = JSON.stringify([speech.words, failed, String(failed), events]);
    expect({
      logged: lines.some((logged) => logged.includes("model.failed")),
      inLogs: lines.some((logged) => logged.includes(platformOpenAiKey)),
      handedBack: seen.includes(platformOpenAiKey),
    }).toStrictEqual({ logged: true, inLogs: false, handedBack: false });
  });

  it("charges the line's characters to Grasp's own key, never to the organization's budgets, and audits it as a platform call", async () => {
    const { rulesEnv, month } = withRules({
      budgets: { user: { limit: 10 } },
    });
    const person = newPerson();
    const line = newLine();
    const lineMicros = line.length * microsPerChar;

    await stephen(rulesEnv, person).speak({
      text: line,
      voice,
      language: "en",
      model: speechModel,
    });

    await expect(graspSpent(month)).resolves.toMatchObject({
      spentMicros: lineMicros,
      reservedMicros: 0,
    });
    await expect(spentBy(month, person.userId)).resolves.toMatchObject({
      spentMicros: 0,
      reservedMicros: 0,
    });
    const [event] = await auditedFor(person.userId, 1);
    expect(event).toMatchObject({
      action: "model.call",
      model: { provider: "openai", model: "gpt-4o-mini-tts" },
      cost: { amount: lineMicros / 1_000_000, currency: "USD" },
      detail: {
        purpose: "onboarding.speech",
        outcome: "answered",
        characters: line.length,
        transport: "connect",
        credential: "platform",
        ledger: "settled",
        ledgerRequests: 1,
        ledgerCharged: lineMicros / 1_000_000,
      },
    });
    // Never the line itself.
    expect(JSON.stringify(event)).not.toContain(line);
  });

  it("says a line however little room the organization's budgets have: they limit its own keys, not Grasp's", async () => {
    // Less than a cent: less than a line of 600 characters costs (1.8¢).
    const { rulesEnv, month } = withRules({
      budgets: { deployment: { limit: 0.01 }, user: { limit: 0.01 } },
    });
    const person = newPerson();
    const line = `${newLine()} ${"a".repeat(maxSpeechChars - 19)}`;

    await stephen(rulesEnv, person).speak({
      text: line,
      voice,
      language: "en",
    });

    await expect(carrying(line)).resolves.toHaveLength(1);
    await expect(graspSpent(month)).resolves.toMatchObject({
      spentMicros: line.length * microsPerChar,
    });
    const [event] = await auditedFor(person.userId, 1);
    expect(event).toMatchObject({
      action: "model.call",
      detail: { outcome: "answered", purpose: "onboarding.speech" },
    });
  });

  it("refuses a model that isn't a speech model of the gateway's, and a speech model for a text call, sending nothing", async () => {
    // The organization chose a text model, which its text calls may use.
    const provider = await fakeProviderFor([textModel]);
    const { rulesEnv } = withRules();
    const line = newLine();
    const speak = async (model: string) =>
      await stephen(rulesEnv, newPerson()).speak({
        text: line,
        voice,
        language: "en",
        model,
      });

    // One the gateway doesn't offer.
    await expect(outcome(speak("openai/gpt-9-tts"))).resolves.toBe(
      "model.not_allowed"
    );
    // A text model can't say a line.
    await expect(outcome(speak(textModel))).resolves.toBe("model.not_allowed");
    // Nor can a speech model answer a text call.
    await expect(
      outcome(
        models(rulesEnv).call({
          model: speechModel,
          input: line,
          purpose: "onboarding.kickoff",
          trigger: newPerson(),
          work: { onboarding: true },
        })
      )
    ).resolves.toBe("model.not_allowed");
    await expect(carrying(line)).resolves.toStrictEqual([]);
    expect(provider.requests).toStrictEqual([]);
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
      const { rulesEnv } = withRules(rules);
      const person = newPerson();
      const line = newLine();

      await expect(
        outcome(
          stephen(rulesEnv, person).speak({
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

  it("says an onboarding line in a speech model the rules list for sensitive data and the EU", async () => {
    const { rulesEnv } = withRules({
      sensitive: { models: [speechModel] },
      eu: { models: [speechModel], deployment: true },
    });
    const person = newPerson();
    const line = newLine();

    await stephen(rulesEnv, person).speak({
      text: line,
      voice,
      language: "fr",
    });

    await expect(carrying(line)).resolves.toHaveLength(1);
    const [event] = await auditedFor(person.userId, 1);
    expect(event?.detail).toMatchObject({
      euOnly: "deployment",
      sensitive: "restricted",
    });
  });

  it("asks once more when the provider is busy, charging only the line it said", async () => {
    const { rulesEnv, month } = withRules({
      budgets: { user: { limit: 10 } },
    });
    const person = newPerson();
    const line = newLine();
    await plan(platformOpenAiKey, [
      { status: 429, body: { error: { type: "too_many_requests" } } },
    ]);

    const speech = await stephen(rulesEnv, person).speak({
      text: line,
      voice,
      language: "en",
    });

    expect(speech.words).toHaveLength(3);
    await expect(carrying(line)).resolves.toHaveLength(2);
    await expect(graspSpent(month)).resolves.toMatchObject({
      spentMicros: line.length * microsPerChar,
      reservedMicros: 0,
    });
    const [event] = await auditedFor(person.userId, 1);
    expect(event?.detail).toMatchObject({
      outcome: "answered",
      ledgerRequests: 2,
    });
  });

  it("gives up after asking once more, and says when to try again", async () => {
    const { rulesEnv } = withRules();
    const line = newLine();
    await plan(platformOpenAiKey, [busy, busy]);

    await expect(
      stephen(rulesEnv, newPerson()).speak({
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

  it("fails closed while the platform's AI settings don't parse, sending nothing", async () => {
    const { rulesEnv } = withRules();
    const line = newLine();

    await expect(
      outcome(
        stephen(
          {
            ...rulesEnv,
            PLATFORM_AI: { speech: { provider: "elevenlabs" } },
          },
          newPerson()
        ).speak({ text: line, voice, language: "en" })
      )
    ).resolves.toBe("model.unconfigured");
    await expect(carrying(line)).resolves.toStrictEqual([]);
  });

  it("refuses a line longer than one request may have said", async () => {
    const { rulesEnv } = withRules();
    const line = `${newLine()}${"a".repeat(maxSpeechChars)}`;

    await expect(
      outcome(
        stephen(rulesEnv, newPerson()).speak({
          text: line,
          voice,
          language: "en",
        })
      )
    ).resolves.toBe("model.invalid_call");
    await expect(carrying(line)).resolves.toStrictEqual([]);
  });
});
