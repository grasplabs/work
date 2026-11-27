import { errorPayloadSchema } from "@grasp-os/shared/errors";
import { interviewVoicePath } from "@grasp-os/shared/interview-voice";
import type {
  VoiceAnswered,
  VoiceLine,
  VoiceSessionJoin,
} from "@grasp-os/shared/interview-voice";
import { modelErrors } from "@grasp-os/shared/models";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { models } from "../src/models.ts";
import { onboardingStore } from "../src/onboarding/store.ts";
import { platformAi } from "../src/platform-ai.ts";
import { allEvents } from "./audit-events.ts";
import {
  platformElevenLabsKey,
  platformMistralKey,
} from "./connect-providers.ts";
import {
  answering,
  codeOf,
  holdAlarm,
  interviewModels,
  modelOf,
  onLink,
  opened,
  openedFor,
  openLinkAs,
  participate,
  postedOnLink,
  signedInAs,
} from "./interview-link.ts";
import type { Device } from "./interview-link.ts";
import type { ProviderReply } from "./model-provider.ts";
import { carrying, plan } from "./platform-providers.ts";
import { unique } from "./sign-in.ts";

// An interview held as one live conversation with Grasp's ElevenLabs agent
// (src/onboarding/voice.ts), over its endpoint, as the page asks for it.
// ElevenLabs is the outside system, answered by the providers' fake behind
// connect with Grasp's key; Grasp's notes' model writes down what was
// said. The ways it can fail, tried here:
//
// - Grasp's key reaching the page: the page gets a conversation token and
//   a pass.
// - A fact written down that nobody said: one whose words aren't in their
//   answers, as the page heard them, is left out.
// - Someone writing into another person's interview: a pass from another
//   link, or one changed, writes nothing down; nor does a link that opens
//   nothing, nobody signed in, anyone else, someone who didn't agree to
//   take part or withdrew.
// - The page saying who it is or what Stephen knows: the request takes no
//   such field, and the notes' brief holds what the store knows.
// - The notes running on anything but Grasp's own models and key.
// - A correction in the read-back written down as something they never
//   said: a typed one is quoted as it stands; and a line they changed on
//   their screen themselves coming back as anything but their words.
// - The turn-by-turn endpoint still answering a link: it is gone.
// - Something written down twice: nothing is, until one more answer of
//   theirs was heard.
// - A conversation opened unrecorded, or recorded with what was said.
// - A link opening conversations without end: each is held against the
//   day's listening before ElevenLabs is asked, and given back when none
//   opens.

/** Grasp's agent, as the audit log names it. */
const { agent } = platformAi;

/** What the notes' model answers. */
const notes = (body: unknown): ProviderReply => ({
  text: JSON.stringify(body),
  inputTokens: 1600,
  outputTokens: 120,
});

/** Where the interview stands, as the page sends it. */
const standing = {
  locale: "en",
  facts: [],
  phase: "week",
  minutes: 1,
} as const;

/**
 * Two people of one team, each with their own link open, signed in as
 * themselves, and taking part: their links as their pages hold them.
 */
const openedTwo = async (): Promise<[Device, Device]> => {
  const store = onboardingStore(env);
  const people = [`ana-${unique()}`, `ben-${unique()}`] as const;
  const emails = people.map((id) => `${id}@acme.test`);
  const by = { type: "system" } as const;
  await store.setPaused(false, by);
  await store.saveRoster(
    {
      teams: [{ id: "ops", name: "Ops", lead: null, does: "", off: false }],
      people: people.map((id, at) => ({
        id,
        name: at === 0 ? "Ana Alves" : "Ben Bakker",
        team: "ops",
        email: emails[at] ?? "",
        title: "",
        away: false,
      })),
    },
    by
  );
  const yesterday = new Date(Date.now() - 86_400_000).toISOString();
  await store.savePlan({ start: yesterday.slice(0, 10), days: 14 }, by);
  await store.setAgreements(
    { processing: true, assessment: true, council: "none" },
    by
  );
  await store.releaseDue();
  const devices = await Promise.all(
    people.map(async (id, at) => {
      const sent = await store.linkOf(id);
      const secret = sent?.split("#")[1] ?? "";
      const { link } = await openLinkAs(
        secret,
        await signedInAs(emails[at] ?? "")
      );
      await participate(link);
      return link;
    })
  );
  const [first, second] = devices;
  if (first === undefined || second === undefined) {
    throw new Error("Expected two links");
  }
  return [first, second];
};

/** A minute of one morning, as an ISO 8601 time. */
const at = (minute: number): string =>
  new Date(Date.UTC(2031, 4, 6, 9, minute)).toISOString();

const ask = async (link: Device, body: Record<string, unknown>) =>
  await postedOnLink(interviewVoicePath, { ...link, ...body });

/** Opens a conversation on `link`: what the page starts it with. */
const join = async (link: Device): Promise<VoiceSessionJoin> => {
  const answered = await ask(link, {
    action: "open",
    event: "start",
    ...standing,
  });
  return await answered.json();
};

/** Has core write down from `said`, with `noted` answers written down before. */
const noteFrom = async (
  link: Device,
  pass: string,
  said: VoiceLine[],
  noted: number
): Promise<VoiceAnswered> => {
  const answered = await ask(link, {
    action: "answer",
    ...standing,
    pass,
    noted,
    said,
  });
  return await answered.json();
};

/** The conversation tokens ElevenLabs was asked for on Grasp's key. */
const tokensAsked = async () => {
  const carried = await carrying(platformElevenLabsKey);
  return carried
    .filter(({ path }) => path.startsWith("/v1/convai/conversation/token"))
    .map(({ method, host, path }) => ({ method, host, path }));
};

/** The seconds of live conversations the onboarding counted, every day together. */
const conversationsUsed = async (): Promise<number> => {
  const rows = await onboardingStore(env).usage();
  return rows
    .filter(
      (row) => row.purpose === "interviews" && row.model === "conversation"
    )
    .reduce((sum, { seconds }) => sum + seconds, 0);
};

/** The audit events of conversations opened with the agent. */
const conversationsAudited = async () => {
  const events = await allEvents();
  return events.filter(
    ({ action, model }) => action === "model.call" && model?.model === agent.id
  );
};

/** Stephen's first line, then what they said, as the page heard it. */
const heard = (...answers: string[]): VoiceLine[] => [
  { from: "stephen", text: "What do you do here, in a sentence or two?" },
  ...answers.map((text) => ({ from: "person" as const, text })),
];

/** The lines read back, as the page holds them in the read-back. */
const readBack = {
  ...standing,
  phase: "readback",
  facts: [
    { id: "f1", tag: "step", text: "You check the invoices in Exact." },
    { id: "f2", tag: "wait", text: "It waits two days for approval." },
  ],
  noted: 0,
  reading: ["f1", "f2"],
} as const;

const exactFact = {
  tag: "step",
  text: "You check the invoices in Exact every morning.",
  record: "Check the invoices in Exact every morning.",
  quote: "I check the invoices in Exact every morning",
};

describe("an interview as a live conversation", { timeout: 60_000 }, () => {
  beforeEach(holdAlarm);

  it("hands the page a token asked with Grasp's key and a pass, never the key, and records the conversation once, without what was said", async () => {
    const link = await opened();
    const askedBefore = await tokensAsked();
    const auditedBefore = await conversationsAudited();
    const usedBefore = await conversationsUsed();
    await plan(platformElevenLabsKey, [
      { status: 200, body: { token: "conversation-token-not-a-key" } },
    ]);
    const said = "I check the invoices in Exact every morning.";
    const { result } = await answering(
      [notes({ facts: [exactFact], changes: [] })],
      async () => {
        const joined = await join(link);
        const answered = await noteFrom(link, joined.pass, heard(said), 0);
        return { joined, answered };
      }
    );
    const askedAll = await tokensAsked();
    const auditedAll = await conversationsAudited();
    const audited = auditedAll.slice(auditedBefore.length);
    const used = await conversationsUsed();
    expect({
      join: {
        ...result.joined,
        // Who the agent talks with, from the store, and their language.
        context:
          result.joined.context.startsWith(
            "You are talking with Oli, from Ops"
          ) && result.joined.context.endsWith("They chose to talk in English."),
        // The agent's placeholders, filled: the company as the deployment names it.
        variables: {
          ...result.joined.variables,
          company: typeof result.joined.variables.company,
        },
        pass: typeof result.joined.pass,
      },
      keyHandedBack: JSON.stringify(result).includes(platformElevenLabsKey),
      asked: askedAll.slice(askedBefore.length),
      audited: audited.map(({ actor, model, cost, detail }) => ({
        actor,
        model,
        cost: cost?.amount,
        purpose: detail.purpose,
        outcome: detail.outcome,
        status: detail.status,
        seconds: detail.seconds,
        transport: detail.transport,
        credential: detail.credential,
        region: detail.region,
      })),
      // Never what was said, nor who it was said by.
      auditCarries: ["Exact", "Oli"].filter((word) =>
        JSON.stringify(audited).includes(word)
      ),
      // In the onboarding's use as interviews held live.
      used: used - usedBefore,
    }).toStrictEqual({
      join: {
        conversationToken: "conversation-token-not-a-key",
        location: "eu-residency",
        context: true,
        variables: {
          company: "string",
          team_phrase: "from Ops",
          interview_kind_phrase:
            "an interview with an employee about their own work",
          work_phrase:
            "Take the piece that repeats most and costs them most time.",
          language: "English",
        },
        pass: "string",
      },
      keyHandedBack: false,
      asked: [
        {
          method: "GET",
          host: "api.eu.residency.elevenlabs.io",
          path: `/v1/convai/conversation/token?agent_id=${agent.id}`,
        },
      ],
      audited: [
        {
          actor: { type: "system" },
          model: {
            provider: "elevenlabs",
            model: agent.id,
            inputTokens: 0,
            outputTokens: 0,
          },
          // A quarter of an hour at $0.10 a minute.
          cost: 1.5,
          purpose: "onboarding.interview",
          outcome: "answered",
          status: 200,
          seconds: 900,
          transport: "connect",
          credential: "platform",
          region: "eu",
        },
      ],
      auditCarries: [],
      used: 900,
    });
  });

  it("writes down only what their answers hold, as the page heard them, and nothing twice", async () => {
    const link = await opened();
    const said = "I check the invoices in Exact every morning.";
    const { requests, result } = await answering(
      [
        notes({
          facts: [
            exactFact,
            // Never said: left out.
            {
              tag: "number",
              text: "You handle 200 invoices a week.",
              record: "About 200 invoices a week.",
              quote: "two hundred a week",
            },
            // His words, not theirs: left out.
            {
              tag: "step",
              text: "You look at the invoices up close.",
              record: "Look at the invoices up close.",
              quote: "look at the invoices up close",
            },
          ],
          changes: [],
        }),
      ],
      async () => {
        const { pass } = await join(link);
        const conversation: VoiceLine[] = [
          ...heard(said),
          { from: "stephen", text: "Let's look at the invoices up close." },
        ];
        return {
          // Nothing of theirs heard yet.
          early: await noteFrom(link, pass, heard(), 0),
          answered: await noteFrom(link, pass, conversation, 0),
          // Sent again with that answer written down: nothing new.
          again: await noteFrom(link, pass, conversation, 1),
        };
      }
    );
    const brief = JSON.stringify(requests[0]?.body);
    expect({
      ...result,
      heardForNotes: brief.includes(said),
      notesAsked: requests.length,
    }).toStrictEqual({
      early: { noted: 0, turn: null },
      answered: {
        noted: 1,
        turn: { facts: [exactFact], changes: [], phase: "week" },
      },
      again: { noted: 1, turn: null },
      heardForNotes: true,
      notesAsked: 1,
    });
  });

  it("keeps a quote that runs across two answers in a row, also when the first was written down before", async () => {
    const link = await opened();
    const { result } = await answering(
      [
        notes({
          facts: [exactFact],
          changes: [],
          // Read as broken off mid-sentence: the agent ended their turn
          // there, and what they said is still written down.
          more: true,
        }),
        notes({ facts: [], changes: [] }),
        notes({ facts: [exactFact], changes: [] }),
      ],
      async () => {
        const split = heard("I check the invoices", "in Exact every morning.");
        const atOnce = await join(link);
        const together = await noteFrom(link, atOnce.pass, split, 0);
        const inTwo = await join(link);
        const first = await noteFrom(link, inTwo.pass, split.slice(0, 2), 0);
        const second = await noteFrom(link, inTwo.pass, split, first.noted);
        return { together, first, second };
      }
    );
    expect({
      together: {
        noted: result.together.noted,
        kept: result.together.turn?.facts.map(({ text }) => text),
      },
      first: result.first.noted,
      second: {
        noted: result.second.noted,
        kept: result.second.turn?.facts.map(({ text }) => text),
      },
    }).toStrictEqual({
      together: { noted: 2, kept: [exactFact.text] },
      first: 1,
      second: { noted: 2, kept: [exactFact.text] },
    });
  });

  it("writes nothing down for a pass from another link, nor one changed", async () => {
    const [own, other] = await openedTwo();
    const { pass } = await join(own);
    const [payload = "", mac = ""] = pass.split(".");
    const changed = `${payload.slice(0, -2)}AA.${mac}`;
    const said = heard("I check the invoices in Exact every morning.");

    const { requests, result } = await answering(
      [notes({ facts: [exactFact], changes: [] })],
      async () => [
        await codeOf(
          await ask(other, {
            action: "answer",
            ...standing,
            pass,
            noted: 0,
            said,
          })
        ),
        await codeOf(await ask(other, { action: "close", pass })),
        await codeOf(
          await ask(own, {
            action: "answer",
            ...standing,
            pass: changed,
            noted: 0,
            said,
          })
        ),
        await codeOf(await ask(own, { action: "close", pass: changed })),
      ]
    );

    expect({ refusals: result, notesAsked: requests.length }).toStrictEqual({
      refusals: [
        [400, "interview.invalid"],
        [400, "interview.invalid"],
        [400, "interview.invalid"],
        [400, "interview.invalid"],
      ],
      notesAsked: 0,
    });
  });

  it("counts a conversation at how long it was open once the page closes it, and opens none once the day's listening is spent", async () => {
    const { link, person } = await openedFor();
    const store = onboardingStore(env);
    const who = `link:${person}:heard`;
    const before = await tokensAsked();
    const joined = await join(link);
    // Held at the 15 minutes an interview may take, until it is closed.
    const held = await store.voiceSaid(who);
    await ask(link, { action: "close", pass: joined.pass });
    const closed = await store.voiceSaid(who);
    // Closed again: nothing more comes back.
    await ask(link, { action: "close", pass: joined.pass });
    const again = await store.voiceSaid(who);
    // The rest of the hour heard: no conversation fits any more.
    await store.countHeard(who, "interviews", 60 * 60 - again);
    const spent = await ask(link, {
      action: "open",
      event: "start",
      ...standing,
    });
    const after = await tokensAsked();
    expect({
      held,
      // A few seconds open, never the 15 minutes.
      closedUnder: closed < 30,
      again: again === closed,
      spent: spent.status,
      // The one that didn't fit asked ElevenLabs for nothing.
      asked: after.length - before.length,
    }).toStrictEqual({
      held: 15 * 60,
      closedUnder: true,
      again: true,
      spent: 429,
      asked: 1,
    });
  });

  it("holds one conversation a link at a time: the next one opened settles the one never closed, at two minutes at least", async () => {
    const store = onboardingStore(env);
    const who = `link:hold-${unique()}:heard`;
    const hour = 60 * 60;
    // Opened and left without a close, as a page reloaded does.
    await store.reserveListening(who, 900, hour, "first", at(0));
    // A minute later the next one: the first counts two minutes, not one.
    await store.reserveListening(who, 900, hour, "second", at(1));
    const afterReload = await store.voiceSaid(who, at(1));
    // Ten minutes on, another: the second counts the ten it was open.
    await store.reserveListening(who, 900, hour, "third", at(11));
    const afterTen = await store.voiceSaid(who, at(11));
    // One that would not fit is not held.
    const tooMuch = await store.reserveListening(
      who,
      3600,
      hour,
      "fourth",
      at(12)
    );
    expect({ afterReload, afterTen, tooMuch }).toStrictEqual({
      afterReload: 120 + 900,
      afterTen: 120 + 600 + 900,
      tooMuch: null,
    });
  });

  it("gives back only a conversation's own hold: an older pass's close leaves the newer one held", async () => {
    const { link, person } = await openedFor();
    const store = onboardingStore(env);
    const who = `link:${person}:heard`;
    const first = await join(link);
    // Reopened: the first is settled at two minutes, the second held whole.
    await join(link);
    const held = await store.voiceSaid(who);
    await ask(link, { action: "close", pass: first.pass });
    const afterStaleClose = await store.voiceSaid(who);
    expect({ held, afterStaleClose }).toStrictEqual({
      held: 120 + 900,
      afterStaleClose: 120 + 900,
    });
  });

  it("tells the page a conversation ElevenLabs refused didn't start, records it as failed, and gives its listening back", async () => {
    const link = await opened();
    const auditedBefore = await conversationsAudited();
    const usedBefore = await conversationsUsed();
    await plan(platformElevenLabsKey, [
      { status: 503, body: { detail: { status: "busy" } } },
      // Answered, but with no token to start it by.
      { status: 200, body: {} },
    ]);
    const refused = [
      await codeOf(
        await ask(link, { action: "open", event: "start", ...standing })
      ),
      await codeOf(
        await ask(link, { action: "open", event: "start", ...standing })
      ),
    ];
    const auditedAll = await conversationsAudited();
    const used = await conversationsUsed();
    // The hour is whole again: four still fit.
    const joins = await Promise.all(
      [1, 2, 3, 4].map(
        async () =>
          await ask(link, { action: "open", event: "start", ...standing })
      )
    );
    expect({
      refused,
      audited: auditedAll
        .slice(auditedBefore.length)
        .map(({ cost, detail }) => ({
          outcome: detail.outcome,
          status: detail.status,
          seconds: detail.seconds,
          cost: cost?.amount,
        })),
      used: used - usedBefore,
      afterwards: joins.map(({ status }) => status),
    }).toStrictEqual({
      refused: [
        [503, null],
        [503, null],
      ],
      audited: [
        { outcome: "failed", status: 503, seconds: 0, cost: 0 },
        // Answered, as the gateway reads it by its status: recorded as opened.
        { outcome: "answered", status: 200, seconds: 900, cost: 1.5 },
      ],
      used: 0,
      afterwards: [200, 200, 200, 200],
    });
  });

  it("takes a close on its pass, also once they withdrew", async () => {
    const link = await opened();
    const { pass } = await join(link);
    const open = await ask(link, { action: "close", pass });
    await onLink({ action: "withdraw", ...link });
    const withdrawn = await ask(link, { action: "close", pass });
    expect([open.status, withdrawn.status]).toStrictEqual([204, 204]);
  });

  it("writes down what they put right when they came back to add something, as an answer", async () => {
    const link = await opened();
    const adding = { ...standing, phase: "readback", adding: true } as const;
    const { requests } = await answering(
      [notes({ facts: [], changes: [] })],
      async () => {
        const opening = await ask(link, {
          action: "open",
          event: "add",
          ...adding,
        });
        const joined: VoiceSessionJoin = await opening.json();
        await ask(link, {
          action: "answer",
          ...adding,
          pass: joined.pass,
          noted: 0,
          said: heard("It waits three days, not two."),
        });
      }
    );
    const brief = JSON.stringify(requests[0]?.body);
    expect({
      answered: brief.includes("answered out loud"),
      cameBack: brief.includes("has just come back on their link"),
    }).toStrictEqual({ answered: true, cameBack: false });
  });

  it("writes down on Grasp's own Mistral key, on no other model, for who the store says they are", async () => {
    const link = await opened();
    const { requests } = await answering(
      [notes({ facts: [], changes: [] })],
      async () => {
        const { pass } = await join(link);
        await noteFrom(link, pass, heard("I look it up."), 0);
      }
    );
    // The gateway lets the interview's way through for its own models only.
    let other: string | null = null;
    try {
      await models(env).interview.call({
        model: interviewModels[0],
        purpose: "onboarding.interview",
        trigger: { type: "system" },
        work: { onboarding: true },
        input: "Hello",
      });
    } catch (error) {
      other = modelErrors.codeOf(error) ?? null;
    }
    const brief = JSON.stringify(requests[0]?.body);
    expect({
      sentTo: requests.map(({ url, headers }) => [
        new URL(url).host,
        headers.get("authorization"),
      ]),
      model: requests.map(modelOf),
      other,
      toldName: brief.includes("You talk with: Oli, Ops."),
      noLead: brief.includes('say \\"I was told\\" instead'),
      // Nothing written down yet: the first thing the record misses.
      open: brief.includes(
        String.raw`What is still open, most important first:\n- which work comes back every day or week, and how often\n`
      ),
    }).toStrictEqual({
      sentTo: [["api.mistral.ai", `Bearer ${platformMistralKey}`]],
      model: ["mistral-medium-latest"],
      other: "model.not_allowed",
      toldName: true,
      noLead: true,
      open: true,
    });
  });

  it("opens no conversation and writes nothing down for a link that opens nothing, nobody signed in, anyone else, or a page that says who it is", async () => {
    const link = await opened();
    const { pass } = await join(link);
    const someoneElse = await signedInAs(`someone-${unique()}@acme.test`);
    const before = await tokensAsked();
    const open = { action: "open", event: "start", ...standing };
    const answer = {
      action: "answer",
      ...standing,
      pass,
      noted: 0,
      said: heard("I check the invoices in Exact every morning."),
    };
    const { requests, result } = await answering([], async () => ({
      unknown: await Promise.all(
        [open, answer].map(
          async (body) =>
            await codeOf(await ask({ ...link, secret: "a".repeat(43) }, body))
        )
      ),
      signedOut: await Promise.all(
        [open, answer].map(
          async (body) => await codeOf(await ask({ ...link, cookie: "" }, body))
        )
      ),
      someoneElse: await Promise.all(
        [open, answer].map(
          async (body) =>
            await codeOf(await ask({ ...link, cookie: someoneElse }, body))
        )
      ),
      // The page can't say who it is with.
      named: await Promise.all(
        [open, answer].map(
          async (body) =>
            await codeOf(await ask(link, { ...body, name: "Someone else" }))
        )
      ),
    }));
    const after = await tokensAsked();
    expect({
      ...result,
      notesAsked: requests.length,
      opened: after.length - before.length,
    }).toStrictEqual({
      unknown: [
        [404, "interview.link_invalid"],
        [404, "interview.link_invalid"],
      ],
      signedOut: [
        [401, "interview.sign_in"],
        [401, "interview.sign_in"],
      ],
      someoneElse: [
        [404, "interview.link_invalid"],
        [404, "interview.link_invalid"],
      ],
      named: [
        [400, "interview.invalid"],
        [400, "interview.invalid"],
      ],
      notesAsked: 0,
      opened: 0,
    });
  });

  it("opens no conversation and writes nothing down for someone who didn't agree to take part, or withdrew (GRA-329, T1, T5)", async () => {
    const { link } = await openedFor({ participating: false });
    const before = await tokensAsked();
    const open = { action: "open", event: "start", ...standing };
    const correction = {
      action: "answer",
      ...readBack,
      said: [{ from: "person", text: "Three days.", typed: true }],
    };
    const { requests, result } = await answering([], async () => {
      const unagreed = [
        await codeOf(await ask(link, open)),
        await codeOf(await ask(link, correction)),
      ];
      await participate(link);
      await onLink({ action: "withdraw", ...link });
      return {
        unagreed,
        withdrawn: [
          await codeOf(await ask(link, open)),
          await codeOf(await ask(link, correction)),
        ],
      };
    });
    const after = await tokensAsked();
    expect({
      ...result,
      notesAsked: requests.length,
      opened: after.length - before.length,
    }).toStrictEqual({
      unagreed: [
        [403, "interview.not_participating"],
        [403, "interview.not_participating"],
      ],
      withdrawn: [
        [410, "interview.withdrawn"],
        [410, "interview.withdrawn"],
      ],
      notesAsked: 0,
      opened: 0,
    });
  });

  it("writes down what they put right in the read-back, told which lines were read back, and quotes a typed correction only as it stands", async () => {
    const link = await opened();
    const said = "No, it waits three days, and Sam approves it by e-mail.";
    const written = {
      facts: [
        {
          tag: "next",
          text: "Sam approves it.",
          record: "Sam approves it.",
          quote: "Sam approves it",
        },
        // Their words but for a hyphen: how a spoken answer is heard, never how a typed one stands.
        {
          tag: "system",
          text: "The approval comes by email.",
          record: "The approval comes by email.",
          quote: "by email",
        },
      ],
      changes: [
        {
          id: "f2",
          text: "It waits three days for approval.",
          record: "It waits three days for approval.",
        },
        // No line of theirs: left out.
        { id: "f9", text: "Unknown.", record: "Unknown." },
      ],
    };
    const { requests, result } = await answering(
      [notes(written), notes(written)],
      async () => {
        const correct = async (typed: boolean): Promise<VoiceAnswered> => {
          // No conversation is open in the read-back: no pass.
          const answered = await ask(link, {
            action: "answer",
            ...readBack,
            before: heard("I check the invoices in Exact."),
            said: [{ from: "person", text: said, ...(typed ? { typed } : {}) }],
          });
          return await answered.json();
        };
        return { typed: await correct(true), spoken: await correct(false) };
      }
    );
    const brief = JSON.stringify(requests[0]?.body);
    expect({
      typed: {
        facts: result.typed.turn?.facts.map(({ text }) => text),
        changes: result.typed.turn?.changes,
      },
      spoken: result.spoken.turn?.facts.map(({ text }) => text),
      toldWhatWasRead: brief.includes(
        "You read these lines back to Oli: f1, f2. Their last line is their answer to that."
      ),
      toldTheConversation: brief.includes("I check the invoices in Exact."),
    }).toStrictEqual({
      typed: {
        facts: ["Sam approves it."],
        changes: [
          {
            id: "f2",
            text: "It waits three days for approval.",
            record: "It waits three days for approval.",
          },
        ],
      },
      spoken: ["Sam approves it.", "The approval comes by email."],
      toldWhatWasRead: true,
      toldTheConversation: true,
    });
  });

  it("answers a line they changed on their screen as exactly that change, whatever the notes' model makes of it", async () => {
    const link = await opened();
    const edit = { id: "f2", text: "It waits three days for approval." };
    const edited = async (): Promise<VoiceAnswered> => {
      const answered = await ask(link, {
        action: "answer",
        ...readBack,
        said: [
          {
            from: "person",
            text: "Change “It waits two days for approval” to “It waits three days for approval”.",
            typed: true,
          },
        ],
        edit,
      });
      return await answered.json();
    };
    const { result } = await answering(
      [
        // Other words than theirs, another line changed, and a fact of its own.
        notes({
          facts: [
            {
              tag: "wait",
              text: "It waits three days.",
              record: "It waits three days.",
              quote: "It waits three days for approval",
            },
          ],
          changes: [
            {
              id: "f2",
              text: "Approval takes about three days.",
              record: "The invoice waits 3 days for approval.",
            },
            { id: "f1", text: "", record: "" },
          ],
        }),
        // Nothing changed at all.
        notes({ facts: [], changes: [] }),
      ],
      async () => [await edited(), await edited()]
    );
    expect(result.map(({ turn }) => turn)).toStrictEqual([
      {
        facts: [],
        changes: [
          { ...edit, record: "The invoice waits 3 days for approval." },
        ],
        phase: "readback",
      },
      {
        facts: [],
        changes: [{ ...edit, record: edit.text }],
        phase: "readback",
      },
    ]);
  });

  it("takes no answer of a conversation without its pass, and no changed line outside the lines they have", async () => {
    const link = await opened();
    const said = heard("I check the invoices in Exact every morning.");
    const { requests, result } = await answering([], async () => [
      await codeOf(
        await ask(link, { action: "answer", ...standing, noted: 0, said })
      ),
      await codeOf(
        await ask(link, {
          action: "answer",
          ...readBack,
          said,
          edit: { id: "f7", text: "Something else." },
        })
      ),
      await codeOf(
        await ask(link, {
          action: "answer",
          ...standing,
          noted: 0,
          said,
          edit: { id: "f1", text: "Something else." },
        })
      ),
    ]);
    expect({ refusals: result, notesAsked: requests.length }).toStrictEqual({
      refusals: [
        [400, "interview.invalid"],
        [400, "interview.invalid"],
        [400, "interview.invalid"],
      ],
      notesAsked: 0,
    });
  });

  it("answers a link no turn any more: the turn-by-turn endpoint is gone", async () => {
    const link = await opened();
    const answered = await postedOnLink("/api/interview/turn", {
      ...link,
      event: "start",
      locale: "en",
      lines: [],
      facts: [],
      phase: "open",
      minutes: 0,
    });
    expect([
      answered.status,
      errorPayloadSchema.safeParse(await answered.json()).data?.code,
    ]).toStrictEqual([404, "request.not_found"]);
  });
});
