import type {
  InterviewFact,
  InterviewLine,
} from "@grasp-os/shared/interview-links";
import { readBackParts, storyKey } from "@grasp-os/shared/interview-story";
import type {
  ReadBackPart,
  StorySentence,
} from "@grasp-os/shared/interview-story";
import type {
  EarlyLine,
  EarlyNext,
  FactTag,
  InterviewEvent,
  InterviewTurnRequest,
  StephenTurn,
  VoiceTag,
} from "@grasp-os/shared/interview-turn";
import { useSyncExternalStore } from "react";

import { readingSeconds } from "../onboarding/setup.ts";
import { askStory, askTurn, turnFailed } from "./api.ts";
import type { EarlyEvent, TurnFailed } from "./api.ts";
import type { DotSign } from "./dot-signs.ts";
import { keepNow, linkNow, progressNow, update } from "./kept.ts";
import {
  afterTurn,
  approved,
  isReading,
  openingEvent,
  partConfirmed,
  steered,
  withFactText,
  withLine,
} from "./progress.ts";
import type { LoopWords } from "./words.ts";

// The interview as it runs, by typing: Stephen says his line, which lights
// up at the pace he would say it; they type; he thinks; turn after turn.
// His lines come from core (`/api/interview/turn`), his line first, the
// moment it is written, so it shows while what he wrote down is still on
// its way. Last he reads back what he wrote down, a part at a time, told
// as a short story (`/api/interview/story`), and they agree to it, put a
// line right or take one out. What was said is kept with the interview
// (kept.ts); this is only the moment. Ported from the prototype
// (grasplabs/prototype, packages/grasp: src/data/interview-loop.ts),
// without the voice: typing only.
//
// When core can't be reached, a turn is asked for again by itself, twice.
// Only when that doesn't help does anyone notice: Stephen says so himself,
// as his own line, and whether it is their connection or our side. What
// they typed is kept, and he goes on trying: after a while, at once when
// the connection is back, and with whatever they type next.

/** What Stephen is doing, and what is on screen with it. */
export interface LoopState {
  /** Nothing yet, saying his line, waiting for their answer, or thinking about it. */
  doing: "idle" | "speaking" | "listening" | "thinking";
  /** His line on screen. In the read-back, what the part is. */
  line: string;
  /** Which saying of a line this is: a new one lights up from `from` on. */
  saying: number;
  /** How much of the line was said before, and stands lit at once. */
  from: number;
  /** In the read-back, while he tells a part: the lines he tells now, and those he told. */
  telling: { now: string[]; told: string[] } | null;
  /** What they said since his last line, for the bubble over the box. */
  said: Said | null;
  /** The sign beside him: what he is doing, or the little he feels. */
  sign: DotSign | null;
}

/** What they said, with what Stephen marked in it, and whether it is still on its way. */
export interface Said {
  text: string;
  marks: { quote: string; tag: FactTag }[];
  waiting: boolean;
}

/** How long what he marked stays over the box, and how long the pen shows beside him. */
const notedMs = 2600;
const penMs = 1400;
/** How long nothing may come in of a turn before that try is given up. */
const quietMs = 20_000;
/** A hiccup is asked again by itself after these waits: three tries in all. */
const waits = [800, 2000];
/** Once he said it doesn't work, he tries again after each of these; then he says they can come back later. */
const later = [5000, 10_000, 20_000, 30_000];
/** How long he waits for the rest of a sentence they stopped in the middle of. */
const nudgeMs = 5000;
/** How long a story is waited for once he said which part it is. */
const storyWaitMs = 2500;
/** How long their yes to a part stays before the next part. */
const agreedMs = 900;
/** The shortest a line takes on screen, however short. */
const leastMs = 700;

/** The little he feels, by how he says a line. */
const feelings: Partial<Record<VoiceTag, DotSign>> = {
  "warm, relaxed": "smile",
  "interested, a little lighter": "aha",
  "amused, soft chuckle": "smile",
  warm: "smile",
  "warm, grateful": "heart",
};

const idle: LoopState = {
  doing: "idle",
  line: "",
  saying: 0,
  from: 0,
  telling: null,
  said: null,
  sign: null,
};

let state: LoopState = idle;
const listeners = new Set<() => void>();

const set = (next: Partial<LoopState>): void => {
  state = { ...state, ...next };
  for (const listener of listeners) {
    listener();
  }
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The conversation, as the page shows it. */
export const useLoop = (): LoopState =>
  useSyncExternalStore(subscribe, () => state);

let words: LoopWords | null = null;
/** Whether the conversation is on screen: nothing that comes back late does anything once it is not. */
let on = false;
/** What they typed that he has not answered yet. */
let carry: string[] = [];
/** The turn on its way: how to give it up, and whether his line from it is out. */
interface Pending {
  giving: AbortController;
  spoke: boolean;
  /** His line leads to the read-back or the end. */
  leads: EarlyNext | null;
  /** His line is said, and he waits, not listening, for what he wrote down. */
  waits: boolean;
}
let pending: Pending | null = null;
/** How many turns were asked for: a later one decides what happens next. */
let turns = 0;
/** Which of his lines is being said: a later one makes an earlier one's end count for nothing. */
let speaking = 0;
let sayingCount = 0;
let speakTimer = 0;
let nudging = 0;
let noting = 0;
/** How he says the line on screen, and whether it asked something. */
let tone: VoiceTag | null = null;
let asked = false;
/** How many turns in a row could not be had; the turn still owed; when he asks for it again. */
let troubled = 0;
let owed: (() => void) | null = null;
let again = 0;

const pause = async (ms: number): Promise<void> => {
  // oxlint-disable-next-line promise/avoid-new -- setTimeout has no promise form in browsers
  await new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
};

/** How long a line stands before he goes on: the time it takes to say it. */
export const sayingMs = (line: string): number =>
  Math.max(leastMs, readingSeconds(line) * 1000);

/** The sign for what he does now. */
const signFor = (doing: LoopState["doing"]): DotSign | null => {
  if (doing === "thinking") {
    return "thinking";
  }
  if (doing === "speaking") {
    return (tone === null ? undefined : feelings[tone]) ?? null;
  }
  if (doing === "listening") {
    return carry.length === 0 && asked ? "question" : null;
  }
  return null;
};

/** What he does now, with its sign unless one is given. */
const show = (
  doing: LoopState["doing"],
  more: Partial<LoopState> = {}
): void => {
  state = { ...state, doing, telling: null, ...more };
  set({ sign: more.sign === undefined ? signFor(doing) : more.sign });
};

const rest = (): void => {
  window.clearTimeout(speakTimer);
  window.clearTimeout(nudging);
};

/** The turn on its way counts for nothing any more, nor one still owed. */
const drop = (): void => {
  pending?.giving.abort();
  pending = null;
  owed = null;
  window.clearTimeout(again);
};

/** What they typed since his last line, for the bubble. */
const bubble = (): void => {
  window.clearTimeout(noting);
  set({
    said:
      carry.length === 0
        ? null
        : { text: carry.join(" "), marks: [], waiting: true },
    sign: signFor(state.doing),
  });
};

/** What they said stays over the box a little longer, with what he marked, then goes. */
const fade = (): void => {
  window.clearTimeout(noting);
  noting = window.setTimeout(() => {
    if (carry.length === 0) {
      set({ said: null });
    }
  }, notedMs);
};

/** A pen beside him for a moment: he wrote something down. */
const wroteDown = (): void => {
  set({ sign: "pen" });
  window.setTimeout(() => {
    if (on && state.sign === "pen") {
      set({ sign: signFor(state.doing) });
    }
  }, penMs);
};

/** He waits for their answer, in the box at the bottom. */
const listen = (): void => {
  show("listening");
};

/**
 * Stephen says a line: it lights up on screen at the pace he would say
 * it; then `after`, unless something else happened meanwhile.
 */
const speak = (
  line: string,
  how: VoiceTag | null,
  { noted = false, after }: { noted?: boolean; after: () => void }
): void => {
  speaking += 1;
  const mine = speaking;
  rest();
  tone = how;
  asked = line.trim().endsWith("?");
  sayingCount += 1;
  show("speaking", {
    line,
    saying: sayingCount,
    from: 0,
    ...(noted ? { sign: "pen" as const } : {}),
  });
  if (noted) {
    window.setTimeout(() => {
      if (state.doing === "speaking" && speaking === mine) {
        set({ sign: signFor("speaking") });
      }
    }, penMs);
  }
  speakTimer = window.setTimeout(() => {
    if (speaking === mine && on) {
      after();
    }
  }, sayingMs(line));
};

/** Says a line and waits until it is said; false when something else happened meanwhile. */
const sayThrough = async (
  line: string,
  mine: number,
  from = 0
): Promise<boolean> => {
  sayingCount += 1;
  set({ line, saying: sayingCount, from });
  await pause(sayingMs(line.slice(from)));
  return speaking === mine && on;
};

/** A hiccup is worth asking again; a refusal or a budget used up is not. */
const hiccup = (answer: StephenTurn | TurnFailed): boolean =>
  turnFailed(answer) &&
  (answer.status === 0 || answer.status >= 500) &&
  answer.status !== 503;

/** One try at a turn, given up when nothing comes in for a while. */
const attempt = async (
  request: InterviewTurnRequest,
  giving: AbortController,
  onEvent: (event: EarlyEvent) => void
): Promise<StephenTurn | TurnFailed> => {
  const trying = new AbortController();
  const stop = (): void => {
    trying.abort();
  };
  let slow = false;
  let quiet = 0;
  const alive = (): void => {
    window.clearTimeout(quiet);
    quiet = window.setTimeout(() => {
      slow = true;
      stop();
    }, quietMs);
  };
  giving.signal.addEventListener("abort", stop, { once: true });
  alive();
  try {
    return await askTurn(request, trying.signal, onEvent, alive);
  } catch {
    return { failed: true, status: slow ? 504 : 0 };
  } finally {
    window.clearTimeout(quiet);
    giving.signal.removeEventListener("abort", stop);
  }
};

/** A turn, asked again by itself after a hiccup: three times in all. */
const reach = async (
  request: InterviewTurnRequest,
  giving: AbortController,
  onEvent: (event: EarlyEvent) => void
): Promise<StephenTurn | TurnFailed> => {
  let answer = await attempt(request, giving, onEvent);
  for (const wait of waits) {
    if (!hiccup(answer) || giving.signal.aborted) {
      return answer;
    }
    // oxlint-disable-next-line no-await-in-loop -- backing off between tries
    await pause(wait);
    if (giving.signal.aborted) {
      return answer;
    }
    // oxlint-disable-next-line no-await-in-loop -- one try at a time
    answer = await attempt(request, giving, onEvent);
  }
  return answer;
};

/** The turn still owed is asked for again: after a while, or the moment the connection is back. */
const tryAgain = (): void => {
  if (!on || owed === null) {
    return;
  }
  const retry = owed;
  owed = null;
  retry();
};

/**
 * A turn could not be had, however often it was asked for. The first time
 * he says so himself, as his own line: their connection when nothing came
 * back, our side when core or the model said no or took too long. What they
 * typed is kept. Then he waits for them, and asks again by himself, longer
 * apart each time, and at once when the connection is back; whatever they
 * type asks again too. When none of that helped, he says they can come back.
 */
const trouble = (status: number, retry: () => void): void => {
  if (words === null) {
    return;
  }
  const tried = troubled;
  troubled += 1;
  const wait = (): void => {
    listen();
    owed = retry;
    window.clearTimeout(again);
    const after = later[tried];
    if (after !== undefined) {
      again = window.setTimeout(tryAgain, after);
    }
  };
  const theirs = status === 0 || !navigator.onLine;
  if (tried === 0) {
    speak(theirs ? words.offline : words.trouble, "upbeat, reassuring", {
      after: wait,
    });
    return;
  }
  if (tried === later.length) {
    speak(words.stillTrouble, "upbeat, reassuring", { after: wait });
    return;
  }
  wait();
};

/** What core is told: what was said and written down, and what just happened. */
const requestOf = (
  told: LoopWords,
  event: InterviewEvent,
  lines: InterviewLine[],
  reading?: string[]
): InterviewTurnRequest | null => {
  const link = linkNow();
  if (link === null) {
    return null;
  }
  const now = progressNow();
  return {
    ...link,
    event,
    locale: told.locale,
    interviewer: now.interviewer ?? "stephen",
    lines: lines.map(({ from, text, typed, file }) => ({
      from,
      text,
      ...(typed === true ? { typed } : {}),
      ...(file === undefined ? {} : { file }),
    })),
    facts: now.facts
      .filter(({ out }) => out !== true)
      .map(({ id, tag, text }) => ({ id, tag, text })),
    phase: now.phase,
    minutes:
      now.startedAt === null
        ? 0
        : Math.min(240, Math.max(0, (Date.now() - now.startedAt) / 60_000)),
    ...(reading === undefined ? {} : { reading }),
    adding: now.adding,
  };
};

/** The lines of the part on screen, by id, as core is told what was read back. */
const readingIds = (facts: InterviewFact[], part: number): string[] =>
  (readBackParts(facts)[part]?.facts ?? []).map(({ id }) => id).slice(0, 12);

/** In the read-back it stays the read-back, whatever the model makes of it. */
const staysIn = (turn: StephenTurn): StephenTurn["wants"] =>
  turn.wants === "file" ? "file" : "readback";

/** What they said, as the bubble shows it with what he marked. */
const theirs = (
  said: InterviewLine | undefined,
  turn?: StephenTurn
): Said | null =>
  said === undefined || said.text === ""
    ? null
    : {
        text: said.text,
        marks: (turn?.facts ?? [])
          .filter(({ quote }) => quote !== "")
          .map(({ quote, tag }) => ({ quote, tag })),
        waiting: false,
      };

/** What they typed since his last line, as one line of theirs; none when nothing. */
const saidNow = (): InterviewLine | undefined => {
  const text = carry.join(" ").trim();
  return text === "" ? undefined : { from: "person", text, typed: true };
};

/** The stories asked for, by the lines they are of: each is asked for once. */
const stories = new Map<string, Promise<StorySentence[] | null>>();

/** A part of the read-back as he tells it; none for a part of one line, which is said as it stands. */
const storyFor = async (
  part: ReadBackPart
): Promise<StorySentence[] | null> => {
  const lines = part.facts
    .filter(({ out }) => out !== true)
    .map(({ id, text }) => ({ id, text }));
  const link = linkNow();
  if (words === null || link === null || lines.length < 2) {
    return null;
  }
  const interviewer = progressNow().interviewer ?? "stephen";
  const key = [words.locale, interviewer, storyKey(lines)].join("\u0002");
  const known = stories.get(key);
  if (known !== undefined) {
    return await known;
  }
  const telling = askStory({
    ...link,
    locale: words.locale,
    interviewer,
    lines,
  });
  stories.set(key, telling);
  const story = await telling;
  // One that could not be had is asked for again the next time.
  if (story === null) {
    stories.delete(key);
  }
  return story;
};

/** The story of the part they are at, asked for ahead of time. */
const foretell = (): void => {
  const now = progressNow();
  const part = readBackParts(now.facts)[now.confirmed];
  if (part !== undefined) {
    void storyFor(part);
  }
};

/** What is asked for, if it is there within `ms`; else nothing. */
const within = async <T>(
  coming: Promise<T | null>,
  ms: number
): Promise<T | null> =>
  await Promise.race([
    coming,
    (async () => {
      await pause(ms);
      return null;
    })(),
  ]);

/** They agreed to the last part: what they left in counts from now. */
const finish = (): void => {
  rest();
  show("idle", { line: "", said: null, sign: null });
  update(approved);
  keepNow();
};

/** He tells the lines of a part, each lighting up as he gets to it; false when something else happened meanwhile. */
const tell = async (
  sentences: StorySentence[],
  mine: number
): Promise<boolean> => {
  const told: string[] = [];
  for (const sentence of sentences) {
    set({ telling: { now: sentence.ids, told: [...told] } });
    // oxlint-disable-next-line no-await-in-loop -- one sentence after another, as he says them
    await pause(sayingMs(sentence.say));
    if (speaking !== mine || !on) {
      return false;
    }
    told.push(...sentence.ids);
  }
  set({ telling: null });
  return true;
};

/**
 * The part of the read-back they are at: he says which part it is, tells
 * its lines back as a short story, each lighting up as he gets to it, and
 * asks whether it is right. Without a story he reads the lines as they
 * stand. They answer once he has asked.
 */
const readPart = async (): Promise<void> => {
  if (words === null) {
    return;
  }
  const told = words;
  const now = progressNow();
  const parts = readBackParts(now.facts);
  const part = parts[now.confirmed];
  if (part === undefined) {
    finish();
    return;
  }
  speaking += 1;
  const mine = speaking;
  rest();
  tone = "easy, light";
  asked = true;
  const intro = now.adding ? told.added : told.intro(part.group, part.first);
  const telling = storyFor(part);
  show("speaking", { said: null });
  if (!(await sayThrough(intro, mine))) {
    return;
  }
  const story = await within(telling, storyWaitMs);
  if (speaking !== mine || !on) {
    return;
  }
  const ahead = parts[now.confirmed + 1];
  if (ahead !== undefined) {
    void storyFor(ahead);
  }
  const sentences =
    story ??
    part.facts
      .filter(({ out }) => out !== true)
      .map(({ id, text }) => ({ say: text, ids: [id] }));
  if (!(await tell(sentences, mine))) {
    return;
  }
  if (
    !(await sayThrough(`${intro} ${told.question}`, mine, intro.length + 1))
  ) {
    return;
  }
  listen();
};

/** What he does once his line is said: the read-back, the end, or waiting for the answer. */
const onward = (): void => {
  if (isReading(progressNow())) {
    void readPart();
    return;
  }
  listen();
};

/** They say yes to the part of the read-back on screen: with the button, or in words. */
export const agreeToPart = (inWords?: string): void => {
  if (!on || words === null || !isReading(progressNow())) {
    return;
  }
  speaking += 1;
  rest();
  drop();
  carry = [];
  window.clearTimeout(noting);
  state = { ...state, doing: "idle", telling: null };
  set({
    said: { text: inWords ?? words.yes, marks: [], waiting: false },
    sign: "check",
  });
  const now = progressNow();
  const last = now.confirmed >= readBackParts(now.facts).length - 1;
  window.setTimeout(() => {
    if (!on) {
      return;
    }
    set({ said: null });
    if (last) {
      finish();
      return;
    }
    update(partConfirmed);
    void readPart();
  }, agreedMs);
};

/** Their line goes in the conversation, and where it stands there: the line his marks go on. */
const conversed = (said: InterviewLine | undefined): number => {
  if (said !== undefined) {
    update((progress) => withLine(progress, said));
    return progressNow().lines.length - 1;
  }
  return progressNow().lines.findLastIndex(({ from }) => from === "person");
};

/** His line in the conversation. */
const hisLine = ({ say, tone: how }: EarlyLine): void => {
  update((progress) =>
    withLine(progress, {
      from: "stephen",
      text: say,
      ...(how === null ? {} : { tone: how }),
    })
  );
};

/** What one turn knows while it runs. */
interface Turn {
  mine: Pending;
  order: number;
  inRead: boolean;
  /** The part of the read-back on screen when it was asked. */
  part: number;
  said: InterviewLine | undefined;
  /** Where the line his marks go on stands in the conversation. */
  answered: number;
}

/** Where the interview goes after a turn whose line is out: a later turn, the read-back, or an answer still coming decides it. */
const whereOf = (
  turn: StephenTurn,
  {
    decided,
    inRead,
    answering,
  }: { decided: boolean; inRead: boolean; answering: boolean }
): Pick<StephenTurn, "phase" | "wants"> => {
  const current = progressNow();
  if (decided) {
    return { phase: current.phase, wants: current.wants };
  }
  if (inRead) {
    return { phase: "readback", wants: staysIn(turn) };
  }
  const reads = turn.wants === "readback" || turn.wants === "end";
  return answering && reads ? { phase: turn.phase, wants: "answer" } : turn;
};

/**
 * His line is out, and what he would have written down never came: it is
 * missing, and the read-back is where they put that right. When he said he
 * would read back, he does, with what there is.
 */
const notesLost = (
  mine: Pending,
  { decided, answering }: { decided: boolean; answering: boolean }
): void => {
  if (!on || decided) {
    return;
  }
  if (!answering) {
    fade();
  }
  const { leads } = mine;
  if (mine.waits && leads !== null) {
    update((progress) => steered(progress, leads));
    onward();
  }
};

/** The rest of a turn whose line is out: what he wrote down, and where the interview goes. */
const taken = (
  turn: StephenTurn | TurnFailed,
  { mine, order, inRead, part, said, answered }: Turn
): void => {
  const decided = order !== turns || progressNow().person === "completed";
  const answering = carry.length > 0;
  if (turnFailed(turn)) {
    notesLost(mine, { decided, answering });
    return;
  }
  const where = whereOf(turn, { decided, inRead, answering });
  update((progress) =>
    afterTurn(
      progress,
      { ...turn, ...where },
      { answered, ...(inRead ? { pin: part } : {}) }
    )
  );
  if (!on || decided) {
    return;
  }
  if (turn.facts.length > 0) {
    wroteDown();
  }
  if (answering) {
    return;
  }
  set({ said: theirs(said, turn) });
  fade();
  const reads = turn.wants === "readback" || turn.wants === "end";
  if (reads && !inRead && (state.doing === "listening" || mine.waits)) {
    onward();
  } else if (mine.waits) {
    listen();
  }
};

/**
 * What a turn does with what comes in before the whole of it: his line,
 * said the moment it is written, and where the interview goes from it,
 * which the screen follows once his line is out; and what he does once
 * his line is said.
 */
const earlyOf = (
  known: Turn
): { after: () => void; onEvent: (early: EarlyEvent) => void } => {
  const { mine, inRead, said } = known;
  let next: EarlyNext | null = null;
  const after = inRead
    ? listen
    : (): void => {
        const { wants } = progressNow();
        if (mine.leads === null || wants === "readback" || wants === "end") {
          onward();
          return;
        }
        // He said he will read back: what he wrote down from this turn may still be on its way.
        mine.waits = true;
        show("thinking");
      };
  /** The screen follows where the interview goes once his line is out; the read-back and the end wait for what he wrote down. */
  const steer = (): void => {
    if (next === null || !mine.spoke || known.order !== turns || !on) {
      return;
    }
    const { phase, wants } = next;
    next = null;
    const waitsForNotes =
      wants === "readback" || wants === "end" || (inRead && wants !== "file");
    if (!waitsForNotes) {
      update((progress) =>
        steered(progress, { phase: inRead ? null : phase, wants })
      );
    }
  };
  const begin = (line: EarlyLine): void => {
    // They typed on while he thought, or left: this line is not said.
    if (pending !== mine || !on || line.say === "") {
      return;
    }
    pending = null;
    troubled = 0;
    mine.spoke = true;
    carry = [];
    known.answered = conversed(said);
    hisLine(line);
    window.clearTimeout(noting);
    set({ said: theirs(said) });
    speak(line.say, line.tone, { after });
    steer();
  };
  const onEvent = (early: EarlyEvent): void => {
    if ("line" in early) {
      begin(early.line);
    } else if ("next" in early) {
      ({ next } = early);
      if (early.next.wants === "readback" || early.next.wants === "end") {
        mine.leads = early.next;
        // The story of the first part is asked for while he says he will read back.
        foretell();
      }
      steer();
    }
  };
  return { after, onEvent };
};

/** A whole turn, before he said anything of it: he says it now, or waits for the rest of what they type. */
const answer = (
  turn: StephenTurn,
  known: Turn,
  { after, nudge }: { after: () => void; nudge: () => void }
): void => {
  const { inRead, part, said } = known;
  troubled = 0;
  if (turn.more) {
    // They stopped in the middle of a sentence: he waits for the rest, and answers with what there is.
    listen();
    nudging = window.setTimeout(nudge, nudgeMs);
    return;
  }
  carry = [];
  const answered = conversed(said);
  if (turn.say !== "") {
    hisLine(turn);
  }
  update((progress) =>
    afterTurn(
      progress,
      inRead ? { ...turn, phase: "readback", wants: staysIn(turn) } : turn,
      { answered, ...(inRead ? { pin: part } : {}) }
    )
  );
  set({ said: theirs(said, turn) });
  fade();
  if (inRead && turn.approved) {
    agreeToPart();
    return;
  }
  if (turn.say === "") {
    onward();
    return;
  }
  speak(turn.say, turn.tone, { noted: turn.facts.length > 0, after });
};

/**
 * One turn: core is told what happened, and Stephen does what comes back.
 * His line comes first, the moment it is written, and shows at once; what
 * he wrote down follows while it does.
 */
const ask = async (
  event: InterviewEvent,
  said?: InterviewLine
): Promise<void> => {
  if (words === null) {
    return;
  }
  const now = progressNow();
  const inRead = event === "readback";
  const reading = inRead ? readingIds(now.facts, now.confirmed) : undefined;
  const request = requestOf(
    words,
    event,
    said === undefined ? now.lines : [...now.lines, said],
    reading
  );
  if (request === null) {
    return;
  }
  drop();
  const mine: Pending = {
    giving: new AbortController(),
    spoke: false,
    leads: null,
    waits: false,
  };
  pending = mine;
  turns += 1;
  const known: Turn = {
    mine,
    order: turns,
    inRead,
    part: now.confirmed,
    said,
    answered: -1,
  };
  show("thinking");
  const { after, onEvent } = earlyOf(known);
  const turn = await reach(request, mine.giving, onEvent);
  if (mine.spoke) {
    taken(turn, known);
    return;
  }
  if (pending !== mine || !on) {
    return;
  }
  pending = null;
  if (turnFailed(turn)) {
    // What they typed is kept, and asked with again, with whatever they type meanwhile.
    trouble(turn.status, () => {
      void ask(event, said === undefined ? undefined : (saidNow() ?? said));
    });
    return;
  }
  answer(turn, known, {
    after,
    nudge: () => {
      void ask("nudge", saidNow());
    },
  });
};

/** Everything they typed since his last line goes to him. */
const commit = async (): Promise<void> => {
  rest();
  const said = saidNow();
  if (said === undefined || words === null) {
    return;
  }
  if (!isReading(progressNow())) {
    await ask("answer", said);
    return;
  }
  // A plain yes needs no thinking about.
  if (words.agrees.test(said.text)) {
    agreeToPart(said.text);
    return;
  }
  await ask("readback", said);
};

/** What they typed is their answer: typing over him stops him at once. */
export const sendTyped = (text: string): void => {
  const said = text.trim();
  if (!on || said === "" || state.doing === "idle") {
    return;
  }
  speaking += 1;
  drop();
  carry.push(said);
  bubble();
  void commit();
};

/** A line as it is quoted in a sentence: without its own full stop. */
const quoted = (line: string): string => line.replace(/\.$/u, "");

/**
 * They put a line of the read-back right themselves: it says their words
 * at once, and Stephen hears of it as if they had typed it, so what is
 * kept for the record follows.
 */
export const changeLine = (id: string, was: string, now: string): void => {
  update((progress) => withFactText(progress, id, now));
  if (words !== null) {
    sendTyped(words.changed(quoted(was), quoted(now)));
  }
};

/** What the conversation says by itself follows the language on screen. */
export const setLoopWords = (next: LoopWords): void => {
  words = next;
};

/**
 * The conversation begins, or goes on where it was: with nothing said, his
 * first line; back on the link, where they were; in the read-back, the part
 * they are at.
 */
export const startLoop = (): void => {
  if (on || words === null) {
    return;
  }
  on = true;
  carry = [];
  drop();
  state = idle;
  troubled = 0;
  window.addEventListener("online", tryAgain);
  const now = progressNow();
  if (isReading(now)) {
    void readPart();
    return;
  }
  void ask(openingEvent(now));
};

/**
 * The conversation is left: what they typed and he didn't answer is kept
 * with it, unless the copy kept elsewhere took this one's place.
 */
export const stopLoop = ({ keep = true }: { keep?: boolean } = {}): void => {
  const unanswered = saidNow();
  if (on && keep && unanswered !== undefined) {
    update((progress) => withLine(progress, unanswered));
  }
  on = false;
  speaking += 1;
  drop();
  carry = [];
  rest();
  window.clearTimeout(noting);
  window.removeEventListener("online", tryAgain);
  state = idle;
  for (const listener of listeners) {
    listener();
  }
};
