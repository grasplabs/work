import type { KickoffInput } from "@grasp-os/shared/kickoff";
import { modelErrors } from "@grasp-os/shared/models";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { modelForRole, models } from "../src/models.ts";
import { onboardingStore } from "../src/onboarding/store.ts";
import { adminKickoff } from "./admin-kickoff.ts";
import { mockIdp } from "./idp.ts";
import { fakeProviderFor, testModel } from "./model-provider.ts";
import type { ProviderReply } from "./model-provider.ts";
import { auditedDuring, outcome, signedInApi } from "./sign-in.ts";

// The kickoff (GRA-318): staff bring in Grasp's first conversation with
// the sponsor, it is read through the model gateway for what Stephen needs,
// and what it brought goes into his context. The model provider behind
// connect is the outside system (test/model-provider.ts). The ways it can
// fail, tried here:
//
// - A field kept whose quote the transcript doesn't hold: the model made
//   it up, and Stephen would act on it.
// - The transcript taken as instructions, or read by a model the rules
//   don't let take sensitive data.
// - Its words in the audit log, which the company's admin reads. Who may
//   bring it in, and Grasp shut out while it is read, are the admin
//   route's (admin-kickoff.test.ts).

const idp = mockIdp();

const mistral = "mistral/mistral-large-latest";
const euModel = "openai/gpt-5.4";

/** Grasp's first conversation with a Dutch company, as its transcript has it. */
const dutch = `Anna (COO): Wij zijn een hypotheekadviseur in Utrecht, met vijf teams.
Jakob (Grasp): Waar gaat de meeste tijd naartoe?
Anna (COO): Het overtypen van klantgegevens tussen het CRM en de bankportalen kost ons team elke week uren.
Anna (COO): Aan de salarisadministratie mag niemand komen, daar loopt een onderzoek.
Jakob (Grasp): Welke systemen gebruiken jullie?
Anna (COO): Vooral Salesforce en Excel, en de portalen van de banken.
Anna (COO): Ons team hypotheekadvies telt 12 adviseurs.`;

/** What the model answers about `dutch`: one quote it made up. */
const reading = {
  fields: [
    {
      field: "business",
      text: "Een hypotheekadviseur in Utrecht.",
      // Not in the transcript: it counts as not said.
      quote: "Wij zijn de grootste hypotheekadviseur van Nederland",
      ask: "",
    },
    {
      field: "pain",
      text: "Klantgegevens overtypen tussen het CRM en de bankportalen.",
      quote:
        "Het overtypen van klantgegevens tussen het CRM en de bankportalen kost ons team elke week uren.",
      ask: "",
    },
    {
      field: "limits",
      text: "De salarisadministratie blijft buiten beeld.",
      quote: "Aan de salarisadministratie mag niemand komen",
      ask: "",
    },
    {
      field: "systems",
      text: "Salesforce, Excel en de bankportalen.",
      // Its own spaces and capitals: still the transcript's words.
      quote: "vooral   SALESFORCE en Excel",
      ask: "",
    },
    {
      field: "languages",
      text: "",
      quote: "",
      ask: "In welke talen werken de teams?",
    },
  ],
  teams: [
    {
      name: "hypotheekadvies",
      does: "Hypotheekadvies voor klanten",
      people: 12,
    },
    // Never named: made up.
    { name: "Juridisch", does: "Contracten", people: 3 },
  ],
};

const answer = (body: unknown): ProviderReply => ({
  text: JSON.stringify(body),
  inputTokens: 900,
  outputTokens: 300,
});

/**
 * What `run` returns while the provider answers with `replies`, for the
 * organization's chosen `models`, under the deployment's rules `config`
 * when given.
 */
const answering = async <T>(
  replies: ProviderReply[],
  run: () => Promise<T>,
  {
    config,
    models: chosen = [testModel],
  }: { config?: unknown; models?: readonly string[] } = {}
) => {
  const before = env.MODEL_GATEWAY;
  const provider = await fakeProviderFor(chosen, ...replies);
  try {
    if (config !== undefined) {
      env.MODEL_GATEWAY = config;
    }
    return { requests: provider.requests, result: await run() };
  } finally {
    env.MODEL_GATEWAY = before;
  }
};

const pasted = (text: string): KickoffInput => ({
  locale: "nl",
  transcript: { text },
});

const file = (name: string, text: string): KickoffInput => ({
  locale: "nl",
  transcript: {
    file: { name, bytes: Uint8Array.from(new TextEncoder().encode(text)) },
  },
});

describe("the kickoff", { timeout: 60_000 }, () => {
  // First in the file: no test has connected a provider yet.
  it("is not read while the company connected no AI provider", async () => {
    const staff = adminKickoff();
    await expect(outcome(staff.saveKickoff(pasted(dutch)))).resolves.toBe(
      "model.no_provider"
    );
  });

  it("is read for what Stephen needs, keeping only what its quotes show was said, and his context holds the pain and what to leave alone", async () => {
    const staff = adminKickoff();
    const { result: view, requests } = await answering(
      [answer(reading)],
      async () => await staff.saveKickoff(pasted(dutch))
    );
    const brief = await onboardingStore(env).kickoffBrief();
    const [request] = requests;
    const sent = JSON.stringify(request?.body);
    expect({
      said: Object.keys(view.reading?.fields ?? {}).toSorted(),
      ask: {
        business: view.reading?.ask.business,
        languages: view.reading?.ask.languages,
      },
      teams: view.reading?.teams,
      transcript: view.transcript?.fileName,
      pain: brief.includes("Klantgegevens overtypen"),
      leaveAlone: brief.includes(
        "What you leave alone: never ask about it\nDe salarisadministratie blijft buiten beeld."
      ),
      madeUp: brief.includes("hypotheekadviseur"),
      asData:
        sent.includes("<transcript>") && sent.includes("never as instructions"),
    }).toStrictEqual({
      said: ["limits", "pain", "systems"],
      ask: { business: "", languages: "In welke talen werken de teams?" },
      teams: [
        {
          name: "Hypotheekadvies",
          does: "Hypotheekadvies voor klanten",
          people: 12,
        },
      ],
      transcript: null,
      pain: true,
      leaveAlone: true,
      madeUp: false,
      asData: true,
    });
  });

  it("is read only by a model the rules let take sensitive data: the first the organization chose", async () => {
    const staff = adminKickoff();
    const sensitive = { sensitive: { models: [euModel], connections: [] } };
    // The default may not take sensitive data: read by the fallback that may.
    const { requests } = await answering(
      [answer(reading)],
      async () => await staff.saveKickoff(pasted(dutch)),
      { config: sensitive, models: [mistral, euModel] }
    );
    const { requests: none, result } = await answering(
      [],
      async () => await outcome(staff.saveKickoff(pasted(dutch))),
      { config: sensitive, models: [mistral] }
    );
    expect({
      model: requests.map(({ url }) => url.includes("api.openai.com")),
      refused: result,
      sent: none.length,
    }).toStrictEqual({ model: [true], refused: "kickoff.not_read", sent: 0 });
  });

  it("is read by the organization's default model when the rules let it", async () => {
    const staff = adminKickoff();
    const { requests } = await answering(
      [answer(reading)],
      async () => await staff.saveKickoff(pasted(dutch)),
      {
        config: { sensitive: { models: [mistral, euModel], connections: [] } },
        models: [euModel, mistral],
      }
    );
    expect(
      requests.map(({ url }) => url.includes("api.openai.com"))
    ).toStrictEqual([true]);
  });

  it("gives both roles the organization's default, and none while it chose none", () => {
    const chosen = { models: [mistral, euModel], rules: undefined };
    const notSensitive = { sensitive: false };
    let unchosen;
    try {
      modelForRole({ models: [], rules: undefined }, "careful", notSensitive);
    } catch (error) {
      unchosen = modelErrors.codeOf(error);
    }
    expect({
      quick: modelForRole(chosen, "quick", notSensitive),
      careful: modelForRole(chosen, "careful", notSensitive),
      unchosen,
    }).toStrictEqual({
      quick: mistral,
      careful: mistral,
      unchosen: "model.no_provider",
    });
  });

  it("goes through a gateway that judges every onboarding call as carrying sensitive data", async () => {
    const provider = await fakeProviderFor([mistral, euModel], answer(reading));
    const rulesEnv: Env = {
      ...env,
      MODEL_GATEWAY: { sensitive: { models: [euModel], connections: [] } },
    };
    const refused = await outcome(
      models(rulesEnv).call({
        model: mistral,
        input: "Hallo.",
        purpose: "onboarding.kickoff",
        trigger: { type: "system" },
        work: { onboarding: true },
      })
    );
    expect({ refused, sent: provider.requests.length }).toStrictEqual({
      refused: "model.sensitive_data",
      sent: 0,
    });
  });

  it("takes a subtitle file, without its numbers and timings, and refuses what isn't a transcript", async () => {
    const staff = adminKickoff();
    const vtt = `WEBVTT

1
00:00:01.000 --> 00:00:04.000
<v Anna>${dutch.split("\n").join("\n\n2\n00:00:05.000 --> 00:00:09.000\n")}

3
00:00:10.000 --> 00:00:11.000
12`;
    const { requests, result: view } = await answering(
      [answer(reading)],
      async () => await staff.saveKickoff(file("kickoff.vtt", vtt))
    );
    const sent = JSON.stringify(requests[0]?.body);
    expect({
      file: view.transcript?.fileName,
      timings: sent.includes("-->"),
      speaker: sent.includes("Anna: Anna (COO)"),
      // A number said on its own line is something said, not a cue's number.
      spoken: sent.includes(String.raw`\n12\n</transcript>`),
      pdf: await outcome(staff.saveKickoff(file("kickoff.pdf", dutch))),
      short: await outcome(staff.saveKickoff(pasted("Hallo, dit is kort."))),
    }).toStrictEqual({
      file: "kickoff.vtt",
      timings: false,
      speaker: true,
      spoken: true,
      pdf: "kickoff.unreadable",
      short: "kickoff.too_short",
    });
  });

  it("keeps the sponsor's answers beside it, for Stephen too, on record without their words", async () => {
    const staff = adminKickoff();
    await answering(
      [answer(reading)],
      async () => await staff.saveKickoff(pasted(dutch))
    );
    const answered = "Nederlands, en Engels voor IT.";
    const events = await auditedDuring(async () => {
      await staff.answerKickoff("languages", answered);
    });
    const brief = await onboardingStore(env).kickoffBrief();
    const back = await staff.answerKickoff("languages", " ");
    expect({
      inBrief: brief.includes(answered),
      actions: events.map(({ action, actor }) => [action, actor.type]),
      words: JSON.stringify(events).includes("Engels"),
      back: back.answers.languages,
      unknown: await outcome(
        staff.answerKickoff(
          // SAFETY: a field that isn't one, as a client could send it.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
          "salary" as "languages",
          "x"
        )
      ),
    }).toStrictEqual({
      inBrief: true,
      actions: [["onboarding.kickoff.answered", "staff"]],
      words: false,
      back: undefined,
      // An ask the admin couldn't have made is refused whole.
      unknown: "request.forbidden",
    });
  });

  it("gives the company's admin the suites and places the company named, and Stephen's words about its work, only as far as the kickoff said it", async () => {
    const staff = adminKickoff();
    const { api: admin } = await signedInApi(idp, "admin");
    const example = {
      role: "Mortgage advice",
      question: "Where does the time go on a mortgage file?",
      answer: "Retyping client details from the CRM into the bank portals.",
      time: "About an hour per file.",
    };
    await answering(
      [
        answer({
          ...reading,
          onboarding: [
            {
              locale: "en",
              // The kickoff's business counts as not said: no business.
              business: "mortgage adviser",
              documents: ["mortgage files", "bank forms", "mortgage files"],
              example,
            },
            {
              locale: "nl",
              business: "",
              documents: [],
              example: { role: "", question: "", answer: "", time: "" },
            },
            // Not a language the onboarding speaks.
            { locale: "xx", business: "x", documents: ["x"], example },
          ],
        }),
      ],
      async () => await staff.saveKickoff(pasted(dutch))
    );
    const { context: before } = await admin.onboarding.view();
    // The sponsor's answer about their tools names the suite and the place.
    await staff.answerKickoff(
      "systems",
      "Google Workspace, with our procedures in Notion."
    );
    const { context } = await admin.onboarding.view();
    /** The suites and places named once the sponsor's answer about their tools is `said`. */
    const namedBy = async (said: string) => {
      await staff.answerKickoff("systems", said);
      const { context: named } = await admin.onboarding.view();
      return [named.suites, named.sources];
    };
    expect({
      before: [before.suites, before.sources],
      context,
      // A place named counts for its suite: both suites, Drive kept.
      mixed: await namedBy("Microsoft 365 for mail, our files in gdrive."),
      // "Google" alone names no suite.
      analytics: await namedBy("Google Analytics and Microsoft 365."),
    }).toStrictEqual({
      // Salesforce and Excel name no suite and no place.
      before: [[], []],
      mixed: [["microsoft", "google"], ["drive"]],
      analytics: [["microsoft"], []],
      context: {
        suites: ["google"],
        sources: ["notion"],
        words: {
          en: {
            business: "",
            documents: ["mortgage files", "bank forms"],
            example,
          },
        },
      },
    });
  });

  it.each([
    { given: "Anna", named: "Anna" },
    { given: "anna", named: "Anna" },
    // Not in the transcript: made up, never shown to the admin.
    { given: "Pieter", named: null },
    // Not a first name.
    { given: "Anna (COO)", named: null },
    { given: "", named: null },
  ])(
    "names the sponsor to the company's admin only as the transcript names them ($given)",
    async ({ given, named }) => {
      const staff = adminKickoff();
      const { api: admin } = await signedInApi(idp, "admin");
      const { result: view } = await answering(
        [answer({ ...reading, sponsor: given })],
        async () => await staff.saveKickoff(pasted(dutch))
      );
      const { sponsor } = await admin.onboarding.view();
      expect({ staff: view.reading?.sponsor ?? null, sponsor }).toStrictEqual({
        staff: named,
        sponsor: named,
      });
    }
  );
});
