/**
 * One interview played on a link (play.ts), against a stand-in for the
 * local core's interview endpoints: Stephen's turns scripted, the person
 * scripted. What it must get right is what the page does: keep every
 * change, read back a part at a time, and count only what was agreed to.
 */
import type { InterviewProgress } from "@grasp-os/shared/interview-links";
import type {
  InterviewTurnRequest,
  StephenTurn,
} from "@grasp-os/shared/interview-turn";
import { describe, expect, it } from "vite-plus/test";

import type { Link } from "./core.ts";
import type { Answer, Player } from "./person.ts";
import { agrees, playInterview } from "./play.ts";

type Asked = Omit<InterviewTurnRequest, "secret" | "key">;

const stephen = (more: Partial<StephenTurn>): StephenTurn => ({
  say: "",
  tone: null,
  phase: "story",
  facts: [],
  changes: [],
  wants: "answer",
  more: false,
  approved: false,
  ...more,
});

const step = (text: string) => ({
  tag: "step" as const,
  text,
  record: text,
  quote: text,
});

/** A link whose turns are `turns`, in order; it keeps every save and every turn asked. */
const scriptedLink = (turns: StephenTurn[]) => {
  const saved: InterviewProgress[] = [];
  const asked: Asked[] = [];
  const link: Link = {
    open: async () =>
      await Promise.resolve({
        state: "open",
        key: "device-key",
        name: "Sanne",
        kind: "own",
        progress: null,
        version: 0,
      }),
    save: async (_key, version, progress) => {
      saved.push(progress);
      return await Promise.resolve(version + 1);
    },
    turn: async (request) => {
      asked.push(request);
      const next = turns.shift();
      if (next === undefined) {
        throw new Error("Stephen has nothing more to say.");
      }
      return await Promise.resolve(next);
    },
  };
  return { link, saved, asked };
};

/** Someone who says `answers` in order, and `readBack` to each part read back. */
const scriptedPlayer = (answers: Answer[], readBack: string[]): Player => ({
  name: "Sanne",
  answer: async (_lines, _asked, at) => {
    const next = at.readback
      ? { say: readBack.shift() ?? "", said: [] }
      : answers.shift();
    return await Promise.resolve(next ?? { say: "…", said: [] });
  },
});

describe("an interview played on a link", () => {
  it("keeps what was said, reads it back, and has it all agreed to at the end", async () => {
    const { link, saved } = scriptedLink([
      stephen({ say: "How did the last invoice come in?" }),
      stephen({
        say: "And then?",
        facts: [step("You open the invoice mail.")],
      }),
      stephen({
        say: "I'll read back what I wrote down.",
        facts: [step("You upload it to Exact.")],
        wants: "readback",
      }),
    ]);
    const played = await playInterview(
      link,
      scriptedPlayer(
        [
          { say: "I open the invoice mail.", said: ["S1"] },
          { say: "I upload it to Exact.", said: ["S2"] },
        ],
        ["Yes, that’s right."]
      ),
      { locale: "en" }
    );
    const last = saved.at(-1);
    expect({
      said: played.said,
      readbackFrom: played.readbackFrom,
      person: last?.person,
      facts: last?.facts.map(({ text, agreed }) => [text, agreed]),
    }).toStrictEqual({
      said: [["S1"], ["S2"]],
      readbackFrom: 5,
      person: "completed",
      facts: [
        ["You open the invoice mail.", true],
        ["You upload it to Exact.", true],
      ],
    });
  });

  it("puts a line right in the read-back, through a turn of Stephen's", async () => {
    const { link, saved, asked } = scriptedLink([
      stephen({
        say: "I'll read back what I wrote down.",
        facts: [step("You open the mail at nine.")],
        wants: "readback",
      }),
      stephen({
        say: "Changed it. Is it right now?",
        changes: [
          { id: "f1", text: "You open the mail at ten.", record: null },
        ],
      }),
    ]);
    await playInterview(
      link,
      scriptedPlayer([], ["No, at ten.", "Yes, that’s right."]),
      { locale: "en" }
    );
    expect({
      reading: asked.at(-1)?.reading,
      facts: saved.at(-1)?.facts.map(({ text }) => text),
    }).toStrictEqual({
      reading: ["f1"],
      facts: ["You open the mail at ten."],
    });
  });

  it("agrees to nothing for someone who goes away before the read-back", async () => {
    const { link, saved } = scriptedLink([
      stephen({ say: "How did the last invoice come in?" }),
    ]);
    const played = await playInterview(
      link,
      scriptedPlayer([{ say: "have to go now", said: [], left: true }], []),
      { locale: "en" }
    );
    expect({
      left: played.left,
      person: saved.at(-1)?.person,
    }).toStrictEqual({ left: true, person: "progress" });
  });
});

describe("whether a reply agrees to what was read back", () => {
  it.each([
    ["Yes, that’s right.", true],
    ["Ja, klopt.", true],
    ["Yes, but the second line is wrong: I never open it in Outlook.", false],
    ["No, at ten.", false],
  ])("%s", (reply, agreed) => {
    expect(agrees(reply)).toBe(agreed);
  });
});
