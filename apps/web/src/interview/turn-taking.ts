// Whose turn it is in the read-back, where Stephen reads back here and
// hears their answer with his own ears (prototype
// `data/interview-loop.ts`, `useLoop`, and `ended` and `hanging` in
// `data/ear.ts`); the conversation before it is the agent's, which takes
// its turns itself (live.ts). Stephen speaks, listens and thinks, and this
// decides when. Pure: it is told what happens, each with when it happened
// on the page's clock, and answers with what it is now and what to do
// (`Act`), so every rule is tested without a browser. loop.ts does what it
// says: it opens and closes the ear, takes what they said, and sets the
// waits it names.
//
// A breath ends a stretch of speech. Its words go to him at once where
// they end a sentence; a little later where they don't (`restMs`), and
// later still where they seem to break off (`patienceMs`). When a stretch
// couldn't be written down, he says so, and after a silence (`nudgeMs`)
// takes what he did hear. He listens while he speaks a line of his own
// too, as in any conversation: when they talk over him he stops at once
// and hears them out (`interrupted`). A sound that turns out to be no
// words has him say his line again; his own voice taken for theirs (the
// microphone heard the speaker) has him say it again and not listen while
// he speaks from then on. From the line in which he says he will read
// back until he asks whether it is right, he doesn't listen.

/** What Stephen is doing. */
export type Doing = "idle" | "speaking" | "listening" | "thinking";

/** A stretch of their speech, or a line they typed, since his last line. */
export interface Part {
  /** The ear's number for the stretch; none for a typed line. */
  stretch: number | null;
  words: string;
  typed: boolean;
  /** Its words are still on their way. */
  waiting: boolean;
}

/** Whose turn it is, and what they said since his last line. */
export interface Floor {
  doing: Doing;
  /** They chose to talk: he listens through the ear, not only the box. */
  voice: boolean;
  /** The ear is open: while he listens and thinks, and while he speaks a line they can talk over. */
  hearing: boolean;
  /** They can talk over him. Not once his own voice was taken for theirs. */
  interrupts: boolean;
  /** They talked over him, and what they said isn't written down yet. */
  cut: boolean;
  /** From his line that leads to the read-back until he asks whether it is right: he doesn't listen. */
  reading: boolean;
  /** They are talking right now. */
  talking: boolean;
  /** What they are saying right now, as far as it is written down yet. */
  live: string;
  parts: Part[];
  /** When they were last heard: the end of their last word. */
  lastHeard: number;
  /** What they said that went to him and isn't taken yet, by its number. */
  asking: number | null;
  /** How many times what they said went to him. */
  turns: number;
}

/** The waits the floor sets; loop.ts tells it when one is over. */
export type Wait = "settle" | "nudge" | "thinking";

/** What happens. `at` is when, on the page's clock (`performance.now()`). */
export type Happening =
  /** He begins a line. `readsBack`: he reads back, and doesn't listen until he asks whether it is right. */
  | { type: "speak"; at: number; readsBack?: boolean }
  /**
   * He is done saying his line and waits for theirs. `asked`: in the
   * read-back, he asked whether it is right. `nudge`: what they said before
   * is answered after a silence, if no more comes.
   */
  | { type: "listen"; at: number; asked?: boolean; nudge?: boolean }
  /** What they said is answered without a line of his: they agreed, or he goes on to the read-back. */
  | { type: "answered"; at: number }
  /** He thinks, not listening: what he wrote down is on its way before the read-back. */
  | { type: "wait"; at: number }
  /** They chose to talk, or to type. */
  | { type: "voice"; at: number; on: boolean }
  /** From the ear. */
  | { type: "stretch-start"; at: number; stretch: number }
  | { type: "partial"; at: number; stretch: number; text: string }
  | { type: "stretch-end"; at: number; stretch: number }
  | { type: "final"; at: number; stretch: number; text: string }
  | { type: "unheard"; at: number; stretch: number }
  /** What cut him off was his own voice, heard by the microphone. */
  | { type: "echo"; at: number; stretch: number }
  /** They sent what they typed. */
  | { type: "typed"; at: number; text: string }
  /** A wait is over. */
  | { type: "waited"; at: number; wait: Wait }
  /** The interview stops. */
  | { type: "stop"; at: number };

/** What to do. */
export type Act =
  /** Open the ear, or close it (what is being said is dropped). */
  | { type: "hear" }
  | { type: "deaf" }
  /** What they said goes to him: their answer to what he read back. */
  | { type: "ask"; turn: number; text: string; typed: boolean }
  /** Stop saying his line: they typed or talked over him. */
  | { type: "hush" }
  /** Say the line he was cut off in again: nothing was said after all. */
  | { type: "resume" }
  /** Set a wait, in place of one of the same name; or clear it. */
  | { type: "after"; wait: Wait; ms: number }
  | { type: "clear"; wait: Wait }
  /** They fell quiet: an answer is measured from here. */
  | { type: "quiet"; at: number }
  /** A stretch couldn't be written down at all: he says so. */
  | { type: "unheard" };

/**
 * How long a silence ends a stretch whose words come live, in ms: a breath.
 * Where they end a sentence they go to him at once; else he waits until
 * they were quiet `restMs`, or `patienceMs` where they seem to break off.
 */
export const breathMs = 350;
export const restMs = 1100;
export const patienceMs = 3400;
/** How long he waits for more once a stretch couldn't be written down, before he takes what he did hear. */
export const nudgeMs = 5000;
/**
 * How long he goes on looking as if he listens once their spoken answer
 * went to him: they may only be taking a breath, and when they go on,
 * nothing on screen has moved.
 */
export const looksThinkingMs = 600;
export const quietFloor: Floor = {
  doing: "idle",
  voice: false,
  hearing: false,
  interrupts: true,
  cut: false,
  reading: false,
  talking: false,
  live: "",
  parts: [],
  lastHeard: 0,
  asking: null,
  turns: 0,
};

/** Closing quotes and brackets after a sentence's end. */
const closers = String.raw`["'”’»)]*`;
const endsSentence = new RegExp(String.raw`[.?!]${closers}$`, "u");
const trailsOff = new RegExp(String.raw`(?:…|\.\.\.)${closers}$`, "u");
const breaksOff = /(?:,|…|\.\.\.|-|—)$/u;
const notWord = /[^\p{L}\p{N}\s’-]/gu;
const space = /\s+/u;
const straight = /'/gu;

/**
 * Words a sentence doesn't end on, in the languages Stephen speaks: after
 * one of these someone is most likely thinking of what comes next.
 */
const leadingOn = new Set(
  [
    "and or but so because um uh uhm er erm hmm well like the a an my our is are am i’m it’s we’re at to of for with in on about around roughly maybe called named that which we i then",
    "en of maar dus omdat eh ehm uhm nou de het een mijn onze is zijn ben bij naar van voor met in op over ongeveer misschien dat die we ik dan",
    "und oder aber also weil äh ähm der die das ein eine mein unser ist sind bin bei zu von für mit auf über ungefähr vielleicht dass wir ich dann",
    "et ou mais donc parce euh le la les un une mon notre est sont suis à de pour avec dans sur environ peut-être que qui nous je puis",
    "y o pero porque eh el la los un una mi nuestro es son soy a de para con en sobre unos quizá que nosotros yo luego entonces",
  ]
    .join(" ")
    .split(" ")
);

/**
 * Whether what was said ends where a sentence does, as it was written
 * down: on a full stop, a question mark or an exclamation mark, not on
 * three dots, which is how a sentence that breaks off is written. Its full
 * stop counts for more than its last word: "I think so." is finished.
 */
export const ended = (words: string): boolean => {
  const said = words.trim();
  return endsSentence.test(said) && !trailsOff.test(said);
};

/** Whether what was said stops where a sentence doesn't: on a comma, a dash or a word that leads on. */
export const hanging = (words: string): boolean => {
  const said = words.trim().replaceAll(straight, "’");
  if (breaksOff.test(said)) {
    return true;
  }
  const last = said
    .toLowerCase()
    .replaceAll(notWord, "")
    .trim()
    .split(space)
    .at(-1);
  return leadingOn.has(last ?? "");
};

/** How long a silence ends a stretch: a breath when its words come live, else the ear's own. */
export const pauseFor = (live: boolean, own: number): number =>
  live ? breathMs : own;

/**
 * How long after they fell quiet he answers what they said last: at once
 * when they typed it or it ends a sentence, after `restMs` else, and after
 * `patienceMs` where it breaks off.
 */
export const restFor = (last: Part): number => {
  if (last.typed || ended(last.words)) {
    return 0;
  }
  return hanging(last.words) ? patienceMs : restMs;
};

/** What a step of the floor comes to: the floor now, and what to do. */
export interface Step {
  floor: Floor;
  acts: Act[];
}

const said = (parts: Part[]): string =>
  parts
    .map(({ words }) => words)
    .filter((words) => words !== "")
    .join(" ");

/** He stops waiting for anything they might still say. */
const unwaited: Act[] = [
  { type: "clear", wait: "settle" },
  { type: "clear", wait: "nudge" },
  { type: "clear", wait: "thinking" },
];

/** Everything they said since his last line goes to him. */
const commit = (floor: Floor): Step => {
  const text = said(floor.parts);
  if (text === "") {
    return { floor, acts: [] };
  }
  const turn = floor.turns + 1;
  const typed = floor.parts.every((part) => part.typed);
  const ask: Act = { type: "ask", turn, text, typed };
  const asked = { ...floor, turns: turn, asking: turn, cut: false };
  // Spoken, he looks as if he listens a moment longer: they may only be taking a breath.
  if (!typed && floor.doing === "listening" && floor.hearing) {
    return {
      floor: asked,
      acts: [
        ...unwaited,
        ask,
        { type: "after", wait: "thinking", ms: looksThinkingMs },
      ],
    };
  }
  return { floor: { ...asked, doing: "thinking" }, acts: [...unwaited, ask] };
};

/** Whether to answer now: not while they talk or words are on their way, and later where they seem to break off. */
const settle = (floor: Floor, at: number): Step => {
  const last = floor.parts.at(-1);
  const waits =
    last === undefined ||
    floor.talking ||
    floor.asking !== null ||
    floor.parts.some((part) => part.waiting) ||
    (floor.doing !== "listening" && floor.doing !== "thinking");
  if (waits) {
    return { floor, acts: [] };
  }
  const wait = last.typed ? 0 : restFor(last) - (at - floor.lastHeard);
  if (wait > 0) {
    return { floor, acts: [{ type: "after", wait: "settle", ms: wait }] };
  }
  return commit(floor);
};

/**
 * He listens: through the ear when they chose to talk and he isn't reading
 * back. What they said before stays until it goes to him.
 */
const listening = (floor: Floor): Step => {
  const hears = floor.voice && !floor.reading;
  // The ear was open while he spoke: it starts afresh as he stops, so what
  // it gathered of his own voice in the microphone never begins a stretch
  // that would be taken for theirs.
  const afresh = floor.hearing && floor.doing === "speaking";
  const opens: Act[] = afresh
    ? [{ type: "deaf" }, { type: "hear" }]
    : [{ type: "hear" }];
  return {
    floor: { ...floor, doing: "listening", hearing: hears },
    acts: hears && (afresh || !floor.hearing) ? opens : [],
  };
};

/**
 * What is still on its way stands as far as it was written down: the ear
 * may not say more of it once closed. Its own words still take its place
 * if they come.
 */
const standing = (parts: Part[]): Part[] =>
  parts.flatMap((part) => {
    if (!part.waiting) {
      return [part];
    }
    return part.words === "" ? [] : [{ ...part, waiting: false }];
  });

/** The ear closes: what is being said is dropped, and nothing more is heard. */
const deafened = (floor: Floor): Step => ({
  floor: {
    ...floor,
    hearing: false,
    talking: false,
    live: "",
    parts: standing(floor.parts),
  },
  acts: floor.hearing ? [{ type: "deaf" }] : [],
});

/** They talk: what he was about to say waits until they stop again. */
const talks = (floor: Floor, at: number): Step => ({
  floor: {
    ...floor,
    talking: true,
    asking: null,
    lastHeard: at,
    doing: floor.doing === "thinking" ? "listening" : floor.doing,
  },
  acts: unwaited,
});

/** They talk over him: he stops at once, and hears them out. */
const interrupted = (floor: Floor, at: number): Step => {
  const talking = talks(floor, at);
  return {
    floor: { ...talking.floor, doing: "listening", cut: true },
    acts: [...talking.acts, { type: "hush" }],
  };
};

/**
 * A stretch came to nothing. When it cut him off, he says his line again;
 * when they said something before it that he still has to answer, that is
 * answered as if the stretch had not been.
 */
const resumed = (floor: Floor, at: number): Step =>
  floor.cut && floor.parts.length === 0 && !floor.talking
    ? { floor: { ...floor, cut: false }, acts: [{ type: "resume" }] }
    : settle(floor, at);

/** A stretch ended: it joins what he has to answer, its words to follow. */
const quieted = (floor: Floor, at: number, stretch: number): Step => ({
  floor: {
    ...floor,
    talking: false,
    live: "",
    lastHeard: at,
    parts: [
      ...floor.parts,
      { stretch, words: floor.live, typed: false, waiting: true },
    ],
  },
  acts: [{ type: "quiet", at }],
});

/** A stretch's words are in: they stand for it, or it goes when nothing was said. */
const wordsIn = (
  floor: Floor,
  at: number,
  stretch: number,
  text: string
): Step => {
  if (!floor.parts.some((part) => part.stretch === stretch)) {
    return { floor, acts: [] };
  }
  const words = text.trim();
  const parts = floor.parts.flatMap((part) => {
    if (part.stretch !== stretch) {
      return [part];
    }
    return words === "" ? [] : [{ ...part, words, waiting: false }];
  });
  // A sound and no words (a cough, a door) that cut him off: he goes on.
  return words === ""
    ? resumed({ ...floor, parts }, at)
    : settle({ ...floor, parts }, at);
};

/**
 * His own voice cut him off: it isn't theirs to answer, he says his line
 * again, and from now on he doesn't listen while he speaks.
 */
const echoed = (floor: Floor, at: number, stretch: number): Step => {
  if (!floor.parts.some((part) => part.stretch === stretch)) {
    return { floor, acts: [] };
  }
  return resumed(
    {
      ...floor,
      interrupts: false,
      parts: floor.parts.filter((part) => part.stretch !== stretch),
    },
    at
  );
};

/** A stretch couldn't be written down at all: he says so; what he did hear stays. */
const lost = (floor: Floor, stretch: number): Step => {
  if (!floor.parts.some((part) => part.stretch === stretch)) {
    return { floor, acts: [] };
  }
  return {
    floor: {
      ...floor,
      cut: false,
      parts: floor.parts.filter((part) => part.stretch !== stretch),
    },
    acts: [{ type: "unheard" }],
  };
};

/** They typed: it stops him at once, and goes to him with whatever they said before. */
const typedIn = (floor: Floor, text: string): Step => {
  const words = text.trim();
  if (words === "" || floor.doing === "idle") {
    return { floor, acts: [] };
  }
  const next: Floor = {
    ...floor,
    asking: null,
    doing: floor.doing === "speaking" ? "listening" : floor.doing,
    parts: [
      ...standing(floor.parts),
      { stretch: null, words, typed: true, waiting: false },
    ],
  };
  const step = commit(next);
  return { floor: step.floor, acts: [{ type: "hush" }, ...step.acts] };
};

/** A wait is over. */
const waitOver = (floor: Floor, at: number, wait: Wait): Step => {
  if (wait === "settle") {
    return settle(floor, at);
  }
  if (wait === "nudge") {
    const quiet =
      !floor.talking &&
      floor.asking === null &&
      floor.parts.every((part) => !part.waiting);
    return quiet ? commit(floor) : { floor, acts: [] };
  }
  // He has been looking as if he listens: now he thinks, unless they went on.
  const thinks = floor.asking !== null && !floor.talking;
  return {
    floor: thinks ? { ...floor, doing: "thinking" } : floor,
    acts: [],
  };
};

/**
 * He begins a line: what is being said counts for nothing. He listens
 * afresh while he says it, so they can talk over him, unless he reads
 * back or his own voice was taken for theirs before.
 */
const speaks = (floor: Floor, readsBack = false): Step => {
  const deaf = deafened(floor);
  const reading = floor.reading || readsBack;
  const open = floor.voice && floor.interrupts && !reading;
  return {
    floor: {
      ...deaf.floor,
      doing: "speaking",
      reading,
      hearing: open,
      cut: false,
    },
    acts: [
      ...unwaited,
      ...deaf.acts,
      ...(open ? [{ type: "hear" } as const] : []),
    ],
  };
};

/** He is done saying his line, and listens. */
const listensAgain = (
  floor: Floor,
  { asked, nudge }: Extract<Happening, { type: "listen" }>
): Step => {
  const reading = floor.reading && asked !== true;
  const listens = listening({ ...floor, reading });
  if (nudge !== true || listens.floor.parts.length === 0) {
    return listens;
  }
  return {
    floor: listens.floor,
    acts: [...listens.acts, { type: "after", wait: "nudge", ms: nudgeMs }],
  };
};

/** They chose to talk, or to type. */
const voiced = (floor: Floor, on: boolean): Step => {
  const next = { ...floor, voice: on };
  if (!on) {
    return deafened(next);
  }
  return next.doing === "listening"
    ? listening(next)
    : { floor: next, acts: [] };
};

/** What the ear says. */
type Heard = Extract<
  Happening,
  {
    type:
      | "stretch-start"
      | "partial"
      | "stretch-end"
      | "final"
      | "unheard"
      | "echo";
  }
>;

const fromEar = (floor: Floor, happening: Heard): Step => {
  switch (happening.type) {
    case "stretch-start": {
      if (!floor.hearing) {
        return { floor, acts: [] };
      }
      return floor.doing === "speaking"
        ? interrupted(floor, happening.at)
        : talks(floor, happening.at);
    }
    case "partial": {
      return floor.hearing
        ? { floor: { ...floor, live: happening.text }, acts: [] }
        : { floor, acts: [] };
    }
    case "stretch-end": {
      return floor.hearing
        ? quieted(floor, happening.at, happening.stretch)
        : { floor, acts: [] };
    }
    case "final": {
      return wordsIn(floor, happening.at, happening.stretch, happening.text);
    }
    case "unheard": {
      return lost(floor, happening.stretch);
    }
    case "echo": {
      return echoed(floor, happening.at, happening.stretch);
    }
    default: {
      return happening satisfies never;
    }
  }
};

/**
 * What happens to the floor, and what to do about it. Anything about a
 * stretch the ear wasn't open for changes nothing.
 */
export const step = (floor: Floor, happening: Happening): Step => {
  switch (happening.type) {
    case "speak": {
      return speaks(floor, happening.readsBack);
    }
    case "listen": {
      return listensAgain(floor, happening);
    }
    case "answered": {
      return { floor: { ...floor, parts: [], asking: null }, acts: [] };
    }
    case "wait": {
      const deaf = deafened(floor);
      return { floor: { ...deaf.floor, doing: "thinking" }, acts: deaf.acts };
    }
    case "voice": {
      return voiced(floor, happening.on);
    }
    case "typed": {
      return typedIn(floor, happening.text);
    }
    case "waited": {
      return waitOver(floor, happening.at, happening.wait);
    }
    case "stop": {
      const deaf = deafened(floor);
      return {
        floor: {
          ...quietFloor,
          turns: floor.turns,
          voice: floor.voice,
          interrupts: floor.interrupts,
        },
        acts: [...unwaited, ...deaf.acts],
      };
    }
    case "stretch-start":
    case "partial":
    case "stretch-end":
    case "final":
    case "unheard":
    case "echo": {
      return fromEar(floor, happening);
    }
    default: {
      return happening satisfies never;
    }
  }
};

/** What they said that he hasn't answered, as one line; empty when nothing. */
export const unanswered = (floor: Floor): string =>
  said([
    ...floor.parts,
    { stretch: null, words: floor.live, typed: false, waiting: false },
  ]);

const wordsOnly = /[^\p{L}\p{N}\s]/gu;

/** Words as they are compared: small letters, no punctuation, one space. */
const plainWords = (text: string): string[] =>
  text
    .toLowerCase()
    .replaceAll(wordsOnly, " ")
    .split(space)
    .filter((word) => word !== "");

/**
 * Whether what was heard over his line is that line itself: its words
 * stand in it in the same order, one after the other. Where the
 * microphone hears the speaker, his own voice comes back as theirs, and
 * it must never be answered. He is cut off within a word or two of it, so
 * one word is enough: a "yes" of theirs that is also a word of his line
 * is taken for his, and he says his line again.
 */
export const echoes = (heard: string, line: string): boolean => {
  const words = plainWords(heard);
  return (
    words.length > 0 &&
    ` ${plainWords(line).join(" ")} `.includes(` ${words.join(" ")} `)
  );
};
