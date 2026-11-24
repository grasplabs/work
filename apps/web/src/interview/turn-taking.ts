// Whose turn it is (prototype `data/interview-loop.ts`, `useLoop`, and
// `ended` and `hanging` in `data/ear.ts`): Stephen speaks, listens and
// thinks, and this decides when. Pure: it is told what happens, each with
// when it happened on the page's clock, and answers with what it is now
// and what to do (`Act`), so every rule is tested without a browser.
// loop.ts does what it says: it opens and closes the ear, asks core for
// a turn, gives one up, and sets the waits it names.
//
// A breath ends a stretch of speech. Its words go to him at once where
// they end a sentence; a little later where they don't (`restMs`), and
// later still where they seem to break off (`patienceMs`). He keeps
// listening while he thinks: when they talk on, the answer on its way is
// dropped and he waits for the rest. When the model says they stopped in
// the middle of a sentence, he waits for the rest, and after a silence
// (`nudgeMs`) he answers with what there is. From the line in which he
// says he will read back until he asks whether it is right, he doesn't
// listen.

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
  /** The ear is open. Never while he speaks. */
  hearing: boolean;
  /** From his line that leads to the read-back until he asks whether it is right: he doesn't listen. */
  reading: boolean;
  /** They are talking right now. */
  talking: boolean;
  /** What they are saying right now, as far as it is written down yet. */
  live: string;
  parts: Part[];
  /** When they were last heard: the end of their last word. */
  lastHeard: number;
  /** The turn asked for that he hasn't begun to say yet. */
  asking: number | null;
  /** How many turns were asked for. */
  turns: number;
}

/** The waits the floor sets; loop.ts tells it when one is over. */
export type Wait = "settle" | "nudge" | "thinking";

/** What happens. `at` is when, on the page's clock (`performance.now()`). */
export type Happening =
  /** He begins a line. `answers`: it answers what they said, which is then his. `readsBack`: it leads to the read-back. */
  | { type: "speak"; at: number; answers?: boolean; readsBack?: boolean }
  /** His line leads to the read-back, known while he says it. */
  | { type: "reads-back"; at: number }
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
  /** They sent what they typed. */
  | { type: "typed"; at: number; text: string }
  /** A wait is over. */
  | { type: "waited"; at: number; wait: Wait }
  /** The turn asked for came back: they stopped mid-sentence, so he waits for the rest. */
  | { type: "more"; at: number; turn: number }
  /** The turn asked for couldn't be had: what they said is kept. */
  | { type: "failed"; at: number; turn: number }
  /** A turn that couldn't be had is asked for again, with what they said since. */
  | { type: "retry"; at: number }
  /** The interview stops. */
  | { type: "stop"; at: number };

/** What to do. */
export type Act =
  /** Open the ear, or close it (what is being said is dropped). */
  | { type: "hear" }
  | { type: "deaf" }
  /** Ask core for a turn with what they said; `nudge` when they stayed quiet after breaking off. */
  | { type: "ask"; turn: number; text: string; typed: boolean; nudge: boolean }
  /** The turn on its way counts for nothing any more: they talked on. */
  | { type: "drop"; turn: number }
  /** Stop saying his line: they typed over him. */
  | { type: "hush" }
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
 * His answer takes a while anyway, he listens all that time, and drops it
 * when they talk on: nobody waits longer than it takes, nobody is cut off.
 */
export const breathMs = 350;
export const restMs = 1100;
export const patienceMs = 3400;
/** How long he waits for the rest of a sentence the model was sure had more to come. */
export const nudgeMs = 5000;
/**
 * How long he goes on looking as if he listens once their spoken answer
 * went to him: they may only be taking a breath, and when they go on,
 * nothing on screen has moved.
 */
export const looksThinkingMs = 600;
/**
 * When his line is ready the moment they make a sound, they may be
 * starting to talk again: he holds his line while the sound is this fresh,
 * and this long at most, so a sound in the room doesn't keep him quiet.
 */
export const stirringMs = 250;
export const holdMs = 400;
/** How often a held line looks again whether they are still. */
export const stillTickMs = 50;

export const quietFloor: Floor = {
  doing: "idle",
  voice: false,
  hearing: false,
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

/**
 * Whether his line can begin now (0), or how long until it is looked at
 * again: not while a sound they made is so fresh they may be starting to
 * talk, unless it was held `holdMs` already.
 */
export const stillIn = ({
  now,
  since,
  lastHeard,
  hearing,
}: {
  now: number;
  since: number;
  lastHeard: number;
  hearing: boolean;
}): number => {
  const fresh = hearing && now - lastHeard < stirringMs;
  return !fresh || now - since >= holdMs ? 0 : stillTickMs;
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
const commit = (floor: Floor, nudge: boolean): Step => {
  const text = said(floor.parts);
  if (text === "") {
    return { floor, acts: [] };
  }
  const turn = floor.turns + 1;
  const typed = floor.parts.every((part) => part.typed);
  const ask: Act = { type: "ask", turn, text, typed, nudge };
  const asked = { ...floor, turns: turn, asking: turn };
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
  return commit(floor, false);
};

/**
 * He listens: through the ear when they chose to talk and he isn't reading
 * back. What they said before stays until it is asked with again (a turn
 * that failed is asked for again by loop.ts, or when they say more).
 */
const listening = (floor: Floor): Step => {
  const hears = floor.voice && !floor.reading;
  return {
    floor: { ...floor, doing: "listening", hearing: hears },
    acts: hears && !floor.hearing ? [{ type: "hear" }] : [],
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
const talks = (floor: Floor, at: number): Step => {
  const dropped: Act[] =
    floor.asking === null ? [] : [{ type: "drop", turn: floor.asking }];
  return {
    floor: {
      ...floor,
      talking: true,
      asking: null,
      lastHeard: at,
      doing: floor.doing === "thinking" ? "listening" : floor.doing,
    },
    acts: [...unwaited, ...dropped],
  };
};

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
  return settle({ ...floor, parts }, at);
};

/** A stretch couldn't be written down at all: he says so; what he did hear stays. */
const lost = (floor: Floor, stretch: number): Step => {
  if (!floor.parts.some((part) => part.stretch === stretch)) {
    return { floor, acts: [] };
  }
  return {
    floor: {
      ...floor,
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
  const dropped: Act[] =
    floor.asking === null ? [] : [{ type: "drop", turn: floor.asking }];
  const next: Floor = {
    ...floor,
    asking: null,
    doing: floor.doing === "speaking" ? "listening" : floor.doing,
    parts: [
      ...standing(floor.parts),
      { stretch: null, words, typed: true, waiting: false },
    ],
  };
  const step = commit(next, false);
  return {
    floor: step.floor,
    acts: [{ type: "hush" }, ...dropped, ...step.acts],
  };
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
    return quiet ? commit(floor, true) : { floor, acts: [] };
  }
  // He has been looking as if he listens: now he thinks, unless they went on.
  const thinks = floor.asking !== null && !floor.talking;
  return {
    floor: thinks ? { ...floor, doing: "thinking" } : floor,
    acts: [],
  };
};

/** He begins a line: the ear closes; what he answers is his now. */
const speaks = (
  floor: Floor,
  {
    answers = false,
    readsBack = false,
  }: { answers?: boolean; readsBack?: boolean }
): Step => {
  const deaf = deafened(floor);
  return {
    floor: {
      ...deaf.floor,
      doing: "speaking",
      reading: floor.reading || readsBack,
      asking: answers ? null : floor.asking,
      parts: answers ? [] : deaf.floor.parts,
    },
    acts: [...unwaited, ...deaf.acts],
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
  { type: "stretch-start" | "partial" | "stretch-end" | "final" | "unheard" }
>;

const fromEar = (floor: Floor, happening: Heard): Step => {
  switch (happening.type) {
    case "stretch-start": {
      return floor.hearing ? talks(floor, happening.at) : { floor, acts: [] };
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
    default: {
      return happening satisfies never;
    }
  }
};

/** What comes back of a turn asked for. */
type Answered = Extract<Happening, { type: "more" | "failed" | "retry" }>;

const fromTurn = (floor: Floor, happening: Answered): Step => {
  switch (happening.type) {
    case "more": {
      if (floor.asking !== happening.turn) {
        return { floor, acts: [] };
      }
      const waits = listening({ ...floor, asking: null });
      return {
        floor: waits.floor,
        acts: [...waits.acts, { type: "after", wait: "nudge", ms: nudgeMs }],
      };
    }
    case "failed": {
      return floor.asking === happening.turn
        ? { floor: { ...floor, asking: null }, acts: [] }
        : { floor, acts: [] };
    }
    case "retry": {
      return floor.asking === null && !floor.talking
        ? commit(floor, false)
        : { floor, acts: [] };
    }
    default: {
      return happening satisfies never;
    }
  }
};

/**
 * What happens to the floor, and what to do about it. Anything about a
 * turn that is no longer the one asked for, or a stretch the ear wasn't
 * open for, changes nothing.
 */
export const step = (floor: Floor, happening: Happening): Step => {
  switch (happening.type) {
    case "speak": {
      return speaks(floor, happening);
    }
    case "reads-back": {
      const deaf = deafened(floor);
      return { floor: { ...deaf.floor, reading: true }, acts: deaf.acts };
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
        floor: { ...quietFloor, turns: floor.turns, voice: floor.voice },
        acts: [...unwaited, ...deaf.acts],
      };
    }
    case "more":
    case "failed":
    case "retry": {
      return fromTurn(floor, happening);
    }
    case "stretch-start":
    case "partial":
    case "stretch-end":
    case "final":
    case "unheard": {
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

/**
 * A turn that fails on the way is asked for again by itself, after each of
 * these waits, in ms: `reach` asks three times in all, and nobody notices
 * unless all three fail.
 */
export const retryWaits = [800, 2000];
/** Once he said it doesn't work, he asks again by himself after each of these; then he says they can come back later. */
export const laterWaits = [5000, 10_000, 20_000, 30_000];

/** A hiccup on the way is worth asking again; a refusal, a budget used up or a voice that isn't set up is not. */
export const hiccup = (status: number): boolean =>
  (status === 0 || status >= 500) && status !== 503;

/** Which of his own lines says that something fails. */
export type TroubleLine = "offline" | "trouble" | "stillTrouble";

/**
 * What he does when a turn couldn't be had however often it was asked
 * for, the `tried`th time in a row: the first time he says so, as his own
 * line, their connection when nothing came back or the browser is
 * offline, else our side; once all his own tries are spent, that it still
 * doesn't work. In between he says nothing. `again`: when he asks by
 * himself next, none once he stopped trying by himself.
 */
export const troubleOf = ({
  tried,
  status,
  online,
}: {
  tried: number;
  status: number;
  online: boolean;
}): { say: TroubleLine | null; again: number | null } => {
  const again = laterWaits[tried] ?? null;
  if (tried === 0) {
    return { say: status === 0 || !online ? "offline" : "trouble", again };
  }
  return { say: tried === laterWaits.length ? "stillTrouble" : null, again };
};
