import type {
  InterviewFact,
  InterviewLine,
  Mark,
} from "../../../src/admin/interview-turn.ts";
import { PHASES } from "../../../src/admin/interviews.ts";
import type { Phase, Tag } from "../../../src/admin/interviews.ts";
import {
  peopleOf,
  saidBefore,
  unit,
} from "../../../src/admin/onboarding-admin.ts";
import type {
  Interview,
  Org,
  Telling,
  Work,
} from "../../../src/admin/onboarding-admin.ts";
import { present } from "../../../src/admin/present.ts";

/**
 * A sample interview as it was held: what Stephen asked, what the person answered, what he marked
 * in it and what he wrote down. Built from the piece of work and from what this person tells of it
 * (`tellingOf`), so the transcript, the facts and the evidence for the workflow always agree. An
 * interview that stopped ends at the question that was not answered. In English, as the sample is.
 */
export interface Talk {
  lines: InterviewLine[];
  facts: InterviewFact[];
}

const bare = (sentence: string) => sentence.replace(/[.!?]$/u, "");
const lower = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
const upper = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
/** An instruction as someone says it of themselves: "Open the ticket." becomes "I open the ticket". */
const mine = (instruction: string) => `I ${lower(bare(instruction))}`;
/** The same as it is read back to them: "You open the ticket". */
const yours = (instruction: string) => `You ${lower(bare(instruction))}`;
const COUNT = [
  "none",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
];
const a = (noun: string) =>
  /^[aeiou]/iu.test(noun) ? `an ${noun}` : `a ${noun}`;
const listed = (items: string[]) =>
  items.length < 2
    ? items.join("")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

const THEN = ["Then", "After that", "Next"];
const WHEN = [
  "This morning.",
  "Yesterday afternoon.",
  "Last Friday.",
  "About an hour ago.",
  "Tuesday, I think.",
];
const YES = ["Yes, that’s right.", "Yes, most days.", "That’s me."];

/** How often something goes differently, as the person says it. */
const oftenSaid = (outOfTen: number | null): string => {
  if (outOfTen === null) {
    return "I couldn’t say";
  }
  return outOfTen === 0 ? "Almost never" : `About ${COUNT[outOfTen]}`;
};

/** The same, as Stephen writes it down. */
const oftenNoted = (outOfTen: number | null): string => {
  if (outOfTen === null) {
    return "";
  }
  return outOfTen === 0 ? " Almost never." : ` About ${outOfTen} in 10.`;
};

interface Say {
  pick: (from: string[], what: string) => string;
  stephen: (phase: Phase, text: string) => void;
  they: (phase: Phase, text: string, marks?: Mark[], file?: string) => void;
  note: (id: string, tag: Tag, record: string, text?: string) => void;
}

// oxlint-disable-next-line complexity -- the prototype's sample interview, one part of it after another
const employee = (
  org: Org,
  interview: Interview,
  work: Work,
  telling: Telling,
  closes: string,
  { pick, stephen, they, note }: Say
) => {
  const { person } = interview;
  const [one, many] = work.item;
  const leader =
    peopleOf(org).find((each) => each.team === person.team && each.lead)
      ?.first ?? "Your team lead";
  const per = work.per ?? "week";
  const time = work.unit ?? "minutes";

  stephen(
    "open",
    `Hi ${person.first}, I’m Stephen, an AI that works for Grasp. ${org.name} asked me to learn how the work really runs. This takes about 12 minutes, and you can skip any question. Do you want to talk or type?`
  );
  they("open", interview.typed ? "I’d rather type." : "Talking is fine.");

  stephen(
    "anchor",
    `${leader} named you for ${lower(work.name)}. Is that right?`
  );
  they("anchor", pick(YES, "yes"));
  stephen("anchor", `Think of the last ${one} you handled. When was that?`);
  they("anchor", pick(WHEN, "when"));

  stephen("story", "Walk me through it, from the start until it was done.");
  const story: string[] = [];
  const marks: Mark[] = [];
  if (telling.start) {
    story.push(work.starts);
    marks.push({ quote: bare(work.starts), tag: "step" });
    note("start", "step", work.starts);
  }
  for (const [place, index] of telling.steps.entries()) {
    const other =
      telling.way?.other === true &&
      telling.way.step === index &&
      work.differs !== undefined;
    const instruction =
      other && work.differs ? work.differs.other : (work.steps[index] ?? "");
    const said = mine(instruction);
    story.push(
      place === 0 ? `${said}.` : `${THEN[place % THEN.length]} ${said}.`
    );
    marks.push({ quote: said, tag: "step" });
    note(
      other ? `step:${index}/other` : `step:${index}`,
      "step",
      instruction,
      `${yours(instruction)}.`
    );
  }
  if (telling.term && work.term) {
    const [word, meaning] = work.term;
    const said = `We say “${word}” for ${meaning}`;
    story.push(`${said}.`);
    marks.push({ quote: said, tag: "term" });
    note("term", "term", `“${upper(word)}” means ${meaning}.`);
  }
  they("story", story.join(" "), marks);

  if (work.waits && work.waits.length > 0) {
    stephen("steps", `Did the ${one} wait anywhere along the way?`);
    if (telling.waits.length > 0) {
      const waits = telling.waits.map((index) => work.waits?.[index] ?? "");
      they(
        "steps",
        `Yes. ${waits.join(" ")}`,
        waits.map((wait) => ({ quote: bare(wait), tag: "wait" as const }))
      );
      for (const index of telling.waits) {
        note(`wait:${index}`, "wait", work.waits?.[index] ?? "");
      }
    } else {
      they("steps", "Not really.");
    }
  }
  stephen("steps", `Who gets the ${one} after you?`);
  if (telling.next) {
    they("steps", `It goes to ${work.next}.`, [
      { quote: work.next, tag: "handoff" },
    ]);
    note("next", "handoff", `Next: ${work.next}.`);
  } else {
    they("steps", "I don’t know who picks it up after me.");
  }

  if (work.differently && work.differently.length > 0) {
    stephen("exceptions", "When does it not go like that?");
    if (telling.differently.length === 0) {
      they("exceptions", "It mostly goes like that.");
    }
    for (const [place, index] of telling.differently.entries()) {
      const [when, then, outOfTen] = work.differently?.[index] ?? ["", "", 0];
      const said = `If ${when}, ${mine(then)}`;
      const often = oftenSaid(outOfTen);
      if (place > 0) {
        stephen("exceptions", "What else can go differently?");
      }
      they("exceptions", `${said}.`, [{ quote: said, tag: "exception" }]);
      stephen(
        "exceptions",
        place === 0
          ? `Out of ten ${many}, how many?`
          : "And how many out of ten?"
      );
      they("exceptions", `${often}.`, [{ quote: often, tag: "number" }]);
      note(
        `differently:${index}`,
        "exception",
        `If ${when}, ${lower(bare(then))}.${oftenNoted(outOfTen)}`
      );
    }
  }
  if (present(work.decides) && telling.decides) {
    stephen("exceptions", "What do you look at to know it is okay?");
    they("exceptions", `${mine(work.decides)}.`, [
      { quote: mine(work.decides), tag: "judgment" },
    ]);
    note("decides", "judgment", work.decides);
  }
  if (present(work.own)) {
    stephen(
      "exceptions",
      "Do you keep your own list, sheet or notes for this?"
    );
    if (telling.own) {
      they("exceptions", `Yes. ${mine(work.own)}.`, [
        { quote: mine(work.own), tag: "workaround" },
      ]);
      note("own", "workaround", work.own);
    } else {
      they("exceptions", "No, nothing of my own.");
    }
  }
  if (present(work.ai)) {
    stephen("exceptions", "Do you use an AI tool for any part of this?");
    if (telling.ai) {
      they("exceptions", `Sometimes. ${mine(work.ai)}.`, [
        { quote: mine(work.ai), tag: "ai" },
      ]);
      note("ai", "ai", work.ai);
    } else {
      they("exceptions", "No, I don’t.");
    }
  }

  stephen("numbers", `How many ${many} in a quiet ${per}?`);
  if (telling.volume) {
    const [quiet, busy] = telling.volume;
    they("numbers", `About ${quiet}.`, [
      { quote: `About ${quiet}`, tag: "number" },
    ]);
    stephen("numbers", `And in a busy ${per}?`);
    they("numbers", `Around ${busy}.`, [
      { quote: `Around ${busy}`, tag: "number" },
    ]);
    note(
      "volume",
      "number",
      `A quiet ${per} has about ${quiet} ${many}, a busy ${per} about ${busy}.`
    );
  } else {
    they("numbers", "I never counted.");
  }
  stephen("numbers", `How long does a normal ${one} take you?`);
  if (telling.takes) {
    const [least, normal, most] = telling.takes;
    they(
      "numbers",
      `About ${normal} ${time}. The quickest takes ${least}, the longest ${most}.`,
      [{ quote: `About ${normal} ${time}`, tag: "number" }]
    );
    note(
      "takes",
      "number",
      `One ${one} takes ${least} to ${most} ${time}, as a rule about ${normal}.`
    );
  } else {
    they("numbers", "That differs too much to say.");
  }
  stephen("numbers", `Out of ten ${many}, how many arrive incomplete?`);
  if (telling.wrong === null) {
    they("numbers", "I couldn’t say.");
  } else {
    const said =
      telling.wrong === 0
        ? "Hardly any"
        : `${upper(COUNT[telling.wrong] ?? "")}, maybe`;
    they("numbers", `${said}.`, [{ quote: said, tag: "number" }]);
    note(
      "wrong",
      "number",
      `About ${telling.wrong} in 10 ${many} arrive incomplete or wrong.`
    );
  }

  stephen("result", `How do you know ${a(one)} is done right?`);
  if (telling.right) {
    they("result", work.right, [{ quote: bare(work.right), tag: "done" }]);
    note("right", "done", work.right);
  } else {
    they("result", "When nobody comes back with a question.");
  }
  if (present(work.ask)) {
    stephen("result", "When would you stop and ask someone?");
    if (telling.ask) {
      they("result", `${upper(work.ask)}.`, [
        { quote: upper(work.ask), tag: "stop" },
      ]);
      note("ask", "stop", `Stop and ask ${work.ask}.`);
    } else {
      they("result", "That hardly happens.");
    }
  }
  stephen("result", "Can you share one real example?");
  if (present(telling.example)) {
    they("result", "", [], telling.example);
    note("example", "case", `One real example was shared: ${telling.example}.`);
  } else {
    they("result", "Not right now.");
  }

  // He reads the steps back as they said them, one thing a sentence.
  const steps = telling.steps.map((index) =>
    telling.way?.other === true && telling.way.step === index && work.differs
      ? work.differs.other
      : (work.steps[index] ?? "")
  );
  stephen(
    "readback",
    `Let me read it back. ${steps.map((step) => `${yours(step)}.`).join(" ")} Is that correct?`
  );
  if (telling.out.length > 0) {
    they("readback", "Almost. One line is not right: take it out.");
    stephen("readback", "I took it out. Is the rest correct?");
    they("readback", "Yes.");
  } else {
    they("readback", "Yes, that’s correct.");
  }
  stephen(
    "readback",
    `Thank you, ${person.first}. That’s everything. What you told me goes to the transformation team at ${org.name}, together with what your colleagues told me. They see the combined picture, never your words. This link works until ${closes}.`
  );
};

/** A team lead's interview: not the detail but the map. The team's work, how much of it there is, and who knows each piece best. */
const lead = (
  org: Org,
  interview: Interview,
  { stephen, they, note }: Omit<Say, "pick">
) => {
  const { person } = interview;
  const team = org.teams.find((each) => each.id === person.team);
  const works = org.works.filter((work) => work.team === person.team);
  const roster = peopleOf(org);

  stephen(
    "open",
    `Hi ${person.first}, I’m Stephen, an AI that works for Grasp. ${org.name} asked me to learn how the work really runs, and I start with the team leads. This takes about 30 minutes. Do you want to talk or type?`
  );
  they("open", interview.typed ? "I’ll type." : "Let’s talk.");
  stephen("anchor", `Is ${team?.name ?? "this"} your team?`);
  they("anchor", `Yes. ${team?.people ?? 0} people, with me.`);

  stephen("story", "What recurring work does your team do?");
  they("story", `${upper(listed(works.map((work) => lower(work.name))))}.`);
  for (const work of works) {
    const per = work.per ?? "week";
    const [quiet, busy] = work.volume;
    stephen("steps", `What starts ${lower(work.name)}?`);
    they("steps", work.starts);
    stephen("numbers", `About how many per ${per}?`);
    const count =
      quiet === busy ? `About ${quiet}` : `Between ${quiet} and ${busy}`;
    they("numbers", `${count}.`, [{ quote: count, tag: "number" }]);
    note(
      `volume:${work.id}`,
      "number",
      `${work.name}: ${lower(count)} ${work.item[1]} per ${per}.`
    );
    const first = roster
      .filter((each) => each.work === work.id)
      .slice(0, 2)
      .map((each) => each.first);
    stephen("steps", `Who knows ${lower(work.name)} best?`);
    they("steps", `${listed(first)}.`, [{ quote: listed(first), tag: "next" }]);
    note(
      `next:${work.id}`,
      "next",
      `Ask ${listed(first)} about ${lower(work.name)} first.`
    );
  }
  // What the library expects and the lead did not name is asked once, plainly, after their own list.
  for (const dropped of org.dropped.filter(
    (each) => each.team === person.team
  )) {
    stephen("exceptions", `Does your team also do ${lower(dropped.name)}?`);
    they("exceptions", "No, that is not ours.");
  }
  const things =
    works.length === 1
      ? "one thing"
      : `${COUNT[works.length] ?? works.length} things`;
  stephen(
    "readback",
    `Let me read it back. Your team does ${things}: ${listed(works.map((work) => lower(work.name)))}. Is that correct?`
  );
  they("readback", "Yes, that’s correct.");
  stephen(
    "readback",
    `Thank you, ${person.first}. Everyone on your list gets a link of their own today.`
  );
};

/** The interview with `interview.person`; `closes` is the day the link closes, as it is said to them. */
export const talkOf = (
  org: Org,
  interview: Interview,
  closes: string
): Talk => {
  // A real interview is as it was said.
  if (org.real) {
    return (
      org.real.transcripts.get(interview.person.id) ?? { lines: [], facts: [] }
    );
  }
  const all: (InterviewLine & { phase: Phase })[] = [];
  const facts: InterviewFact[] = [];
  const { person, telling, work } = interview;
  const key = `${org.id}/${person.id}`;
  const pick = (from: string[], what: string) =>
    from[Math.floor(unit(`${key}/${what}`) * from.length)] ?? "";
  const stephen = (phase: Phase, text: string) => {
    all.push({ from: "stephen", text, phase });
  };
  const they = (
    phase: Phase,
    text: string,
    marks: Mark[] = [],
    file?: string
  ) => {
    all.push({
      from: "person",
      text,
      phase,
      ...(interview.typed ? { typed: true } : {}),
      ...(marks.length > 0 ? { marks } : {}),
      ...(present(file) ? { file } : {}),
    });
  };
  const note = (id: string, tag: Tag, record: string, text = record) => {
    if (!saidBefore(id, interview.stoppedAt)) {
      return;
    }
    // Taking a line out happens in the read-back: an interview that stopped never got there.
    facts.push({
      id,
      tag,
      text,
      record,
      ...(interview.approved && telling?.out.includes(id) === true
        ? { out: true }
        : {}),
      ...(interview.approved ? { agreed: true } : {}),
    });
  };

  if (work && telling) {
    employee(org, interview, work, telling, closes, {
      pick,
      stephen,
      they,
      note,
    });
  } else {
    lead(org, interview, { stephen, they, note });
  }

  // An interview that stopped ends at the question that was never answered.
  const stopped =
    interview.stoppedAt === null
      ? PHASES.length
      : PHASES.indexOf(interview.stoppedAt);
  const until = all.findIndex((line) => PHASES.indexOf(line.phase) >= stopped);
  const kept = until === -1 ? all : all.slice(0, until + 1);
  return { lines: kept.map(({ phase: _phase, ...line }) => line), facts };
};
