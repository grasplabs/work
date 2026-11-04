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
import { askedFor, awayLine, pasteOf, splitOf } from "./events.ts";
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

/** Someone who says `answers` in order and agrees to every part read back; it keeps what each answer was asked for. */
const askedPlayer = (answers: Answer[]) => {
  const prompts: string[] = [];
  const player: Player = {
    name: "Sanne",
    answer: async (_lines, asked, at) => {
      if (at.readback) {
        return await Promise.resolve({ say: "Yes, that’s right.", said: [] });
      }
      prompts.push(asked);
      return await Promise.resolve(answers.shift() ?? { say: "…", said: [] });
    },
  };
  return { player, prompts };
};

const toReadBack = stephen({
  say: "I'll read back what I wrote down.",
  facts: [step("You open the invoice mail.")],
  wants: "readback",
});

describe("what happens to them on the way", () => {
  it("called away: they say so, he answers, and after the minutes away they answer the question from before", async () => {
    const { link, asked } = scriptedLink([
      stephen({ say: "How did the last invoice come in?" }),
      stephen({ say: "Of course, I'll wait." }),
      toReadBack,
    ]);
    const { player, prompts } = askedPlayer([
      { say: "Back. By mail, as always.", said: ["S1"] },
    ]);
    const played = await playInterview(link, player, {
      locale: "en",
      clock: "talk",
      events: [{ kind: "interrupted", at: 0, away: 3, pick: 1 }],
    });
    expect({
      first: played.said[0],
      prompts,
      events: played.events,
    }).toStrictEqual({
      first: [],
      prompts: [askedFor.back],
      events: [{ kind: "interrupted", answer: 1 }],
    });
    expect((asked[2]?.minutes ?? 0) - (asked[1]?.minutes ?? 0)).toBeGreaterThan(
      3
    );
    expect(asked[1]?.lines.at(-1)?.text).toBe(awayLine("en", 1));
  });

  it("back much later: the link is opened again, he gets a resume, and the time away counts as the page counts it", async () => {
    const { link, asked } = scriptedLink([
      stephen({ say: "How did the last invoice come in?" }),
      stephen({
        say: "Welcome back. We were at the last invoice: how did it come in?",
      }),
      toReadBack,
    ]);
    let opens = 0;
    const counted: Link = {
      ...link,
      open: async (key) => {
        opens += 1;
        return await link.open(key);
      },
    };
    const { player } = askedPlayer([{ say: "By mail.", said: ["S1"] }]);
    const played = await playInterview(counted, player, {
      locale: "en",
      clock: "talk",
      events: [{ kind: "resumes later", at: 0, away: 20 }],
    });
    expect({
      opens,
      events: asked.map(({ event }) => event),
      happened: played.events,
      lines: asked[1]?.lines.length,
    }).toStrictEqual({
      opens: 2,
      events: ["start", "resume", "answer"],
      happened: [{ kind: "resumes later", answer: 0 }],
      lines: 1,
    });
    expect(asked[1]?.minutes).toBe(5);
  });

  it("the wrong thing pasted: no fact of theirs in it, all of it untrue, and next they say it was a mistake", async () => {
    const { link } = scriptedLink([
      stephen({ say: "What did you do first?" }),
      stephen({ say: "That looks like a formula. What did you mean?" }),
      toReadBack,
    ]);
    const { player, prompts } = askedPlayer([
      { say: "Oops, wrong paste. I opened the mail.", said: ["S1"] },
    ]);
    const played = await playInterview(link, player, {
      locale: "en",
      events: [{ kind: "wrong paste", at: 0, pick: 0 }],
    });
    expect({
      said: played.said,
      untrue: played.untrue[0],
      prompts,
    }).toStrictEqual({
      said: [[], ["S1"]],
      untrue: [`(pasted by mistake) ${pasteOf("en", 0)}`],
      prompts: [askedFor.afterPaste],
    });
  });

  it("one answer in two messages: when he waits for the rest it is one line, and when he speaks to the first part it is two", async () => {
    const say =
      "I open the order list first, then I check the prices against the sheet and send it on.";
    const [start = "", rest = ""] = splitOf(say) ?? [];
    const play = async (afterFirst: StephenTurn) => {
      const { link, asked } = scriptedLink([
        stephen({ say: "What did you do first?" }),
        afterFirst,
        toReadBack,
      ]);
      const { player } = askedPlayer([{ say, said: ["S1"] }]);
      const played = await playInterview(link, player, {
        locale: "en",
        events: [{ kind: "split message", at: 0 }],
      });
      return {
        sent: asked.map(({ lines }) => lines.at(-1)?.text),
        said: played.said,
        events: played.events,
      };
    };
    await expect(play(stephen({ say: "", more: true }))).resolves.toStrictEqual(
      {
        sent: [undefined, start, `${start} ${rest}`],
        said: [["S1"]],
        events: [{ kind: "split message", answer: 1, waited: true }],
      }
    );
    await expect(
      play(stephen({ say: "Right, the list. Then?" }))
    ).resolves.toStrictEqual({
      sent: [undefined, start, rest],
      said: [[], ["S1"]],
      events: [{ kind: "split message", answer: 1, waited: false }],
    });
  });

  it("a question read wrongly: only one about how often or how long, so the event waits for one", async () => {
    const { link } = scriptedLink([
      stephen({ say: "What did you do first?" }),
      stephen({ say: "How often does that happen in a normal week?" }),
      toReadBack,
    ]);
    const { player, prompts } = askedPlayer([
      { say: "I opened the mail.", said: ["S1"] },
      { say: "About ten minutes.", said: [] },
    ]);
    const played = await playInterview(link, player, {
      locale: "en",
      events: [{ kind: "misread", at: 0 }],
    });
    expect({ prompts, events: played.events }).toStrictEqual({
      prompts: [
        "Your answer to Stephen’s last line, and nothing else:",
        askedFor.misread,
      ],
      events: [{ kind: "misread", answer: 2 }],
    });
  });

  it("with nothing planned, the played interview has no events", async () => {
    const { link } = scriptedLink([
      stephen({ say: "What did you do first?" }),
      toReadBack,
    ]);
    const { player } = askedPlayer([{ say: "I opened the mail.", said: [] }]);
    const played = await playInterview(link, player, { locale: "en" });
    expect(played.events).toBeUndefined();
  });
});
