import type { AiBinding } from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import { interviewHearPath } from "@grasp-os/shared/interview-hear";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { modelLedger } from "../src/model-ledger.ts";
import { models } from "../src/models.ts";
import { hearingModel } from "../src/onboarding/hear.ts";
import { onboardingStore } from "../src/onboarding/store.ts";
import { heardBudgets } from "../src/onboarding/transcription.ts";
import { allEvents, eventsAfter, logHead } from "./audit-events.ts";
import { codeOf, openedFor } from "./interview-link.ts";
import { routed } from "./sign-in.ts";

// A stretch of what someone said, written down from its recording when the
// live line can't be used (src/onboarding/hear.ts). ElevenLabs's Scribe,
// behind AI Gateway, is the outside system: a fake behind the AI binding
// that writes every recording down as the same words. The store, the link
// checks and the counting are real. The ways it can fail, tried here:
//
// - Writing down for a link that isn't one, on another device, or for a
//   link that heard all it may today; with no voice set up.
// - A request that isn't a recording, or is too large.
// - The recording kept anywhere: the store, the database, the audit log.
// - Listening out for words the page chose, or for more than 30.
// - Writing down past the deployment's own budgets, or with a model its
//   allowlist doesn't list (GRA-1064).

const voiceModel = "elevenlabs/eleven_v4";

/** The deployment's gateway, allowing the recordings' model: they may be written down. */
const gatewayConfig = {
  gateway: "grasp-os-test",
  models: [voiceModel, hearingModel],
};

/** A text model, which no recording is written down by. */
const textModel = "anthropic/claude-sonnet-4-5";

/** What the fake Scribe writes every recording down as. */
const words = "I check the invoice in Exact.";

/** Something no recording would hold by chance: if it shows anywhere, the recording was kept. */
const marker = "RECORDING-MARKER-7f3a";

/** A request core made of Scribe, as far as these tests read it. */
interface Asked {
  url: URL;
  fields: Record<string, string[]>;
  file: number;
  apiKey: string | null;
}

/** Scribe behind the gateway: every recording written down as `words`, or refused with `status`. */
const fakeScribe = (status = 200) => {
  const asked: Asked[] = [];
  const fetch = async (
    input: Request | string | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const request = new Request(input, init);
    const form = await request.formData();
    const fields: Record<string, string[]> = {};
    let file = 0;
    for (const [name, value] of form.entries()) {
      if (typeof value === "string") {
        fields[name] = [...(fields[name] ?? []), value];
      } else {
        file = value.size;
      }
    }
    asked.push({
      url: new URL(request.url),
      fields,
      file,
      apiKey: request.headers.get("xi-api-key"),
    });
    return status === 200
      ? Response.json({ language_code: "en", text: ` ${words} `, words: [] })
      : new Response("{}", { status });
  };
  return { fetch, asked };
};

let monthsUsed = 0;

/** A month no other test counts budgets in: from 2900, clear of other files. */
const newMonth = (): string => {
  monthsUsed += 1;
  return `${2900 + Math.floor(monthsUsed / 12)}-${String((monthsUsed % 12) + 1).padStart(2, "0")}`;
};

/**
 * What `run` returns while the fake Scribe stands behind the gateway,
 * under `config`, budgets counted in `month`.
 */
const hearing = async <T>(
  run: () => Promise<T>,
  {
    status = 200,
    config = gatewayConfig,
    month,
  }: { status?: number; config?: unknown; month?: string } = {}
) => {
  const before = {
    gateway: env.MODEL_GATEWAY,
    month: env.MODEL_BUDGET_MONTH,
  };
  const scribe = fakeScribe(status);
  const ai: AiBinding = env.AI;
  const spy = vi.spyOn(ai, "fetch").mockImplementation(scribe.fetch);
  Reflect.set(env, "MODEL_GATEWAY", config);
  if (month !== undefined) {
    env.MODEL_BUDGET_MONTH = month;
  }
  try {
    return { asked: scribe.asked, result: await run() };
  } finally {
    env.MODEL_GATEWAY = before.gateway;
    env.MODEL_BUDGET_MONTH = before.month;
    spy.mockRestore();
  }
};

/**
 * Scribe's price, with keyterms, as the ledger pins it: micros per
 * million seconds, rounded up ($0.27 an hour).
 */
const microsPerMillionSeconds = Math.ceil((0.27 / 3600) * 1e12);

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
  { seconds = "2.4", audio = `${marker}${"x".repeat(2000)}` } = {}
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
      const { asked, result } = await hearing(async () => {
        const response = await hear(recording(link));
        return { status: response.status, body: await response.json() };
      });
      const [request] = asked;
      const stored = await everythingStored();
      expect({
        result,
        path: request?.url.pathname.endsWith("/v1/speech-to-text"),
        logging: request?.url.searchParams.get("enable_logging"),
        model: request?.fields.model_id,
        language: request?.fields.language_code,
        file: request?.file,
        apiKey: request?.apiKey,
        counted: (await heardCounted()) - before,
        kept: stored.includes(marker),
      }).toStrictEqual({
        result: { status: 200, body: { heard: words } },
        path: true,
        logging: "false",
        model: ["scribe_v2"],
        language: ["en"],
        file: 2000 + marker.length,
        apiKey: null,
        counted: 2.4,
        kept: false,
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
      const form = recording(link);
      form.append("keyterms", "Injected");
      const { asked, result } = await hearing(async () => {
        const response = await hear(form);
        return response.status;
      });
      const terms = asked[0]?.fields.keyterms ?? [];
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
      const { asked } = await hearing(async () => await hear(recording(link)));
      expect(asked[0]?.fields.keyterms).toHaveLength(30);
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
        const bodies = {
          unknown: () => recording({ secret: "a".repeat(43), key: link.key }),
          otherKey: () =>
            recording({ secret: link.secret, key: "b".repeat(43) }),
          noAudio: () => {
            const form = recording(link);
            form.delete("audio");
            return form;
          },
          tooLarge: () =>
            recording(link, { audio: "x".repeat(1024 * 1024 + 1) }),
          notForm: () => JSON.stringify(link),
        };
        const { asked, result } = await hearing(
          async () => await codeOf(await hear(bodies[kind]()))
        );
        expect({ result, sent: asked.length }).toStrictEqual({
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
      const { asked, result } = await hearing(
        async () => await codeOf(await hear(recording(link)))
      );
      expect({ result, sent: asked.length }).toStrictEqual({
        result: [429, "hear.limited"],
        sent: 0,
      });
    });

    it("says when listening isn't set up, and when the upstream failed", async () => {
      const { link } = await openedFor();
      const unset = await hearing(
        async () => await codeOf(await hear(recording(link))),
        // A deployment whose client agreed to no voice model.
        { config: { gateway: "grasp-os-test", models: [textModel] } }
      );
      const voiceOnly = await hearing(
        async () => await codeOf(await hear(recording(link))),
        // A voice, but not the model recordings are written down by.
        { config: { gateway: "grasp-os-test", models: [voiceModel] } }
      );
      const failing = await hearing(
        async () => await codeOf(await hear(recording(link))),
        { status: 500 }
      );
      expect({
        unset: unset.result,
        voiceOnly: [...voiceOnly.result, voiceOnly.asked.length],
        failing: failing.result,
      }).toStrictEqual({
        unset: [503, "hear.unavailable"],
        voiceOnly: [503, "hear.unavailable", 0],
        failing: [502, "hear.failed"],
      });
    });

    it("charges the deployment's budget what was heard, refuses while another listening holds it, and once it is spent", async () => {
      const { link } = await openedFor();
      const month = newMonth();
      const head = await logHead();
      const { asked, result } = await hearing(
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
            await hear(recording(link, { seconds: "30" }))
          );
          await elsewhere.heard(100, "answered");
          const first = await hear(recording(link, { seconds: "29.2" }));
          const charged = await deploymentSpend(month);
          // Spent: what is left is less than another half minute.
          const spent = await codeOf(
            await hear(recording(link, { seconds: "30" }))
          );
          return { busy, first: first.status, charged, spent };
        },
        {
          // A cent: 100 seconds of Scribe (0.75¢) and half a minute
          // (0.225¢) fit, another half minute doesn't.
          config: {
            ...gatewayConfig,
            budgets: { deployment: { limit: 0.01 } },
          },
          month,
        }
      );
      expect({
        ...result,
        sent: asked.length,
        events: await gatewayEvents(head),
      }).toStrictEqual({
        busy: [503, "hear.busy"],
        first: 200,
        // Whole seconds, rounded up.
        charged: { spent: heardMicros(100) + heardMicros(30), held: 0 },
        spent: [429, "hear.over_budget"],
        // Only the recording admitted reached Scribe.
        sent: 1,
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
            model: "scribe_v2",
            cost: (100 * microsPerMillionSeconds) / 1e12,
            seconds: 100,
            outcome: "answered",
            reason: undefined,
          },
          {
            action: "model.call",
            actor: { type: "system" },
            model: "scribe_v2",
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
