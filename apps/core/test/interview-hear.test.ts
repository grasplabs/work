import { interviewHearPath } from "@grasp-os/shared/interview-hear";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { modelLedger } from "../src/model-ledger.ts";
import { models } from "../src/models.ts";
import { onboardingStore } from "../src/onboarding/store.ts";
import { heardBudgets } from "../src/onboarding/transcription.ts";
import { writtenText } from "./ai-providers-fake.ts";
import { allEvents, eventsAfter, logHead } from "./audit-events.ts";
import { platformOpenAiKey } from "./connect-providers.ts";
import { codeOf, openedFor } from "./interview-link.ts";
import { carrying, keyPlaces, plan, sentCount } from "./platform-providers.ts";
import { routed, unique } from "./sign-in.ts";

// A stretch of what someone said, written down from its recording when the
// live line can't be used (src/onboarding/hear.ts). OpenAI's transcription,
// Grasp's own by default (@grasp-os/shared/platform-ai), is the outside
// system: a fake behind connect's fetch that writes every recording down
// as the same words. Connect, the store, the link checks and the counting
// are real. The ways it can fail, tried here:
//
// - Writing down for a link that isn't one, on another device, or for a
//   link that heard all it may today; with no transcription set up.
// - A request that isn't a recording, or is too large.
// - The recording kept anywhere: the store, the database, the audit log.
// - Listening out for words the page chose, or for more than 30.
// - Writing down past the deployment's own budgets (GRA-1064).

/** The transcription model recordings are written down by, the default. */
const hearingModel = "openai/gpt-4o-transcribe";

/** The deployment's rules: none, unless a test sets some. */
const noRules = {};

/** Something no recording would hold by chance: if it shows anywhere, the recording was kept. */
const marker = "RECORDING-MARKER-7f3a";

/** A request core made of OpenAI, as far as these tests read it. */
interface Asked {
  path: string;
  fields: Record<string, string[]>;
  file: number;
}

/** What reached OpenAI with `audio` in it: each request's fields and file. */
const askedWith = async (audio: string): Promise<Asked[]> => {
  const carried = await carrying(audio);
  return await Promise.all(
    carried.map(async ({ path, headers, body }) => {
      const form = await new Response(body, {
        headers: { "content-type": headers["content-type"] ?? "" },
      }).formData();
      const fields: Record<string, string[]> = {};
      let file = 0;
      for (const [name, value] of form.entries()) {
        if (typeof value === "string") {
          fields[name] = [...(fields[name] ?? []), value];
        } else {
          file = value.size;
        }
      }
      return { path, fields, file };
    })
  );
};

/** The words a request listened out for, from its prompt. */
const termsOf = (asked: Asked | undefined): string[] =>
  (asked?.fields.prompt?.[0] ?? "")
    .replace(/^Names and terms: /u, "")
    .replace(/\.$/u, "")
    .split(", ")
    .filter((term) => term !== "");

/** A recording's audio no other test sends, so what reached OpenAI with it is this test's. */
const newAudio = (): string => `${marker}-${unique()}${"x".repeat(2000)}`;

let monthsUsed = 0;

/** A month no other test counts budgets in: from 2900, clear of other files. */
const newMonth = (): string => {
  monthsUsed += 1;
  return `${2900 + Math.floor(monthsUsed / 12)}-${String((monthsUsed % 12) + 1).padStart(2, "0")}`;
};

/**
 * What `run` returns under the deployment's rules `config` and the platform's
 * AI settings `platform`, budgets counted in `month`.
 */
const hearing = async <T>(
  run: () => Promise<T>,
  {
    config = noRules,
    platform,
    month,
  }: { config?: unknown; platform?: unknown; month?: string } = {}
): Promise<T> => {
  const before = {
    gateway: env.MODEL_GATEWAY,
    platform: env.PLATFORM_AI,
    month: env.MODEL_BUDGET_MONTH,
  };
  Reflect.set(env, "MODEL_GATEWAY", config);
  Reflect.set(env, "PLATFORM_AI", platform);
  if (month !== undefined) {
    env.MODEL_BUDGET_MONTH = month;
  }
  try {
    return await run();
  } finally {
    env.MODEL_GATEWAY = before.gateway;
    env.PLATFORM_AI = before.platform;
    env.MODEL_BUDGET_MONTH = before.month;
  }
};

/**
 * GPT-4o Transcribe's price as the ledger pins it: micros per million
 * seconds, rounded up ($0.60 an hour).
 */
const microsPerMillionSeconds = Math.ceil((0.6 / 3600) * 1e12);

/** What `seconds` heard cost, in micros, as the ledger charges them. */
const heardMicros = (seconds: number): number =>
  Math.ceil((seconds * microsPerMillionSeconds) / 1e6);

/** What the deployment spent and holds in `month`, as the ledger counts it. */
const deploymentSpend = async (month: string) => {
  const spent = await modelLedger(env).spendOf(month, ["deployment"], 10);
  const [row] = spent.deployment ?? [];
  return { spent: row?.spentMicros ?? 0, held: row?.reservedMicros ?? 0 };
};

/** The gateway's audit events for recordings after `head`, as these tests read them. */
const gatewayEvents = async (head: number) => {
  const events = await eventsAfter(head);
  return events
    .filter(({ detail }) => detail?.purpose === "onboarding.hear")
    .map(({ action, actor, model, cost, detail }) => ({
      action,
      actor,
      model: model?.model,
      cost: cost?.amount,
      seconds: detail?.seconds,
      outcome: detail?.outcome,
      reason: detail?.reason,
    }));
};

/** A recording as the page sends it, with the link and what it measured. */
const recording = (
  link: { secret: string; key: string },
  { seconds = "2.4", audio = newAudio() } = {}
): FormData => {
  const form = new FormData();
  form.set("secret", link.secret);
  form.set("key", link.key);
  form.set("locale", "en");
  form.set("seconds", seconds);
  form.set("audio", new File([audio], "stretch", { type: "audio/webm" }));
  return form;
};

const hear = async (body: FormData | string): Promise<Response> =>
  await routed(interviewHearPath, { method: "POST", body });

/** Seconds the onboarding counted as heard for interviews. */
const heardCounted = async (): Promise<number> => {
  const rows = await onboardingStore(env).usage();
  return rows
    .filter(
      (row) => row.purpose === "interviews" && row.model === "transcription"
    )
    .reduce((sum, { seconds }) => sum + seconds, 0);
};

/** Bytes as text, so a recording written anywhere as text or bytes shows. */
const asText = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) =>
    inner instanceof ArrayBuffer ? new TextDecoder().decode(inner) : inner
  );

/** Tables SQLite and the runtime keep for themselves. */
const ownTable = /^(?:_cf|sqlite_|d1_)/u;

/** Everything the onboarding's store and the database hold, as text. */
const everythingStored = async (): Promise<string> => {
  const stored = await runInDurableObject(
    onboardingStore(env),
    (_object, state) =>
      state.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table'"
        )
        .toArray()
        .filter(({ name }) => !ownTable.test(name))
        .map(({ name }) =>
          asText(state.storage.sql.exec(`SELECT * FROM "${name}"`).toArray())
        )
        .join("\n")
  );
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table'"
  ).all<{ name: string }>();
  const tables = await Promise.all(
    results
      .filter(({ name }) => !ownTable.test(name))
      .map(async ({ name }) => {
        const { results: rows } = await env.DB.prepare(
          `SELECT * FROM "${name}"`
        ).all();
        return asText(rows);
      })
  );
  return [stored, ...tables, asText(await allEvents())].join("\n");
};

/** The company's name, as the deployment's organization has it. */
const companyNamed = async (): Promise<string> => {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO organizations (id, name, slug, created_at) VALUES ('organization', 'Acme', 'acme', ?)"
  )
    .bind(Date.now())
    .run();
  const row = await env.DB.prepare(
    "SELECT name FROM organizations LIMIT 1"
  ).first<{ name: string }>();
  return row?.name ?? "";
};

describe(
  "a recording written down on someone's link",
  { timeout: 60_000 },
  () => {
    it("writes a link's recording down through the gateway, keeps nothing of it, and counts its seconds", async () => {
      const { link } = await openedFor();
      const before = await heardCounted();
      const audio = newAudio();
      const result = await hearing(async () => {
        const response = await hear(recording(link, { audio }));
        return { status: response.status, body: await response.json() };
      });
      const [request] = await askedWith(audio);
      const stored = await everythingStored();
      expect({
        result,
        path: request?.path,
        model: request?.fields.model,
        language: request?.fields.language,
        file: request?.file,
        counted: (await heardCounted()) - before,
        kept: stored.includes(marker),
      }).toStrictEqual({
        result: { status: 200, body: { heard: writtenText } },
        path: "/v1/audio/transcriptions",
        model: ["gpt-4o-transcribe"],
        language: ["en"],
        file: audio.length,
        counted: 2.4,
        kept: false,
      });
      // Grasp's key from connect alone, once, to OpenAI.
      await expect(keyPlaces(audio, platformOpenAiKey)).resolves.toStrictEqual({
        hosts: ["api.openai.com"],
        headers: ["authorization"],
        inBody: false,
        placeholder: false,
      });
    });

    it("listens out for the company, the team's names, the company's own words and its tools, at most 30, never the page's", async () => {
      const company = await companyNamed();
      const store = onboardingStore(env);
      await store.saveStephen(
        {
          languages: ["en"],
          limits: [],
          terms: ["Kostenstelle", "Dreiwegeabgleich"],
        },
        { type: "system" }
      );
      const { link } = await openedFor();
      const audio = newAudio();
      const form = recording(link, { audio });
      form.append("keyterms", "Injected");
      const result = await hearing(async () => {
        const response = await hear(form);
        return response.status;
      });
      const [asked] = await askedWith(audio);
      const terms = termsOf(asked);
      expect({
        result,
        // The roster's own: Oli Olsen, in Ops.
        named: [
          "Oli",
          "Ops",
          company,
          "Kostenstelle",
          "Dreiwegeabgleich",
        ].every((term) => terms.includes(term)),
        injected: terms.includes("Injected"),
        atMost30: terms.length <= 30,
      }).toStrictEqual({
        result: 200,
        named: true,
        injected: false,
        atMost30: true,
      });
    });

    it("listens out for no more than 30 words, however many the company has", async () => {
      await onboardingStore(env).saveStephen(
        {
          languages: ["en"],
          limits: [],
          terms: Array.from({ length: 40 }, (_, at) => `Term${at}`),
        },
        { type: "system" }
      );
      const { link } = await openedFor();
      const audio = newAudio();
      await hearing(async () => await hear(recording(link, { audio })));
      const [asked] = await askedWith(audio);
      expect(termsOf(asked)).toHaveLength(30);
    });

    it.each([
      ["an unknown link", "unknown", [404, "interview.link_invalid"]],
      ["another device's key", "otherKey", [403, "interview.elsewhere"]],
      ["no recording", "noAudio", [400, "hear.invalid"]],
      ["a recording too large", "tooLarge", [400, "hear.invalid"]],
      ["not a form", "notForm", [400, "hear.invalid"]],
    ] as const)(
      "refuses %s, with nothing sent to the gateway",
      async (_name, kind, refusal) => {
        const { link } = await openedFor();
        const audio = newAudio();
        const bodies = {
          unknown: () =>
            recording({ secret: "a".repeat(43), key: link.key }, { audio }),
          otherKey: () =>
            recording({ secret: link.secret, key: "b".repeat(43) }, { audio }),
          noAudio: () => {
            const form = recording(link, { audio });
            form.delete("audio");
            return form;
          },
          tooLarge: () =>
            recording(link, { audio: `${audio}${"x".repeat(1024 * 1024)}` }),
          notForm: () => JSON.stringify({ ...link, audio }),
        };
        const result = await hearing(
          async () => await codeOf(await hear(bodies[kind]()))
        );
        expect({
          result,
          sent: await sentCount(audio),
        }).toStrictEqual({
          result: refusal,
          sent: 0,
        });
      }
    );

    it("refuses a link that heard all it may today", async () => {
      const { link, person } = await openedFor();
      await onboardingStore(env).countHeard(
        `link:${person}:heard`,
        "interviews",
        heardBudgets.link
      );
      const audio = newAudio();
      const result = await hearing(
        async () => await codeOf(await hear(recording(link, { audio })))
      );
      expect({
        result,
        sent: await sentCount(audio),
      }).toStrictEqual({
        result: [429, "hear.limited"],
        sent: 0,
      });
    });

    it("says when listening isn't set up, and when the upstream failed", async () => {
      const { link } = await openedFor();
      const unparsed = newAudio();
      const unoffered = newAudio();
      const failed = newAudio();
      const unset = await hearing(
        async () =>
          await codeOf(await hear(recording(link, { audio: unparsed }))),
        // Settings that don't parse: no transcription at all.
        { platform: { transcription: { provider: "elevenlabs" } } }
      );
      const notOffered = await hearing(
        async () =>
          await codeOf(await hear(recording(link, { audio: unoffered }))),
        // A model the gateway doesn't offer.
        {
          platform: {
            transcription: { provider: "openai", model: "gpt-9-transcribe" },
          },
        }
      );
      await plan(platformOpenAiKey, [{ status: 500 }]);
      const failing = await hearing(
        async () => await codeOf(await hear(recording(link, { audio: failed })))
      );
      expect({
        unset: [...unset, await sentCount(unparsed)],
        notOffered: [...notOffered, await sentCount(unoffered)],
        failing,
      }).toStrictEqual({
        unset: [503, "hear.unavailable", 0],
        notOffered: [503, "hear.unavailable", 0],
        failing: [502, "hear.failed"],
      });
    });

    it("charges the deployment's budget what was heard, refuses while another listening holds it, and once it is spent", async () => {
      const { link } = await openedFor();
      const month = newMonth();
      const head = await logHead();
      const audio = { busy: newAudio(), first: newAudio(), spent: newAudio() };
      const result = await hearing(
        async () => {
          // Two minutes held elsewhere: no room for half a minute beside them.
          const elsewhere = await models(env).listen({
            model: hearingModel,
            seconds: 120,
            openMs: 60_000,
            purpose: "onboarding.hear",
            trigger: { type: "system" },
            work: { onboarding: true },
          });
          const busy = await codeOf(
            await hear(recording(link, { seconds: "30", audio: audio.busy }))
          );
          await elsewhere.heard(100, "answered");
          const first = await hear(
            recording(link, { seconds: "29.2", audio: audio.first })
          );
          const charged = await deploymentSpend(month);
          // Spent: what is left is less than another half minute.
          const spent = await codeOf(
            await hear(recording(link, { seconds: "30", audio: audio.spent }))
          );
          return { busy, first: first.status, charged, spent };
        },
        {
          // 2.4 cents: 100 seconds (1.67¢) and half a minute (0.5¢) fit,
          // two minutes and half a minute don't, nor another half minute.
          config: {
            budgets: { deployment: { limit: 0.024 } },
          },
          month,
        }
      );
      const sent = await Promise.all(
        Object.values(audio).map(async (one) => await sentCount(one))
      );
      expect({
        ...result,
        sent,
        events: await gatewayEvents(head),
      }).toStrictEqual({
        busy: [503, "hear.busy"],
        first: 200,
        // Whole seconds, rounded up.
        charged: { spent: heardMicros(100) + heardMicros(30), held: 0 },
        spent: [429, "hear.over_budget"],
        // Only the recording admitted reached OpenAI.
        sent: [0, 1, 0],
        events: [
          {
            action: "model.refused",
            actor: { type: "system" },
            model: undefined,
            cost: undefined,
            seconds: undefined,
            outcome: undefined,
            reason: "model.budget_busy",
          },
          {
            action: "model.call",
            actor: { type: "system" },
            model: "gpt-4o-transcribe",
            cost: (100 * microsPerMillionSeconds) / 1e12,
            seconds: 100,
            outcome: "answered",
            reason: undefined,
          },
          {
            action: "model.call",
            actor: { type: "system" },
            model: "gpt-4o-transcribe",
            // Before the ledger rounds it up to a micro.
            cost: (30 * microsPerMillionSeconds) / 1e12,
            seconds: 30,
            outcome: "answered",
            reason: undefined,
          },
          {
            action: "model.refused",
            actor: { type: "system" },
            model: undefined,
            cost: undefined,
            seconds: undefined,
            outcome: undefined,
            reason: "model.over_budget",
          },
        ],
      });
    });
  }
);
