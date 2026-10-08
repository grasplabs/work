import type { AiBinding } from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import { authErrors } from "@grasp-os/shared/errors";
import type { KickoffInput } from "@grasp-os/shared/kickoff";
import type { Identity } from "@grasp-os/shared/rpc";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { models } from "../src/models.ts";
import type { ModelsEnv } from "../src/models.ts";
import { OnboardingStaffRpc } from "../src/onboarding/staff-rpc.ts";
import { onboardingStore } from "../src/onboarding/store.ts";
import type { SessionCheck } from "../src/session-check.ts";
import { fakeGateway } from "./ai-gateway.ts";
import type { GatewayReply } from "./ai-gateway.ts";
import { mockIdp } from "./idp.ts";
import {
  auditedDuring,
  openRpc,
  outcome,
  signedIn,
  signedInApi,
  staffPerson,
} from "./sign-in.ts";

// The kickoff (GRA-318): staff bring in Grasp's first conversation with
// the sponsor, it is read through the model gateway for what Stephen needs,
// and what it brought goes into his context. AI Gateway is the outside
// system: a fake behind the AI binding. The ways it can fail, tried here:
//
// - A field kept whose quote the transcript doesn't hold: the model made
//   it up, and Stephen would act on it.
// - The transcript taken as instructions, or read by a model the rules
//   don't let take sensitive data.
// - Anyone but staff reading or changing it; its words in the audit log,
//   which the company's admin reads.

const idp = mockIdp();

const workersAi = "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast";
/** Hosted in the EU, as the tests' config says. */
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

const answer = (body: unknown): GatewayReply => ({
  text: JSON.stringify(body),
  inputTokens: 900,
  outputTokens: 300,
});

/**
 * What `run` returns while the gateway answers with `replies`, under the
 * deployment's gateway `config` when given.
 */
const answering = async <T>(
  replies: GatewayReply[],
  run: () => Promise<T>,
  config?: unknown
) => {
  const before = env.MODEL_GATEWAY;
  const fake = fakeGateway(...replies);
  const ai: AiBinding = env.AI;
  const spy = vi.spyOn(ai, "fetch").mockImplementation(fake.binding.fetch);
  try {
    if (config !== undefined) {
      env.MODEL_GATEWAY = config;
    }
    return { requests: fake.requests, result: await run() };
  } finally {
    env.MODEL_GATEWAY = before;
    spy.mockRestore();
  }
};

/** Grasp's staff, on a connection of their own. */
const asStaff = async () => {
  const session = await signedIn(idp, "grasp-staff", staffPerson());
  const { core } = await openRpc(session);
  return await core.authenticate();
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
  it("is read for what Stephen needs, keeping only what its quotes show was said, and his context holds the pain and what to leave alone", async () => {
    const staff = await asStaff();
    const { result: view, requests } = await answering(
      [answer(reading)],
      async () => await staff.onboardingStaff.saveKickoff(pasted(dutch))
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

  it("is read only by a model the rules let take sensitive data", async () => {
    const staff = await asStaff();
    const { requests } = await answering(
      [answer(reading)],
      async () => await staff.onboardingStaff.saveKickoff(pasted(dutch)),
      {
        gateway: "grasp-os-test",
        models: [workersAi, euModel],
        sensitive: { models: [euModel], connections: [] },
      }
    );
    const { requests: none, result } = await answering(
      [],
      async () =>
        await outcome(staff.onboardingStaff.saveKickoff(pasted(dutch))),
      {
        gateway: "grasp-os-test",
        models: [workersAi],
        sensitive: { models: [euModel], connections: [] },
      }
    );
    expect({
      model: requests.map(({ url }) => url.includes("openai")),
      refused: result,
      sent: none.length,
    }).toStrictEqual({ model: [true], refused: "kickoff.not_read", sent: 0 });
  });

  it("goes through a gateway that judges every onboarding call as carrying sensitive data", async () => {
    const gatewayEnv: ModelsEnv = {
      ...env,
      AI: fakeGateway(answer(reading)).binding,
      MODEL_GATEWAY: {
        gateway: "grasp-os-test",
        models: [workersAi, euModel],
        sensitive: { models: [euModel], connections: [] },
      },
    };
    const refused = await outcome(
      models(gatewayEnv).call({
        model: workersAi,
        input: "Hallo.",
        purpose: "onboarding.kickoff",
        trigger: { type: "system" },
        work: { onboarding: true },
      })
    );
    expect(refused).toBe("model.sensitive_data");
  });

  it("takes a subtitle file, without its numbers and timings, and refuses what isn't a transcript", async () => {
    const staff = await asStaff();
    const vtt = `WEBVTT

1
00:00:01.000 --> 00:00:04.000
<v Anna>${dutch.split("\n").join("\n\n2\n00:00:05.000 --> 00:00:09.000\n")}`;
    const { requests, result: view } = await answering(
      [answer(reading)],
      async () =>
        await staff.onboardingStaff.saveKickoff(file("kickoff.vtt", vtt))
    );
    const sent = JSON.stringify(requests[0]?.body);
    expect({
      file: view.transcript?.fileName,
      timings: sent.includes("-->"),
      speaker: sent.includes("Anna: Anna (COO)"),
      pdf: await outcome(
        staff.onboardingStaff.saveKickoff(file("kickoff.pdf", dutch))
      ),
      short: await outcome(
        staff.onboardingStaff.saveKickoff(pasted("Hallo, dit is kort."))
      ),
    }).toStrictEqual({
      file: "kickoff.vtt",
      timings: false,
      speaker: true,
      pdf: "kickoff.unreadable",
      short: "kickoff.too_short",
    });
  });

  it("keeps the sponsor's answers beside it, for Stephen too, on record without their words", async () => {
    const staff = await asStaff();
    await answering(
      [answer(reading)],
      async () => await staff.onboardingStaff.saveKickoff(pasted(dutch))
    );
    const answered = "Nederlands, en Engels voor IT.";
    const events = await auditedDuring(async () => {
      await staff.onboardingStaff.answerKickoff("languages", answered);
    });
    const brief = await onboardingStore(env).kickoffBrief();
    const back = await staff.onboardingStaff.answerKickoff("languages", " ");
    expect({
      inBrief: brief.includes(answered),
      actions: events.map(({ action, actor }) => [action, actor.type]),
      words: JSON.stringify(events).includes("Engels"),
      back: back.answers.languages,
      unknown: await outcome(
        staff.onboardingStaff.answerKickoff(
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
      unknown: "kickoff.invalid",
    });
  });

  it("keeps nothing when the company ends Grasp's access while it is read", async () => {
    const before = await onboardingStore(env).kickoff();
    // A session that is staff's when the call comes in, and no longer once
    // the reading is back: the company ended Grasp's access meanwhile.
    const staff: Identity = {
      userId: "staff-ended",
      email: "staff@grasp.example",
      name: "Grasp staff",
      role: "admin",
      teams: [],
      staff: true,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const check = vi
      .fn<SessionCheck>()
      .mockResolvedValueOnce(staff)
      .mockRejectedValue(authErrors.create("auth.unauthenticated"));
    const { result, requests } = await answering(
      [answer(reading)],
      async () =>
        await outcome(
          new OnboardingStaffRpc(env, check).saveKickoff(pasted(dutch))
        )
    );
    const after = await onboardingStore(env).kickoff();
    expect({
      read: requests.length,
      result,
      kept: after.transcript?.at === before.transcript?.at,
    }).toStrictEqual({ read: 1, result: "auth.unauthenticated", kept: true });
  });

  it("is staff's alone: a member and the company's admin get nothing from it", async () => {
    const { api: admin } = await signedInApi(idp, "admin");
    const { api: user } = await signedInApi(idp, "user");
    const refused = await Promise.all(
      [admin, user].flatMap((api) => [
        outcome(api.onboardingStaff.kickoff()),
        outcome(api.onboardingStaff.saveKickoff(pasted(dutch))),
        outcome(api.onboardingStaff.answerKickoff("pain", "x")),
      ])
    );
    expect(new Set(refused)).toStrictEqual(new Set(["onboarding.staff_only"]));
  });
});
