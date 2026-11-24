import type { AuditEvent } from "@grasp-os/shared/audit";
import { maxSpeechChars } from "@grasp-os/shared/voice";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { models } from "../src/models.ts";
import { platformSpeech } from "../src/speech.ts";
import { speechBytesPerChar } from "./ai-providers-fake.ts";
import { allEvents } from "./audit-events.ts";
import { platformMistralKey } from "./connect-providers.ts";
import { fakeProviderFor } from "./model-provider.ts";
import { spentMicros } from "./model-usage.ts";
import { carrying, keyPlaces, plan } from "./platform-providers.ts";
import { outcome, uniqueLetters } from "./sign-in.ts";

// Speech through the model gateway: Grasp's own speech feature
// (@grasp-os/shared/platform-ai), Mistral's Voxtral, says a line, judged by
// the deployment's rules, charged per character to Grasp's own key (never
// the organization's spend) and audited
// like any model call, through connect with Grasp's own key.
// Mistral is the outside system: a fake behind connect's fetch
// (test/ai-providers-fake.ts), which says each character in 30 ms.
// Connect, the rules, the usage record and the audit log are real.

const speechModel = "mistral/voxtral-mini-tts-3-0";
/** A text model, as an organization chooses one: no speech model. */
const textModel = "mistral/mistral-large-latest";

/** Stephen's voice by default: a Mistral voice ID. */
const voice = "voice_485";

/** What a line of `characters` costs at Voxtral's $13 a million: 13 micros each. */
const lineMicrosOf = (characters: number): number => characters * 13;

/** A line no other test says, so what reached the provider with it is this test's. */
const newLine = (): string => `Hello there, ${uniqueLetters()}.`;

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

/** A month no other test counts spend in: from 2700, clear of other files. */
const newMonth = (): string => {
  monthsUsed += 1;
  return `${2700 + Math.floor(monthsUsed / 12)}-${String((monthsUsed % 12) + 1).padStart(2, "0")}`;
};

/** Core's env with model spend counted in a month of its own. */
const withRules = () => {
  const month = newMonth();
  const rulesEnv: Env = { ...env, SPEND_MONTH: month };
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

/**
 * Waits until Grasp's own key spent `micros` in `month`: a line is
 * recorded there after it is said, never to the organization's spend.
 */
const graspSpent = async (month: string, micros: number) => {
  await vi.waitFor(
    async () => {
      await expect(
        spentMicros(month, { credential: "platform" })
      ).resolves.toBe(micros);
    },
    { timeout: 5000, interval: 20 }
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
  it("says a line as a WAV file, with its words timed in order over the audio's length", async () => {
    const { rulesEnv } = withRules();
    const line = newLine();

    const speech = await stephen(rulesEnv, newPerson()).speak({
      text: line,
      voice,
      language: "en",
    });

    expect({ bytes: speech.audio.byteLength, mime: speech.mime }).toStrictEqual(
      { bytes: 44 + line.length * speechBytesPerChar, mime: "audio/wav" }
    );
    // Mistral tells no word's time: each is placed over the audio's
    // length, which the fake makes 30 ms a character.
    const lengthMs = line.length * 30;
    const [hello, there, last] = speech.words;
    expect({
      texts: speech.words.map(({ text }) => text),
      starts: hello?.startMs,
      inOrder:
        (hello?.endMs ?? 0) <= (there?.startMs ?? 0) &&
        (there?.endMs ?? 0) <= (last?.startMs ?? 0),
      ends: (last?.endMs ?? 0) > lengthMs / 2 && (last?.endMs ?? 0) <= lengthMs,
    }).toStrictEqual({
      texts: line.split(" "),
      starts: 0,
      inOrder: true,
      ends: true,
    });
    await expect(sentWith(line)).resolves.toStrictEqual([
      {
        host: "api.mistral.ai",
        path: "/v1/audio/speech",
        body: {
          model: "voxtral-mini-tts-3-0",
          input: line,
          voice_id: voice,
          response_format: "wav",
        },
      },
    ]);
  });

  it("refuses a voice the speech model doesn't have, charging nothing", async () => {
    const { rulesEnv, month } = withRules();
    const person = newPerson();
    const line = newLine();

    await expect(
      outcome(
        stephen(rulesEnv, person).speak({
          text: line,
          voice: "voice_0",
          language: "en",
        })
      )
    ).resolves.toBe("model.failed");
    await graspSpent(month, 0);
  });

  it("sends Grasp's key only from connect, once, to Mistral alone, and never logs or hands it back", async () => {
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
    await plan(platformMistralKey, [busy, busy]);
    const failed = await thrown(
      stephen(rulesEnv, person).speak({
        text: refused,
        voice,
        language: "nl",
      })
    );

    const events = await auditedFor(person.userId, 2);
    await expect(keyPlaces(said, platformMistralKey)).resolves.toStrictEqual({
      hosts: ["api.mistral.ai"],
      headers: ["authorization"],
      inBody: false,
      placeholder: false,
    });
    const seen = JSON.stringify([speech.words, failed, String(failed), events]);
    expect({
      logged: lines.some((logged) => logged.includes("model.failed")),
      inLogs: lines.some((logged) => logged.includes(platformMistralKey)),
      handedBack: seen.includes(platformMistralKey),
    }).toStrictEqual({ logged: true, inLogs: false, handedBack: false });
  });

  it("charges the line's characters to Grasp's own key, never to the organization's spend, and audits it as a platform call", async () => {
    const { rulesEnv, month } = withRules();
    const person = newPerson();
    const line = newLine();
    const lineMicros = lineMicrosOf(line.length);

    await stephen(rulesEnv, person).speak({
      text: line,
      voice,
      language: "en",
      model: speechModel,
    });

    await graspSpent(month, lineMicros);
    await expect(spentMicros(month, { personId: person.userId })).resolves.toBe(
      0
    );
    const [event] = await auditedFor(person.userId, 1);
    expect(event).toMatchObject({
      action: "model.call",
      model: { provider: "mistral", model: "voxtral-mini-tts-3-0" },
      cost: { amount: lineMicros / 1_000_000, currency: "USD" },
      detail: {
        purpose: "onboarding.speech",
        outcome: "answered",
        characters: line.length,
        transport: "connect",
        credential: "platform",
        region: "eu",
      },
    });
    // Never the line itself.
    expect(JSON.stringify(event)).not.toContain(line);
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
    await expect(outcome(speak("mistral/voxtral-mini-tts-9"))).resolves.toBe(
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

  it("asks once more when the provider is busy, charging only the line it said", async () => {
    const { rulesEnv, month } = withRules();
    const person = newPerson();
    const line = newLine();
    await plan(platformMistralKey, [
      { status: 429, body: { error: { type: "too_many_requests" } } },
    ]);

    const speech = await stephen(rulesEnv, person).speak({
      text: line,
      voice,
      language: "en",
    });

    expect(speech.words).toHaveLength(3);
    await expect(carrying(line)).resolves.toHaveLength(2);
    await graspSpent(month, lineMicrosOf(line.length));
    const [event] = await auditedFor(person.userId, 1);
    expect(event?.detail).toMatchObject({ outcome: "answered" });
  });

  it("gives up after asking once more, and says when to try again", async () => {
    const { rulesEnv } = withRules();
    const line = newLine();
    await plan(platformMistralKey, [busy, busy]);

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
