import { interviewVoicePath } from "@grasp-os/shared/interview-voice";
import type {
  VoiceAnswered,
  VoiceSessionJoin,
} from "@grasp-os/shared/interview-voice";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { onboardingStore } from "../src/onboarding/store.ts";
import { refusalDetailOf } from "../src/onboarding/voice.ts";
import { allEvents } from "./audit-events.ts";
import { platformMistralKey } from "./connect-providers.ts";
import {
  answering,
  codeOf,
  holdAlarm,
  onLink,
  opened,
  openLinkAs,
  participate,
  postedOnLink,
  signedInAs,
} from "./interview-link.ts";
import type { Device } from "./interview-link.ts";
import type { ProviderReply } from "./model-provider.ts";
import { carrying, plan } from "./platform-providers.ts";
import { unique } from "./sign-in.ts";

// An interview held as one live voice session at Mistral
// (src/onboarding/voice.ts), over its endpoint, as the page asks for it.
// Mistral's voice sessions are the outside system, answered by the
// providers' fake behind connect with Grasp's key; the organization's
// model writes down what was said. The ways it can fail, tried here:
//
// - Grasp's key reaching the page: the page gets the room's token and
//   address, and a pass.
// - The page making up what was said: facts are written from Mistral's own
//   transcript, and one whose words aren't in it is left out.
// - Someone reading another person's session: a pass from another link,
//   or one changed, reads nothing.
// - Something written down twice: nothing is, until Mistral has one more
//   answer of theirs.
// - A session opened unrecorded, or recorded with what was said.

/** A session as Mistral opens one. */
const openedSession = {
  id: "sess_7f3a",
  participant_token: "room-token-not-a-key",
  server_url: "wss://voice.mistral.test",
  created_at: "2026-11-25T10:00:00.000Z",
  expires_at: "2026-11-25T10:05:00.000Z",
};

/** What Mistral kept of a session: Stephen's first line, then their answer, and him going on to part 3. */
const kept = (answer: string) => ({
  id: openedSession.id,
  status: "active",
  num_participants: 1,
  created_at: openedSession.created_at,
  transcripts: [
    {
      role: "assistant",
      content: "What do you do here, in a sentence or two?",
      is_interruption: false,
      timestamp: "2026-11-25T10:00:01.000Z",
      latency: {},
    },
    {
      role: "user",
      content: answer,
      timestamp: "2026-11-25T10:00:05.000Z",
      latency: {},
    },
    {
      role: "assistant",
      content: "Let's look at the invoices up close.",
      is_interruption: true,
      tool_calls: [
        { id: "call_1", name: "part", arguments: '{"part":"anchor"}' },
      ],
      timestamp: "2026-11-25T10:00:09.000Z",
      latency: {},
    },
  ],
});

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

const ask = async (link: Device, body: Record<string, unknown>) =>
  await postedOnLink(interviewVoicePath, { ...link, ...body });

/** The requests Mistral got on Grasp's key, as method and path. */
const atMistral = async () => {
  const carried = await carrying(platformMistralKey);
  return carried
    .filter(({ path }) => path.startsWith("/v1/audio/sessions"))
    .map(({ method, path, body }) => ({ method, path, body }));
};

/** The seconds of live voice sessions the onboarding counted, every day together. */
const sessionsUsed = async (): Promise<number> => {
  const rows = await onboardingStore(env).usage();
  return rows
    .filter(
      (row) => row.purpose === "interviews" && row.model === "conversation"
    )
    .reduce((sum, { seconds }) => sum + seconds, 0);
};

/** The audit events of voice sessions opened. */
const sessionsOpened = async () => {
  const events = await allEvents();
  return events.filter(
    ({ action, model }) =>
      action === "model.call" && model?.model === "mistral-small-latest"
  );
};

describe("an interview as a live voice session", { timeout: 60_000 }, () => {
  beforeEach(holdAlarm);

  it("opens the session at Mistral with Grasp's key, writes down what Mistral heard, tells Stephen where it stands now, and closes it", async () => {
    const link = await opened();
    const sentBefore = await atMistral();
    const auditedBefore = await sessionsOpened();
    const said = "I check the invoices in Exact every morning.";
    await plan(platformMistralKey, [
      { status: 200, body: openedSession },
      // Mistral has written nothing down yet.
      { status: 200, body: { ...kept(said), transcripts: null } },
      { status: 200, body: kept(said) },
      // Read again with that answer written down: nothing new.
      { status: 200, body: kept(said) },
      { status: 200, body: {} },
    ]);
    const { requests, result } = await answering(
      [
        notes({
          facts: [
            {
              tag: "step",
              text: "You check the invoices in Exact.",
              record: "Check the invoices in Exact.",
              quote: "I check the invoices in Exact",
            },
            // Never said: left out.
            {
              tag: "number",
              text: "You handle 200 invoices a week.",
              record: "About 200 invoices a week.",
              quote: "two hundred a week",
            },
          ],
          changes: [],
        }),
      ],
      async () => {
        const join = await ask(link, {
          action: "open",
          event: "start",
          ...standing,
        });
        const joined: VoiceSessionJoin = await join.json();
        const early = await ask(link, {
          action: "answer",
          ...standing,
          pass: joined.pass,
          noted: 0,
        });
        const answered = await ask(link, {
          action: "answer",
          ...standing,
          pass: joined.pass,
          noted: 0,
        });
        const again = await ask(link, {
          action: "answer",
          ...standing,
          pass: joined.pass,
          noted: 1,
        });
        const closed = await ask(link, { action: "close", pass: joined.pass });
        const earlyAnswer: VoiceAnswered = await early.json();
        const answer: VoiceAnswered = await answered.json();
        const againAnswer: VoiceAnswered = await again.json();
        return {
          joined,
          early: earlyAnswer,
          answered: answer,
          again: againAnswer,
          closed: closed.status,
        };
      }
    );
    const sentAll = await atMistral();
    const sent = sentAll.slice(sentBefore.length);
    const asked = sent[0]?.body ?? "";
    const brief = JSON.stringify(requests[0]?.body);
    const auditedAll = await sessionsOpened();
    const audited = auditedAll.slice(auditedBefore.length);
    expect({
      join: {
        ...result.joined,
        pass: typeof result.joined.pass === "string",
      },
      keyHandedBack: JSON.stringify(result).includes(platformMistralKey),
      sent: sent.map(({ method, path }) => ({ method, path })),
      // Told who he talks with, from the store, on Mistral Small, in his
      // voice, with talking over him listened for and his first line said
      // for him.
      session: {
        who: asked.includes("You talk with: Oli, Ops."),
        model: asked.includes('"llm":{"model":"mistral-small-latest"}'),
        voice: asked.includes('"voice_id":"voice_485"'),
        interrupts: asked.includes('"allow_interruptions":true'),
        listens: asked.includes('"start_threshold":0.3'),
        welcome: asked.includes("What do you do here, in a sentence or two?"),
        part: asked.includes('"name":"part"'),
      },
      early: {
        noted: result.early.noted,
        turn: result.early.turn,
        lines: result.early.lines.length,
      },
      noted: result.answered.noted,
      lines: result.answered.lines,
      turn: result.answered.turn,
      // What he is told from now on: what was written down, and the part he went to.
      toldNow: {
        written: result.answered.instructions.includes(
          "You check the invoices in Exact."
        ),
        part: result.answered.instructions.includes(
          "The part you were in: anchor."
        ),
      },
      heardForNotes: brief.includes(said),
      // Written down in the part they answered in, not the one he went on to.
      notesPart: brief.includes("The part you were in: week."),
      // Read again with nothing new: nothing written twice, no model asked.
      again: { noted: result.again.noted, turn: result.again.turn },
      notesAsked: requests.length,
      closed: result.closed,
      audited: audited.map(({ detail }) => ({
        purpose: detail.purpose,
        outcome: detail.outcome,
        seconds: detail.seconds,
        credential: detail.credential,
      })),
      // Never what was said, nor his instructions.
      auditCarries: JSON.stringify(audited).includes("Exact"),
    }).toStrictEqual({
      join: {
        id: "sess_7f3a",
        participantToken: "room-token-not-a-key",
        serverUrl: "wss://voice.mistral.test",
        expiresAt: "2026-11-25T10:05:00.000Z",
        pass: true,
      },
      keyHandedBack: false,
      sent: [
        { method: "POST", path: "/v1/audio/sessions" },
        { method: "GET", path: "/v1/audio/sessions/sess_7f3a" },
        { method: "GET", path: "/v1/audio/sessions/sess_7f3a" },
        { method: "GET", path: "/v1/audio/sessions/sess_7f3a" },
        { method: "DELETE", path: "/v1/audio/sessions/sess_7f3a" },
      ],
      session: {
        who: true,
        model: true,
        voice: true,
        interrupts: true,
        listens: true,
        welcome: true,
        part: true,
      },
      early: { noted: 0, turn: null, lines: 0 },
      noted: 1,
      lines: [
        {
          from: "stephen",
          text: "What do you do here, in a sentence or two?",
        },
        { from: "person", text: said },
        { from: "stephen", text: "Let's look at the invoices up close." },
      ],
      turn: {
        facts: [
          {
            tag: "step",
            text: "You check the invoices in Exact.",
            record: "Check the invoices in Exact.",
            quote: "I check the invoices in Exact",
          },
        ],
        changes: [],
        phase: "anchor",
      },
      toldNow: { written: true, part: true },
      heardForNotes: true,
      notesPart: true,
      again: { noted: 1, turn: null },
      notesAsked: 1,
      closed: 204,
      audited: [
        {
          purpose: "onboarding.interview",
          outcome: "answered",
          seconds: 900,
          credential: "platform",
        },
      ],
      auditCarries: false,
    });
  });

  it("reads no session for a pass from another link, nor one changed", async () => {
    const [own, other] = await openedTwo();
    await plan(platformMistralKey, [{ status: 200, body: openedSession }]);
    const join = await ask(own, {
      action: "open",
      event: "start",
      ...standing,
    });
    const joined: VoiceSessionJoin = await join.json();
    const { pass } = joined;
    const before = await atMistral();
    const [payload = "", mac = ""] = pass.split(".");
    const changed = `${payload.slice(0, -2)}AA.${mac}`;

    const refusals = [
      await codeOf(
        await ask(other, { action: "answer", ...standing, pass, noted: 0 })
      ),
      await codeOf(await ask(other, { action: "close", pass })),
      await codeOf(
        await ask(own, {
          action: "answer",
          ...standing,
          pass: changed,
          noted: 0,
        })
      ),
    ];

    const after = await atMistral();
    expect({
      refusals,
      readAtMistral: after.length - before.length,
    }).toStrictEqual({
      refusals: [
        [400, "interview.invalid"],
        [400, "interview.invalid"],
        [400, "interview.invalid"],
      ],
      readAtMistral: 0,
    });
  });

  it("tells the page a session Mistral refused didn't start, and closes one it opened but answered unusably", async () => {
    const link = await opened();
    const asked = await atMistral();
    await plan(platformMistralKey, [
      { status: 503, body: { message: "Busy" } },
      // Opened, but with no room to join.
      { status: 200, body: { id: "sess_9b1c", participant_token: "" } },
      { status: 200, body: {} },
    ]);
    const { result } = await answering([], async () => ({
      busy: await codeOf(
        await ask(link, { action: "open", event: "start", ...standing })
      ),
      unusable: await codeOf(
        await ask(link, { action: "open", event: "start", ...standing })
      ),
    }));
    const after = await atMistral();
    expect({
      ...result,
      sent: after
        .slice(asked.length)
        .map(({ method, path }) => ({ method, path })),
    }).toStrictEqual({
      busy: [503, null],
      unusable: [503, null],
      sent: [
        { method: "POST", path: "/v1/audio/sessions" },
        { method: "POST", path: "/v1/audio/sessions" },
        { method: "DELETE", path: "/v1/audio/sessions/sess_9b1c" },
      ],
    });
  });

  it("closes the session they left when they come back to it, so one runs for a link", async () => {
    const link = await opened();
    await plan(platformMistralKey, [
      { status: 200, body: openedSession },
      { status: 200, body: {} },
      { status: 200, body: { ...openedSession, id: "sess_8d2e" } },
    ]);
    const before = await atMistral();
    const { result } = await answering([], async () => {
      const first = await ask(link, {
        action: "open",
        event: "start",
        ...standing,
      });
      const left: VoiceSessionJoin = await first.json();
      const back = await ask(link, {
        action: "open",
        event: "resume",
        ...standing,
        before: [
          { from: "stephen", text: "What do you do here?" },
          { from: "person", text: "I plan the routes." },
        ],
        previous: left.pass,
      });
      const resumed: VoiceSessionJoin = await back.json();
      return resumed.id;
    });
    const after = await atMistral();
    const sent = after.slice(before.length);
    expect({
      resumed: result,
      sent: sent.map(({ method, path }) => ({ method, path })),
      // The new session knows the conversation before it, and says where it goes on.
      knows: sent.at(-1)?.body.includes("I plan the routes."),
      welcomed: sent.at(-1)?.body.includes("go on where we left off"),
    }).toStrictEqual({
      resumed: "sess_8d2e",
      sent: [
        { method: "POST", path: "/v1/audio/sessions" },
        { method: "DELETE", path: "/v1/audio/sessions/sess_7f3a" },
        { method: "POST", path: "/v1/audio/sessions" },
      ],
      knows: true,
      welcomed: true,
    });
  });

  it("closes the session on its pass once they withdrew, so nothing of theirs stays open at Mistral", async () => {
    const link = await opened();
    await plan(platformMistralKey, [
      { status: 200, body: openedSession },
      { status: 200, body: {} },
    ]);
    const { result } = await answering([], async () => {
      const join = await ask(link, {
        action: "open",
        event: "start",
        ...standing,
      });
      const joined: VoiceSessionJoin = await join.json();
      await onLink({ action: "withdraw", ...link });
      const closed = await ask(link, { action: "close", pass: joined.pass });
      return closed.status;
    });
    const sent = await atMistral();
    expect({
      closed: result,
      last: sent.map(({ method, path }) => ({ method, path })).at(-1),
    }).toStrictEqual({
      closed: 204,
      last: { method: "DELETE", path: "/v1/audio/sessions/sess_7f3a" },
    });
  });

  it("keeps a quote that runs across a pause Mistral split their answer at, also one the notes' model reads as broken off", async () => {
    const link = await opened();
    const split = kept("I check the invoices");
    const transcripts = [
      ...split.transcripts.slice(0, 2),
      {
        role: "user",
        content: "in Exact every morning.",
        timestamp: "2026-11-25T10:00:06.000Z",
        latency: {},
      },
    ];
    await plan(platformMistralKey, [
      { status: 200, body: openedSession },
      { status: 200, body: { ...split, transcripts } },
    ]);
    const { result } = await answering(
      [
        notes({
          facts: [
            {
              tag: "step",
              text: "You check the invoices in Exact every morning.",
              record: "Check the invoices in Exact every morning.",
              quote: "I check the invoices in Exact every morning",
            },
          ],
          changes: [],
          // Read as broken off mid-sentence: Mistral ended their turn there,
          // and what they said is still written down.
          more: true,
        }),
      ],
      async () => {
        const join = await ask(link, {
          action: "open",
          event: "start",
          ...standing,
        });
        const joined: VoiceSessionJoin = await join.json();
        const answered = await ask(link, {
          action: "answer",
          ...standing,
          pass: joined.pass,
          noted: 0,
        });
        const answer: VoiceAnswered = await answered.json();
        return answer;
      }
    );
    expect({
      noted: result.noted,
      kept: result.turn?.facts.map(({ text }) => text),
    }).toStrictEqual({
      noted: 2,
      kept: ["You check the invoices in Exact every morning."],
    });
  });

  it("writes down what they put right when they came back to add something, as an answer", async () => {
    const link = await opened();
    await plan(platformMistralKey, [
      { status: 200, body: openedSession },
      { status: 200, body: kept("It waits three days, not two.") },
    ]);
    const adding = { ...standing, phase: "readback", adding: true } as const;
    const { requests } = await answering(
      [notes({ facts: [], changes: [] })],
      async () => {
        const join = await ask(link, {
          action: "open",
          event: "add",
          ...adding,
        });
        const joined: VoiceSessionJoin = await join.json();
        await ask(link, {
          action: "answer",
          ...adding,
          pass: joined.pass,
          noted: 0,
        });
      }
    );
    const brief = JSON.stringify(requests[0]?.body);
    expect({
      answered: brief.includes("answered out loud"),
      cameBack: brief.includes("has just come back on their link"),
    }).toStrictEqual({ answered: true, cameBack: false });
  });

  it("opens no more sessions on a link than a day's listening allows, also asked for all at once", async () => {
    const link = await opened();
    await plan(
      platformMistralKey,
      ["a", "b", "c", "d"].map((at) => ({
        status: 200,
        body: { ...openedSession, id: `sess_day_${at}` },
      }))
    );
    const before = await atMistral();
    const usedBefore = await sessionsUsed();
    // Each held at the 15 minutes it is expected to last: four fill the
    // hour, side by side as one after the other.
    const { result } = await answering([], async () => {
      const joins = await Promise.all(
        [1, 2, 3, 4, 5].map(
          async () =>
            await ask(link, { action: "open", event: "start", ...standing })
        )
      );
      return joins
        .map(({ status }) => status)
        .toSorted((one, other) => one - other);
    });
    const after = await atMistral();
    const used = await sessionsUsed();
    expect({
      statuses: result,
      opened: after.length - before.length,
      // In the onboarding's use as interviews held live, never as his voice.
      used: used - usedBefore,
    }).toStrictEqual({
      statuses: [200, 200, 200, 200, 429],
      opened: 4,
      used: 4 * 15 * 60,
    });
  });

  it("keeps a quote across a pause when the words before it were written down already", async () => {
    const link = await opened();
    const first = kept("I check the invoices");
    const rest = {
      role: "user",
      content: "in Exact every morning.",
      timestamp: "2026-11-25T10:00:06.000Z",
      latency: {},
    };
    await plan(platformMistralKey, [
      { status: 200, body: openedSession },
      {
        status: 200,
        body: { ...first, transcripts: first.transcripts.slice(0, 2) },
      },
      {
        status: 200,
        body: {
          ...first,
          transcripts: [...first.transcripts.slice(0, 2), rest],
        },
      },
    ]);
    const { result } = await answering(
      [
        notes({ facts: [], changes: [] }),
        notes({
          facts: [
            {
              tag: "step",
              text: "You check the invoices in Exact every morning.",
              record: "Check the invoices in Exact every morning.",
              quote: "I check the invoices in Exact every morning",
            },
          ],
          changes: [],
        }),
      ],
      async () => {
        const join = await ask(link, {
          action: "open",
          event: "start",
          ...standing,
        });
        const joined: VoiceSessionJoin = await join.json();
        const firstRead = await ask(link, {
          action: "answer",
          ...standing,
          pass: joined.pass,
          noted: 0,
        });
        const firstAnswer: VoiceAnswered = await firstRead.json();
        const secondRead = await ask(link, {
          action: "answer",
          ...standing,
          pass: joined.pass,
          noted: firstAnswer.noted,
        });
        const second: VoiceAnswered = await secondRead.json();
        return { first: firstAnswer.noted, second };
      }
    );
    expect({
      first: result.first,
      noted: result.second.noted,
      kept: result.second.turn?.facts.map(({ text }) => text),
    }).toStrictEqual({
      first: 1,
      noted: 2,
      kept: ["You check the invoices in Exact every morning."],
    });
  });
});

describe("a refused voice session's log", () => {
  it("names the fields Mistral refused and why, never what it was sent", () => {
    expect(
      refusalDetailOf({
        object: "error",
        message: {
          detail: [
            {
              type: "value_error",
              loc: ["body", "session", "tts", "voice_id"],
              msg: "Unknown voice",
              input: "secret words",
            },
          ],
        },
        type: "invalid_request_error",
      })
    ).toStrictEqual([
      "body.session.tts.voice_id | Unknown voice | value_error",
    ]);
    expect(
      refusalDetailOf({
        message: "Voice not found",
        type: "invalid_request_error",
        code: "3001",
      })
    ).toStrictEqual(["Voice not found | invalid_request_error | 3001"]);
  });
});
