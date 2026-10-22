import { describe, expect, it } from "vite-plus/test";

import {
  answerOf,
  asStephenSays,
  checkedTurn,
  earlyNext,
  earlyOpening,
  earlyPlainLine,
  fileCalled,
  leftOut,
  mistakesIn,
  plainLine,
  turnAnswerMax,
  turnEvents,
} from "../src/interview-turn.ts";

// Stephen's own rules, applied to what the models write (src/interview-turn.ts):
// pure logic, so tested on its own. Ported with the rules from the
// prototype (grasplabs/prototype, packages/grasp: src/lib/interview-turn.test.ts).

const answer =
  "So it lands in Zendesk, I copy the client number and check it in our sheet.";
const context = { answer, known: ["f1", "f2"], phase: "story" as const };

describe("what Stephen may say", () => {
  it("keeps one question: what comes after it is not said", () => {
    expect(
      asStephenSays(
        "That sounds like a lot of chasing. Who gets it next? And how long does it wait?"
      )
    ).toBe("That sounds like a lot of chasing. Who gets it next?");
  });

  it.each([
    [
      "Got it. Who uses the plan after you, and how does it reach them?",
      "Got it. Who uses the plan after you?",
    ],
    [
      "What does WBS stand for here, and what do you check in the slots?",
      "What does WBS stand for here?",
    ],
    ["Wie stuurt hem dan terug, en waarom?", "Wie stuurt hem dan terug?"],
    ["Wer schickt es zurück, und warum?", "Wer schickt es zurück?"],
    ["Qui le renvoie, et pourquoi ?", "Qui le renvoie ?"],
    ["¿Quién lo devuelve, y por qué?", "¿Quién lo devuelve?"],
    [
      "When the receipt is missing, who do you ask, and how?",
      "When the receipt is missing, who do you ask?",
    ],
    ["Where do you keep it, and what's in it?", "Where do you keep it?"],
    [
      "After you send it on, who gets it, and how does it reach them?",
      "After you send it on, who gets it?",
    ],
    [
      "Nu je verhaal: wat deed je als eerste, en wat zag je daar?",
      "Nu je verhaal: wat deed je als eerste?",
    ],
  ])(
    "keeps the first of two questions that were joined into one sentence: %j",
    (line, kept) => {
      expect(asStephenSays(line)).toBe(kept);
    }
  );

  it('leaves one question whole, also when it has "and" or a choice in it', () => {
    expect(asStephenSays("Is that per day or per week?")).toBe(
      "Is that per day or per week?"
    );
    expect(
      asStephenSays(
        "I wrote down 40 a week, and now you say 15. Which one is right?"
      )
    ).toBe("I wrote down 40 a week, and now you say 15. Which one is right?");
    expect(
      asStephenSays(
        "What is the difference between how you do it and how Lisa does it?"
      )
    ).toBe(
      "What is the difference between how you do it and how Lisa does it?"
    );
    expect(asStephenSays("Who checks the hours and the rate?")).toBe(
      "Who checks the hours and the rate?"
    );
    expect(
      asStephenSays("Wat doe je met de aanvraag, en met de offerte?")
    ).toBe("Wat doe je met de aanvraag, en met de offerte?");
  });

  it("leaves out praise and filler, in the languages he speaks", () => {
    expect(asStephenSays("Great answer! Who approves it?")).toBe(
      "Who approves it?"
    );
    expect(asStephenSays("I completely understand. What happens then?")).toBe(
      "What happens then?"
    );
    expect(asStephenSays("Goede vraag. Wie keurt het goed?")).toBe(
      "Wie keurt het goed?"
    );
  });

  it("leaves a line that is fine as it is", () => {
    expect(asStephenSays("Mm-hm. Then?")).toBe("Mm-hm. Then?");
    expect(
      asStephenSays(
        "Walk me through it, from the moment it came in. Every step, even the small ones. I'll just listen."
      )
    ).toBe(
      "Walk me through it, from the moment it came in. Every step, even the small ones. I'll just listen."
    );
  });

  it("names what a line got wrong by his own rules", () => {
    expect(mistakesIn("Who gets it next?")).toStrictEqual([]);
    expect(
      mistakesIn("What do you do and how long does it take? And who checks it?")
    ).toContain("two questions");
    expect(
      mistakesIn(
        "Could you perhaps tell me in a bit more detail how the matching of an invoice typically unfolds for you?"
      )
    ).toContain("long question");
    expect(mistakesIn("Great question. Who approves it?")).toContain(
      "praise or filler"
    );
  });
});

describe("a turn from the model", () => {
  it("is taken as it is when it is whole", () => {
    const turn = checkedTurn(
      {
        say: "Mm-hm. Then?",
        tone: "softly",
        phase: "story",
        facts: [
          {
            tag: "system",
            text: "The ticket lands in Zendesk.",
            record: "Tickets arrive in Zendesk.",
            quote: "it lands in Zendesk",
          },
        ],
        changes: [],
        wants: "answer",
        more: false,
        approved: false,
      },
      context
    );
    expect(turn.say).toBe("Mm-hm. Then?");
    expect(turn.tone).toBe("softly");
    expect(turn.facts).toStrictEqual([
      {
        tag: "system",
        text: "The ticket lands in Zendesk.",
        record: "Tickets arrive in Zendesk.",
        quote: "it lands in Zendesk",
      },
    ]);
  });

  it("has no tone he does not have, and stays in the part it was in when none is named", () => {
    const turn = checkedTurn(
      {
        say: "Go on.",
        tone: "excited",
        phase: "party",
        facts: [],
        changes: [],
        wants: "nonsense",
      },
      context
    );
    expect(turn.tone).toBeNull();
    expect(turn.phase).toBe("story");
    expect(turn.wants).toBe("answer");
  });

  it("writes down only what was really said: a fact whose words are not in the answer is left out", () => {
    const turn = checkedTurn(
      {
        say: "Then?",
        facts: [
          {
            tag: "step",
            text: "You approve the ticket.",
            record: "Approve the ticket.",
            quote: "I approve it",
          },
        ],
      },
      context
    );
    expect(turn.facts).toStrictEqual([]);
    const made = checkedTurn(
      {
        say: "Okay.",
        facts: [
          {
            tag: "number",
            text: "You handle 100 tickets every day.",
            record: "Handles 100 tickets a day.",
            quote: "",
          },
        ],
      },
      { ...context, answer: "No idea. It changes all the time." }
    );
    expect(made.facts).toStrictEqual([]);
  });

  it("takes the words of a fact as said but for capitals, quote marks and spaces, and marks them only when they stand there letter for letter", () => {
    const turn = checkedTurn(
      {
        say: "Then?",
        facts: [
          {
            tag: "system",
            text: "The ticket lands in Zendesk.",
            record: "Tickets arrive in Zendesk.",
            quote: "It lands  in zendesk,",
          },
        ],
      },
      context
    );
    expect(turn.facts).toHaveLength(1);
    expect(turn.facts[0]?.quote).toBe("");
  });

  it("keeps the example someone shared without a word", () => {
    const turn = checkedTurn(
      {
        say: "Thanks.",
        facts: [
          {
            tag: "case",
            text: "You shared the workflow file.",
            record: "Shared a file.",
            quote: "",
          },
          { tag: "step", text: "You open it.", record: "Open it.", quote: "" },
        ],
      },
      { ...context, answer: "" }
    );
    expect(turn.facts.map((each) => each.tag)).toStrictEqual(["case"]);
  });

  it("keeps the start and the end of an answer that is too long, with a mark where the middle went", () => {
    const long = `First I open the ticket. ${"and then the same again ".repeat(190)}Correction: it is Outlook, not Gmail.`;
    const kept = answerOf(long);
    expect({
      tooLong: long.length > turnAnswerMax,
      fits: kept.length <= turnAnswerMax,
      start: kept.startsWith("First I open the ticket."),
      end: kept.endsWith("Correction: it is Outlook, not Gmail."),
      marked: kept.includes(leftOut.trim()),
      short: answerOf("  short  "),
    }).toStrictEqual({
      tooLong: true,
      fits: true,
      start: true,
      end: true,
      marked: true,
      short: "short",
    });
  });

  it("changes only facts that exist, and takes one out with an empty text", () => {
    const turn = checkedTurn(
      {
        say: "Got it.",
        changes: [
          { id: "f2", text: "", record: "" },
          { id: "f9", text: "x", record: "x" },
          { id: "f1", text: "You open it in Zendesk.", record: "" },
        ],
      },
      context
    );
    expect(turn.changes).toStrictEqual([
      { id: "f2", text: null, record: null },
      {
        id: "f1",
        text: "You open it in Zendesk.",
        record: "You open it in Zendesk.",
      },
    ]);
  });

  it("says nothing and writes nothing while they are mid-sentence", () => {
    const turn = checkedTurn(
      {
        say: "What then?",
        more: true,
        facts: [{ tag: "step", text: "x", record: "x", quote: "" }],
      },
      context
    );
    expect(turn).toMatchObject({ say: "", more: true, facts: [] });
  });

  it("survives anything that is not a turn", () => {
    expect(checkedTurn(null, context)).toMatchObject({
      say: "",
      facts: [],
      changes: [],
      wants: "answer",
      more: false,
      approved: false,
    });
  });
});

describe("his line, written in plain lines", () => {
  const whole =
    "TONE: softly\nSAY: That is clear. Who gets it after you?\nPART: steps\nWANTS: answer\nMORE: no\nAGREED: no\n";

  it("is not known until the line he says is finished", () => {
    for (const end of [
      0,
      8,
      whole.indexOf("SAY:") + 4,
      whole.indexOf("Who gets"),
      whole.indexOf("\nPART"),
    ]) {
      expect(earlyPlainLine(whole.slice(0, end))).toBeNull();
    }
  });

  it("is known the moment that line ends, before the rest is written", () => {
    expect(earlyPlainLine(whole.slice(0, whole.indexOf("PART")))).toStrictEqual(
      {
        say: "That is clear. Who gets it after you?",
        tone: "softly",
      }
    );
    expect(earlyPlainLine(whole)).toStrictEqual({
      say: "That is clear. Who gets it after you?",
      tone: "softly",
    });
  });

  it("has no tone when none is named, or one he does not have", () => {
    expect(earlyPlainLine("TONE: none\nSAY: Then?\n")).toStrictEqual({
      say: "Then?",
      tone: null,
    });
    expect(earlyPlainLine("TONE: excited\nSAY: Then?\n")).toStrictEqual({
      say: "Then?",
      tone: null,
    });
  });

  it("is put right by his own rules, as in any shape", () => {
    expect(
      earlyPlainLine(
        "TONE: none\nSAY: Great answer! Who approves it? And how long does that take?\n"
      )
    ).toStrictEqual({ say: "Who approves it?", tone: null });
  });

  it("is not said early when he says nothing", () => {
    expect(earlyPlainLine("TONE: none\nSAY:\nPART: steps\n")).toBeFalsy();
    expect(earlyPlainLine("TONE: none\nSAY: \n")).toBeFalsy();
  });

  it("gives its first sentence while the rest is still being written, so he can begin to say it", () => {
    expect(
      earlyOpening(whole.slice(0, whole.indexOf("That is clear.") + 15))
    ).toBeNull();
    expect(
      earlyOpening(whole.slice(0, whole.indexOf("Who gets") + 1))
    ).toStrictEqual({ say: "That is clear.", tone: "softly" });
    // Once the line is whole, it is the whole line that counts.
    expect(earlyOpening(whole.slice(0, whole.indexOf("PART")))).toBeNull();
    expect(earlyOpening("TONE: none\nSAY: Okay. Then I wo")).toStrictEqual({
      say: "Okay.",
      tone: null,
    });
  });

  it("gives no first sentence before it knows how he says it, nor one he may not say, nor his question", () => {
    expect(earlyOpening("TONE: non")).toBeNull();
    expect(earlyOpening("TONE: none\nSAY: Great answer! Who appr")).toBeNull();
    expect(
      earlyOpening("TONE: none\nSAY: Who approves it? And how lo")
    ).toBeNull();
    expect(earlyOpening("TONE: none\nSAY: Then the next one")).toBeNull();
  });

  it("says where the interview goes once the part and what he waits for are written, before the rest of the turn", () => {
    expect(earlyNext(whole.slice(0, whole.indexOf("WANTS")))).toBeNull();
    expect(earlyNext(whole.slice(0, whole.indexOf("MORE")))).toStrictEqual({
      phase: "steps",
      wants: "answer",
    });
    expect(
      earlyNext(
        "TONE: none\nSAY: Can you drop one here?\nPART: Result\nWANTS: File\n"
      )
    ).toStrictEqual({ phase: "result", wants: "file" });
    expect(
      earlyNext("TONE: none\nSAY: Okay.\nPART: somewhere\nWANTS: file\n")
    ).toStrictEqual({ phase: null, wants: "file" });
    expect(
      earlyNext("TONE: none\nSAY: Okay.\nPART: steps\nWANTS: dance\n")
    ).toBeNull();
  });

  it("reads as a turn once it is whole, with what he waits for and whether he waits or they agreed", () => {
    expect(checkedTurn(plainLine(whole), context)).toMatchObject({
      say: "That is clear. Who gets it after you?",
      tone: "softly",
      phase: "steps",
      wants: "answer",
      more: false,
      approved: false,
      facts: [],
    });
    expect(
      checkedTurn(
        plainLine(
          "TONE: none\nSAY:\nPART: Steps\nWANTS: answer\nMORE: yes\nAGREED: no"
        ),
        context
      )
    ).toMatchObject({ say: "", more: true, phase: "steps" });
    expect(
      checkedTurn(
        plainLine(
          "TONE: none\nSAY:\nPART: readback\nWANTS: readback\nMORE: no\nAGREED: Yes."
        ),
        context
      )
    ).toMatchObject({ say: "", approved: true, wants: "readback" });
  });

  it("survives lines that are missing, out of order or written a little differently", () => {
    expect(
      checkedTurn(plainLine("say: Then?\ntone: softly"), context)
    ).toMatchObject({
      say: "Then?",
      tone: "softly",
      phase: "story",
      wants: "answer",
      more: false,
      approved: false,
    });
    expect(checkedTurn(plainLine("nothing like it"), context)).toMatchObject({
      say: "",
      wants: "answer",
    });
    // With the notes of the model that writes down, it is a whole turn.
    const notes = {
      facts: [
        {
          tag: "system",
          text: "The ticket lands in Zendesk.",
          record: "Tickets arrive in Zendesk.",
          quote: "it lands in Zendesk",
        },
      ],
      changes: [],
    };
    expect(
      checkedTurn({ ...plainLine(whole), ...notes }, context).facts
    ).toStrictEqual(notes.facts);
  });
});

describe("a turn as it comes in", () => {
  const line = { line: { say: "Who gets it next?", tone: null } };
  const turn = {
    turn: {
      say: "Who gets it next?",
      tone: null,
      phase: "steps",
      facts: [],
      changes: [],
      wants: "answer",
      more: false,
      approved: false,
    },
  };

  it("is an event to every line that is whole", () => {
    expect(
      turnEvents(`${JSON.stringify(line)}\n${JSON.stringify(turn)}\n`)
    ).toStrictEqual({ events: [line, turn], rest: "" });
    const opening = { opening: { say: "Okay.", tone: null } };
    const next = { next: { phase: "steps", wants: "file" } };
    expect(
      turnEvents(
        `${JSON.stringify(opening)}\n${JSON.stringify(line)}\n${JSON.stringify(next)}\n`
      ).events
    ).toStrictEqual([opening, line, next]);
  });

  it("keeps the start of a line that is not whole yet for what comes in next", () => {
    const all = `${JSON.stringify(line)}\n${JSON.stringify(turn)}\n`;
    const first = turnEvents(all.slice(0, 20));
    expect(first.events).toStrictEqual([]);
    const second = turnEvents(first.rest + all.slice(20, 80));
    expect(second.events).toStrictEqual([line]);
    expect(turnEvents(second.rest + all.slice(80)).events).toStrictEqual([
      turn,
    ]);
  });

  it("says how it failed", () => {
    expect(
      turnEvents(
        '{"error":"Stephen is busy. Try again in a minute.","status":429}\n'
      ).events
    ).toStrictEqual([
      { error: "Stephen is busy. Try again in a minute.", status: 429 },
    ]);
  });

  it("leaves out what is no event", () => {
    expect(
      turnEvents(
        '\nnot json\n{"something":"else"}\n{"line":{"tone":"softly"}}\n42\nnull\n'
      ).events
    ).toStrictEqual([]);
  });
});

describe("a shared file, as it is spoken of", () => {
  it("is its name without the ending that says what kind of file it is", () => {
    expect(fileCalled("workflow.pdf")).toBe("workflow");
    expect(fileCalled("Order_flow-2026.xml")).toBe("Order flow 2026");
    expect(fileCalled(".pdf")).toBe(".pdf");
    expect(fileCalled("notes")).toBe("notes");
  });
});
