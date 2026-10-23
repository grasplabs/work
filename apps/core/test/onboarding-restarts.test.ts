import { interviewApiPath } from "@grasp-os/shared/interview-links";
import type {
  InterviewFact,
  InterviewLine,
  InterviewProgress,
  InterviewSaved,
} from "@grasp-os/shared/interview-links";
import { interviewTurnPath, turnEvents } from "@grasp-os/shared/interview-turn";
import type { Roster } from "@grasp-os/shared/onboarding";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { onboardingStore } from "../src/onboarding/store.ts";
import type { GatewayReply } from "./ai-gateway.ts";
import { answering, careful, openedFor, quick } from "./interview-link.ts";
import { routed, unique } from "./sign-in.ts";

// The onboarding's durability (GRA-339): its Worker restarted in the middle
// of an interview's turn, and in the middle of a team's drawing, as a
// deploy restarts it. Everything kept lives in the Onboarding object, so
// that is what restarts here, the turn's request cut off with it; AI
// Gateway, the outside system, is faked behind the AI binding. The
// end-to-end journeys (e2e/*-journey.e2e.ts) can't do this: one local
// server serves every Playwright test, and it can't be restarted under
// them. What must not happen:
//
// - What was said before the restart lost, or kept twice once the page
//   asks again and saves again.
// - The turn the restart cut off going uncounted: its line's model was
//   asked, and what it took is on the bill.
// - A drawing cut off by the restart never drawn, or drawn twice: the
//   team's pieces of work doubled, or its links sent twice.

const dayMs = 24 * 60 * 60 * 1000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const sessionKey = z.object({ key: z.string().optional() });

/** Waits, from the test's own context, until `done` holds. */
const until = async (done: () => boolean): Promise<void> => {
  await vi.waitFor(
    () => {
      if (!done()) {
        throw new Error("Not yet");
      }
    },
    { timeout: 10_000, interval: 50 }
  );
};

/**
 * Restarts the onboarding's object where it is, as a deploy does. The call
 * that aborts it may never settle while the object was busy, so this waits
 * only until the abort was done.
 */
const restart = async (): Promise<void> => {
  const done = { aborted: false };
  void (async () => {
    try {
      await runInDurableObject(onboardingStore(env), (_instance, state) => {
        done.aborted = true;
        state.abort("Restarted by the test");
      });
    } catch {
      // Aborting fails the call that aborted: that is the restart.
    }
  })();
  await until(() => done.aborted);
};

/** What his line's model answers: six named lines. */
const line = (say: string): GatewayReply => ({
  text: `TONE: none\nSAY: ${say}\nPART: steps\nWANTS: answer\nMORE: no\nAGREED: no\n`,
  inputTokens: 1500,
  outputTokens: 40,
});

/** What the notes' model answers: nothing new written down. */
const noNotes: GatewayReply = {
  text: JSON.stringify({ facts: [], changes: [] }),
  inputTokens: 1600,
  outputTokens: 20,
};

/** Saves the page's progress on the link, from the version it holds. */
const save = async (
  link: { secret: string; key: string },
  version: number,
  progress: InterviewProgress
): Promise<InterviewSaved> => {
  const response = await routed(interviewApiPath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "save", ...link, version, progress }),
  });
  return await response.json();
};

/** The page's progress with `lines` said so far, and `facts` agreed or not. */
const progressOf = (
  lines: InterviewLine[],
  facts: InterviewFact[] = [],
  person: InterviewProgress["person"] = "incomplete"
): InterviewProgress => ({
  person,
  told: true,
  mode: "type",
  lines,
  facts,
  phase: "steps",
  wants: "answer",
  startedAt: Date.now(),
  confirmed: facts.length,
  adding: false,
  addedAt: 0,
});

/** A turn asked for, as the page asks it after `lines`. */
const askTurn = async (
  link: { secret: string; key: string },
  lines: InterviewLine[]
): Promise<Response> =>
  await routed(interviewTurnPath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...link,
      event: "answer",
      locale: "en",
      lines,
      facts: [],
      phase: "steps",
      minutes: 4,
    }),
  });

/** Stephen's line in a whole turn's answer. */
const sayOf = async (response: Response): Promise<string | undefined> =>
  turnEvents(`${await response.text()}\n`)
    .events.flatMap((event) => ("turn" in event ? [event.turn.say] : []))
    .at(0);

/** Calls the onboarding counted for `purpose` on `model`. */
const callsFor = async (purpose: string, model: string): Promise<number> => {
  const rows = await onboardingStore(env).usage();
  return rows
    .filter((row) => row.purpose === purpose && row.model === model)
    .reduce((sum, { calls }) => sum + calls, 0);
};

describe("the onboarding after a restart", { timeout: 60_000 }, () => {
  it("loses nothing of an interview whose turn a restart cut off, and keeps nothing twice once the page asks again", async () => {
    const { link, person } = await openedFor();
    const asked: InterviewLine = {
      from: "stephen",
      text: "What do you do first with an invoice?",
    };
    const answer: InterviewLine = {
      from: "person",
      text: "I check it in Exact.",
      typed: true,
    };
    const before = await save(link, 0, progressOf([asked, answer]));
    const counted = await callsFor("interviews", quick);

    // The turn is under way, his line half written, when the object restarts.
    const reached = Promise.withResolvers<null>();
    const held = Promise.withResolvers<null>();
    await answering(
      [
        {
          ...line("And who gets it after you?"),
          pause: {
            at: 12,
            until: held.promise,
            reached: () => {
              reached.resolve(null);
            },
          },
        },
      ],
      async () => {
        const cut = await askTurn(link, [asked, answer]);
        await reached.promise;
        await restart();
        // The restart ends the turn's request: the page sees it break off.
        await cut.body?.cancel();
        held.resolve(null);
        return null;
      }
    );

    // The page asks for the same turn again, and saves what came of it.
    const next = "And who gets it after you?";
    const { result: again } = await answering(
      [line(next), noNotes],
      async () => await sayOf(await askTurn(link, [asked, answer]))
    );
    const said: InterviewLine = { from: "stephen", text: next };
    const after = await save(
      link,
      before.version,
      progressOf([asked, answer, said])
    );
    // A page that never heard back saves it once more: refused, as stale.
    const twice = await save(
      link,
      before.version,
      progressOf([asked, answer, said])
    );
    const kept = await onboardingStore(env).transcriptOf(person);
    expect({
      again,
      saved: [before.saved, after.saved, twice.saved],
      lines: kept?.progress?.lines.map(({ text }) => text),
      // The turn cut off is counted for what it took, and the one asked again.
      calls: (await callsFor("interviews", quick)) - counted,
    }).toStrictEqual({
      again: next,
      saved: [true, true, false],
      lines: [asked.text, answer.text, next],
      calls: 2,
    });
  });

  it("draws a team's map a restart cut off once it is back, once: its pieces of work and its links not doubled", async () => {
    const store = onboardingStore(env);
    const id = unique();
    const ids = {
      team: `ops-${id}`,
      lea: `lea-${id}`,
      max: `max-${id}`,
      mia: `mia-${id}`,
    };
    const member = (person: string, name: string) => ({
      id: person,
      name,
      team: ids.team,
      email: "",
      title: "",
      away: false,
    });
    const roster: Roster = {
      teams: [
        { id: ids.team, name: "Ops", lead: ids.lea, does: "", off: false },
      ],
      people: [
        member(ids.lea, "Lea Lind"),
        member(ids.max, "Max Mol"),
        member(ids.mia, "Mia Moor"),
      ],
    };
    const by = { type: "system" } as const;
    await store.setPaused(false, by);
    await store.saveRoster(roster, by);
    await store.savePlan({ start: isoDay(Date.now() - dayMs), days: 14 }, by);
    await store.setAgreements(
      { processing: true, assessment: true, council: "none" },
      by
    );
    const first = await store.releaseDue();

    // Lea agrees to her interview.
    const leasLink = await store.linkOf(ids.lea);
    const secret = leasLink?.split("#")[1] ?? "";
    const session = await routed(interviewApiPath, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "session", secret }),
    });
    const { key = "" } = sessionKey.parse(await session.json());
    await save(
      { secret, key },
      0,
      progressOf(
        [{ from: "stephen", text: "What does your team do?" }],
        [
          {
            id: "f1",
            tag: "work",
            text: "Max and Mia handle new tickets.",
            record: "Max and Mia handle new tickets.",
            agreed: true,
          },
        ],
        "completed"
      )
    );
    const map: GatewayReply = {
      text: JSON.stringify({
        does: "Answers customers' questions",
        works: [
          {
            name: "Handling new tickets",
            local: "Handling new tickets",
            one: "ticket",
            many: "tickets",
            doers: [ids.max, ids.mia],
            share: 1,
          },
        ],
      }),
      inputTokens: 2000,
      outputTokens: 300,
    };
    const counted = await callsFor("drawing", careful);

    // The map is half written when the object restarts.
    // Noted as a flag, not a promise: what the object resolves goes on in
    // the object, and dies with it.
    const drawing = { reached: false };
    const held = Promise.withResolvers<null>();
    await answering(
      [
        {
          ...map,
          pause: {
            at: 20,
            until: held.promise,
            reached: () => {
              drawing.reached = true;
            },
          },
        },
      ],
      async () => {
        // The call that was drawing is lost with the object: nobody waits for it.
        void (async () => {
          try {
            await store.drawNext();
          } catch {
            // Cut off by the restart.
          }
        })();
        await until(() => drawing.reached);
        await restart();
        held.resolve(null);
        return null;
      }
    );

    // Back, it is still due, and drawn the next time the alarm draws.
    const back = onboardingStore(env);
    const due = await back.drawsDue();
    const { result: drew } = await answering(
      [map],
      async () => await back.drawNext()
    );
    const opened = await back.releaseDue();
    const openedAgain = await back.releaseDue();
    const works = await back.teamWorks(ids.team);
    const dueAfter = await back.drawsDue();
    expect({
      first,
      dueAfterRestart: due.includes(ids.lea),
      drew,
      dueAfterDrawing: dueAfter.includes(ids.lea),
      works: works.map(({ name }) => name),
      opened,
      openedAgain,
      calls: (await callsFor("drawing", careful)) - counted,
    }).toStrictEqual({
      first: [ids.lea],
      dueAfterRestart: true,
      drew: `team:${ids.team}`,
      dueAfterDrawing: false,
      works: ["handling new tickets"],
      opened: [ids.max, ids.mia],
      openedAgain: [],
      calls: 1,
    });
  });
});
