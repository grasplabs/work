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
import { answerMeter, waitedOf } from "./answer-meter.ts";
import type { Measured } from "./answer-meter.ts";
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
import {
  onFirstSound,
  piecesOf,
  prepare,
  say,
  sayInPieces,
  setSound,
  stopSpeaking,
} from "./speech.ts";
import type { Saying, Voicing } from "./speech.ts";
import {
  hiccup,
  quietFloor,
  retryWaits,
  step,
  stillIn,
  troubleOf,
  unanswered,
} from "./turn-taking.ts";
import type { Act, Floor, Happening, Wait } from "./turn-taking.ts";
import type { LoopWords } from "./words.ts";

// The interview as it runs: Stephen says his line, out loud (speech.ts),
// its words lighting up as he says them, or at the pace he would say it
// without sound; they type; he thinks; turn after turn. His lines come
// from core (`/api/interview/turn`): the first sentence of his line while
// the rest is still being written, so he begins to speak with it; then the
// whole line, which he goes on saying without a gap, while what he wrote
// down is still on its way. Last he reads back what he wrote down, a part
// at a time, told as a short story (`/api/interview/story`), and they
// agree to it, put a line right or take one out. What was said is kept
// with the interview (kept.ts); this is only the moment. Ported from the
// prototype (grasplabs/prototype, packages/grasp:
// src/data/interview-loop.ts), with his voice; his ears come later.
//
// Whose turn it is is decided by turn-taking.ts, which is told everything
// that happens here and says what to do: he answers when they are done,
// waits when they aren't, and drops his answer when they talk on.
//
// When core can't be reached, a turn is asked for again by itself, twice.
// Only when that doesn't help does anyone notice: Stephen says so himself,
// as his own line, and whether it is their connection or our side; those
// lines are fetched ahead, so he can still say them. What they said is
// kept, and he goes on trying: after a while, at once when the connection
// is back, and with whatever they say next.
//
// Every answer is measured from their last word to his first sound
// (answer-meter.ts) and sent with the next turn, which core keeps for
// staff. Everything that happens, what is done about it and each answer
// measured is told on `window` as a `loopEventName` event, so tests can
// follow the conversation.

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
  /** They are talking right now. */
  talking: boolean;
  /** The sign beside him: what he is doing, or the little he feels. */
  sign: DotSign | null;
}

/** What happens in the conversation, as it is told on `window` (`loopEventName`). */
export type LoopEvent =
  | { happened: Happening }
  | { did: Act }
  | { measured: Measured; waited: number | null };

/** The name of the event on `window` that tells each `LoopEvent`. */
export const loopEventName = "grasp:interview-loop";

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
/** How long a story is waited for once he said which part it is. */
const storyWaitMs = 2500;
/** How he sounds saying that something doesn't work. */
const sorry: VoiceTag = "upbeat, reassuring";
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
  talking: false,
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
/** Whose turn it is, and what they said that he hasn't answered yet. */
let floor: Floor = quietFloor;
/** The turn on its way: how to give it up, and whether his line from it is out. */
interface Pending {
  /** The floor's number for it, when it answers what they said. */
  turn: number | null;
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
/** His line being said while the rest of it is still being written. */
let underway: Saying | null = null;
let noting = 0;
/** The waits the floor set, by name. */
const waits = new Map<Wait, number>();
/** How he says the line on screen, and whether it asked something. */
let tone: VoiceTag | null = null;
let asked = false;
/** How many turns in a row could not be had; the turn still owed; when he asks for it again. */
let troubled = 0;
let owed: (() => void) | null = null;
let again = 0;
/** How long they waited for his voice the answer before, for the next turn; none when it wasn't heard. */
let waited: number | undefined;
let unmeasure: (() => void) | null = null;

/** Tells whoever follows the conversation what happens in it. */
const announce = (event: LoopEvent): void => {
  window.dispatchEvent(new CustomEvent(loopEventName, { detail: event }));
};

const meter = answerMeter((answer) => {
  waited = waitedOf(answer);
  announce({ measured: answer, waited: waited ?? null });
});
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
    return floor.parts.length === 0 && !floor.talking && asked
      ? "question"
      : null;
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

/** He stops: what he says. */
const rest = (): void => {
  stopSpeaking();
  underway = null;
};

/** How he says a line: in the voice of whoever holds the interview. */
const voiceOf = (how: VoiceTag | null): Voicing => ({
  speaker: progressNow().interviewer ?? "stephen",
  tone: how,
});

/** The turn on its way counts for nothing any more, nor one still owed. */
const drop = (): void => {
  pending?.giving.abort();
  pending = null;
  owed = null;
  window.clearTimeout(again);
};

/** What they said since his last line, for the bubble: every stretch so far, and what they are saying now. */
const bubble = (): void => {
  window.clearTimeout(noting);
  const text = unanswered(floor);
  set({
    said: text === "" ? null : { text, marks: [], waiting: true },
    talking: floor.talking,
    sign: signFor(state.doing),
  });
};

/** What they said stays over the box a little longer, with what he marked, then goes. */
const fade = (): void => {
  window.clearTimeout(noting);
  noting = window.setTimeout(() => {
    if (floor.parts.length === 0 && floor.live === "") {
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

/**
 * He waits for their answer: in the box at the bottom, and through the ear
 * when they chose to talk. With `afterReading`, he listens again after the
 * read-back's lines: he asked whether it is right, or it wasn't the
 * read-back after all.
 */
const listen = (afterReading = false, nudge = false): void => {
  show("listening");
  // oxlint-disable-next-line no-use-before-define -- the floor decides, and may open the ear
  happen({ type: "listen", at: performance.now(), asked: afterReading, nudge });
};

/**
 * Stephen says a line, a sentence at a time, its words lighting up as he
 * says them; then `after`, unless something else happened meanwhile. With
 * `open`, the line is only its first sentence so far: the rest follows
 * (`grow`) as it is written.
 */
const speak = (
  line: string,
  how: VoiceTag | null,
  {
    noted = false,
    open = false,
    answers = false,
    after,
  }: {
    noted?: boolean;
    open?: boolean;
    /** It answers what they said, which is then his. */
    answers?: boolean;
    after: () => void;
  }
): void => {
  speaking += 1;
  const mine = speaking;
  rest();
  // oxlint-disable-next-line no-use-before-define -- the floor closes the ear while he speaks
  happen({ type: "speak", at: performance.now(), answers });
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
  const saying = sayInPieces(line, voiceOf(how), { done: !open });
  underway = open ? saying : null;
  void (async () => {
    await saying.over;
    if (speaking === mine && on) {
      after();
    }
  })();
};

/** The rest of the line he began with its first sentence: he says it on without a gap, and it grows on screen in place. */
const grow = (all: string): void => {
  const saying = underway;
  if (saying === null) {
    return;
  }
  underway = null;
  saying.add(all);
  saying.end();
  asked = saying.text.trim().endsWith("?");
  set({ line: saying.text });
};

/** Says a line and waits until it is said; false when something else happened meanwhile. */
const sayThrough = async (
  line: string,
  mine: number,
  from = 0
): Promise<boolean> => {
  sayingCount += 1;
  set({ line, saying: sayingCount, from });
  await say(line.slice(from), voiceOf(tone));
  return speaking === mine && on;
};

/** A hiccup is worth asking again; a refusal or a budget used up is not. */
const retries = (answer: StephenTurn | TurnFailed): boolean =>
  turnFailed(answer) && hiccup(answer.status);

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
  for (const wait of retryWaits) {
    if (!retries(answer) || giving.signal.aborted) {
      return answer;
    }
    // oxlint-disable-next-line no-await-in-loop -- backing off between tries
    await pause(wait);
    if (giving.signal.aborted) {
      return answer;
    }
    meter.again();
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
  // They are saying something: once that is written down, it is asked for with it.
  if (floor.talking || floor.parts.some(({ waiting }) => waiting)) {
    window.clearTimeout(again);
    again = window.setTimeout(tryAgain, 2000);
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
  const told = words;
  const { say: line, again: after } = troubleOf({
    tried: troubled,
    status,
    online: navigator.onLine,
  });
  troubled += 1;
  const wait = (): void => {
    listen();
    owed = retry;
    window.clearTimeout(again);
    if (after !== null) {
      again = window.setTimeout(tryAgain, after);
    }
  };
  if (line === null) {
    wait();
    return;
  }
  speak(told[line], sorry, { after: wait });
};

/** The lines he may have to say when nothing can be fetched any more are fetched ahead, a sentence at a time as he says them. */
const readyToTell = (told: LoopWords): void => {
  const voicing = voiceOf(sorry);
  for (const line of [
    told.offline,
    told.trouble,
    told.stillTrouble,
    told.unheard,
    told.noMicrophone,
  ]) {
    for (const piece of piecesOf(line)) {
      prepare(piece.text, voicing);
    }
  }
};

/**
 * Something he has to tell them that is no part of the conversation: he
 * couldn't hear them, or can't listen here. He says it himself, and then
 * his own line stands there again.
 */
const notice = (line: string, then: () => void): void => {
  const was = state.line;
  const question = asked;
  speak(line, sorry, {
    after: () => {
      asked = question;
      set({ line: was });
      then();
    },
  });
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
    ...(waited === undefined ? {} : { waited }),
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

/** What they said since his last line, as one line of theirs; none when nothing. */
const saidNow = (): InterviewLine | undefined => {
  const text = unanswered(floor);
  if (text === "") {
    return undefined;
  }
  const typed = floor.live === "" && floor.parts.every((part) => part.typed);
  return { from: "person", text, ...(typed ? { typed } : {}) };
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
    await say(sentence.say, voiceOf(tone));
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
  // oxlint-disable-next-line no-use-before-define -- he doesn't listen until he asks whether it is right
  happen({ type: "speak", at: performance.now(), readsBack: true });
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
  // Each sentence, and the question after them, is fetched ahead, so it follows the one before without a gap.
  for (const sentence of sentences) {
    prepare(sentence.say, voiceOf(tone));
  }
  prepare(told.question, voiceOf(tone));
  if (!(await tell(sentences, mine))) {
    return;
  }
  if (
    !(await sayThrough(`${intro} ${told.question}`, mine, intro.length + 1))
  ) {
    return;
  }
  listen(true);
};

/** What he does once his line is said: the read-back, the end, or waiting for the answer. */
const onward = (): void => {
  if (isReading(progressNow())) {
    void readPart();
    return;
  }
  listen(true);
};

/** They say yes to the part of the read-back on screen: with the button, or in words. */
export const agreeToPart = (inWords?: string): void => {
  if (!on || words === null || !isReading(progressNow())) {
    return;
  }
  speaking += 1;
  rest();
  drop();
  const at = performance.now();
  // oxlint-disable-next-line no-use-before-define -- what they said is answered, and he doesn't listen meanwhile
  happen({ type: "answered", at });
  // oxlint-disable-next-line no-use-before-define -- as above
  happen({ type: "wait", at });
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
const hisLine = ({ say: text, tone: how }: EarlyLine): void => {
  update((progress) =>
    withLine(progress, {
      from: "stephen",
      text,
      ...(how === null ? {} : { tone: how }),
    })
  );
};

/**
 * His line came whole after he began it with its first sentence: it goes
 * in the conversation, unless they went on meanwhile, and he says the rest.
 */
const rounded = (known: Turn, line: EarlyLine): void => {
  if (known.opening === null) {
    return;
  }
  known.opening = null;
  if (on && known.order === turns) {
    hisLine(line);
  }
  grow(line.say);
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
  /** The first sentence of his line, said while the rest of it is owed. */
  opening: EarlyLine | null;
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
  const answering = floor.parts.length > 0 || floor.talking;
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
    // He waited to read back, and it isn't that after all: he listens.
    listen(true);
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
    ? (): void => {
        listen(true);
      }
    : (): void => {
        const { wants } = progressNow();
        if (mine.leads === null || wants === "readback" || wants === "end") {
          onward();
          return;
        }
        // He said he will read back: what he wrote down from this turn may still be on its way, and he waits for it without listening.
        mine.waits = true;
        show("thinking");
        // oxlint-disable-next-line no-use-before-define -- the floor keeps the ear closed
        happen({ type: "wait", at: performance.now() });
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
  /** He begins his line: with its first sentence while the rest is written, or all of it. */
  const begin = (line: EarlyLine, whole: boolean): void => {
    // They typed on while he thought, or left: this line is not said.
    if (pending !== mine || !on || line.say === "") {
      return;
    }
    pending = null;
    troubled = 0;
    mine.spoke = true;
    meter.line(performance.now());
    known.answered = conversed(said);
    if (whole) {
      hisLine(line);
    } else {
      known.opening = line;
    }
    window.clearTimeout(noting);
    set({ said: theirs(said) });
    speak(line.say, line.tone, { after, open: !whole, answers: true });
    steer();
  };
  const onEvent = (early: EarlyEvent): void => {
    if ("opening" in early) {
      const { opening } = early;
      // oxlint-disable-next-line no-use-before-define -- not while they may be starting to talk
      whenStill(() => {
        begin(opening, false);
      });
    } else if ("line" in early) {
      const { line } = early;
      // oxlint-disable-next-line no-use-before-define -- as above
      whenStill(() => {
        if (known.opening === null) {
          begin(line, true);
        } else {
          rounded(known, line);
        }
      });
    } else if ("next" in early) {
      ({ next } = early);
      if (early.next.wants === "readback" || early.next.wants === "end") {
        mine.leads = early.next;
        // From this line on he doesn't listen, until he asks whether what he reads back is right.
        // oxlint-disable-next-line no-use-before-define -- the floor closes the ear
        happen({ type: "reads-back", at: performance.now() });
        // The story of the first part is asked for while he says he will read back.
        foretell();
      }
      steer();
    }
  };
  return { after, onEvent };
};

/** A whole turn, before he said anything of it: he says it now, or waits for the rest of what they say. */
const answer = (turn: StephenTurn, known: Turn, after: () => void): void => {
  const { inRead, part, said, mine } = known;
  troubled = 0;
  if (turn.more) {
    // They stopped in the middle of a sentence: he waits for the rest, and answers with what there is.
    show("listening");
    if (mine.turn !== null) {
      // oxlint-disable-next-line no-use-before-define -- the floor waits for the rest
      happen({ type: "more", at: performance.now(), turn: mine.turn });
    }
    return;
  }
  // oxlint-disable-next-line no-use-before-define -- what they said is his now
  happen({ type: "answered", at: performance.now() });
  meter.line(performance.now());
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
  speak(turn.say, turn.tone, {
    noted: turn.facts.length > 0,
    answers: true,
    after,
  });
};

/**
 * One turn: core is told what happened, and Stephen does what comes back.
 * His line comes first, the moment it is written, and shows at once; what
 * he wrote down follows while it does. `turn` is the floor's number for
 * it when it answers what they said.
 */
const ask = async (
  event: InterviewEvent,
  said?: InterviewLine,
  turn: number | null = null
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
  // The wait for his voice goes with one turn only.
  waited = undefined;
  drop();
  const mine: Pending = {
    turn,
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
    opening: null,
  };
  // Spoken, he looks as if he listens a moment longer: the floor says when he thinks.
  const looksListening =
    turn !== null && floor.asking === turn && floor.doing === "listening";
  if (!looksListening) {
    show("thinking");
  }
  const { after, onEvent } = earlyOf(known);
  const answered = await reach(request, mine.giving, onEvent);
  if (mine.spoke) {
    // Begun with its first sentence, his line came only with the whole turn, or never: he says what there is.
    const { opening } = known;
    if (opening !== null) {
      rounded(
        known,
        turnFailed(answered) || answered.say === ""
          ? opening
          : { say: answered.say, tone: answered.tone }
      );
    }
    taken(answered, known);
    return;
  }
  if (pending !== mine || !on) {
    return;
  }
  pending = null;
  if (turnFailed(answered)) {
    // What they said is kept, and asked with again, with whatever they say meanwhile.
    if (turn === null) {
      trouble(answered.status, () => {
        void ask(event, said);
      });
      return;
    }
    // oxlint-disable-next-line no-use-before-define -- the floor keeps what they said
    happen({ type: "failed", at: performance.now(), turn });
    trouble(answered.status, () => {
      // oxlint-disable-next-line no-use-before-define -- as above
      happen({ type: "retry", at: performance.now() });
    });
    return;
  }
  answer(answered, known, after);
};

/** What they said goes to him: in the read-back, a plain yes needs no thinking about. */
const askedFor = ({
  turn,
  text,
  typed,
  nudge,
}: Extract<Act, { type: "ask" }>): void => {
  if (words === null) {
    return;
  }
  const said: InterviewLine = {
    from: "person",
    text,
    ...(typed ? { typed } : {}),
  };
  if (!isReading(progressNow())) {
    void ask(nudge ? "nudge" : "answer", said, turn);
    return;
  }
  if (words.agrees.test(text)) {
    agreeToPart(text);
    return;
  }
  void ask("readback", said, turn);
};

/** When they were last heard, on the page's clock. */
const heardLast = (): number => floor.lastHeard;

/** Does `go` once they make no sound: at once, unless they made one so lately they may be starting to talk; then a moment later, at most. */
const whenStill = (go: () => void, since = performance.now()): void => {
  const wait = stillIn({
    now: performance.now(),
    since,
    lastHeard: heardLast(),
    hearing: floor.hearing,
  });
  if (wait === 0) {
    go();
    return;
  }
  window.setTimeout(() => {
    whenStill(go, since);
  }, wait);
};

/** Opens his ears for whoever chose to talk. */
const hearken = (): void => {
  // The ear (GRA-381) is opened here.
};

/** Closes his ears: what is being said is dropped. */
const unhear = (): void => {
  // The ear (GRA-381) is closed here.
};

/** One of the floor's waits is set, in place of one of the same name. */
const waitFor = (wait: Wait, ms: number): void => {
  window.clearTimeout(waits.get(wait));
  waits.set(
    wait,
    window.setTimeout(() => {
      waits.delete(wait);
      // oxlint-disable-next-line no-use-before-define -- a wait over is something that happens
      happen({ type: "waited", at: performance.now(), wait });
    }, ms)
  );
};

/** Does what the floor says. */
const perform = (act: Act): void => {
  switch (act.type) {
    case "hear": {
      hearken();
      return;
    }
    case "deaf": {
      unhear();
      return;
    }
    case "ask": {
      askedFor(act);
      return;
    }
    case "drop": {
      if (pending?.turn === act.turn) {
        drop();
      }
      return;
    }
    case "hush": {
      speaking += 1;
      rest();
      return;
    }
    case "after": {
      waitFor(act.wait, act.ms);
      return;
    }
    case "clear": {
      window.clearTimeout(waits.get(act.wait));
      waits.delete(act.wait);
      return;
    }
    case "quiet": {
      meter.quiet(act.at);
      return;
    }
    case "unheard": {
      // He couldn't hear them: he says so, and listens for it again; what he did hear is answered if no more comes.
      if (words !== null) {
        notice(words.unheard, () => {
          listen(false, true);
        });
      }
      return;
    }
    default: {
      act satisfies never;
    }
  }
};

/** What is on screen follows the floor: what they said, whether they talk, and whether he thinks yet. */
const follow = (happening: Happening): void => {
  if (happening.type === "waited" && happening.wait === "thinking") {
    if (floor.doing === "thinking" && state.doing === "listening") {
      show("thinking");
    }
    return;
  }
  if (happening.type === "stretch-start" && state.doing === "thinking") {
    show("listening");
  }
  if (happening.type === "final") {
    meter.words(happening.at);
  }
  const heard =
    happening.type === "stretch-start" ||
    happening.type === "partial" ||
    happening.type === "stretch-end" ||
    happening.type === "final" ||
    happening.type === "unheard" ||
    happening.type === "typed";
  if (heard) {
    bubble();
  }
};

/** Something happens: the floor decides what to do, and it is done. */
const happen = (happening: Happening): void => {
  const { floor: now, acts } = step(floor, happening);
  floor = now;
  announce({ happened: happening });
  follow(happening);
  for (const act of acts) {
    announce({ did: act });
    perform(act);
  }
};

/** What they typed is their answer: typing over him stops him at once. */
export const sendTyped = (text: string): void => {
  if (!on || text.trim() === "" || state.doing === "idle") {
    return;
  }
  const at = performance.now();
  meter.sent(at);
  happen({ type: "typed", at, text });
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
  if (on && next.offline !== words?.offline) {
    readyToTell(next);
  }
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
  floor = quietFloor;
  drop();
  state = idle;
  troubled = 0;
  waited = undefined;
  window.addEventListener("online", tryAgain);
  unmeasure = onFirstSound((at) => {
    meter.voice(at);
  });
  readyToTell(words);
  const now = progressNow();
  happen({ type: "voice", at: performance.now(), on: now.mode === "talk" });
  // Whoever chose to type isn't surprised by a voice, back on the link too.
  if (now.mode === "type") {
    setSound(false);
  }
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
  const unsaid = saidNow();
  if (on && keep && unsaid !== undefined) {
    update((progress) => withLine(progress, unsaid));
  }
  on = false;
  speaking += 1;
  drop();
  happen({ type: "stop", at: performance.now() });
  floor = quietFloor;
  meter.stop();
  unmeasure?.();
  unmeasure = null;
  rest();
  window.clearTimeout(noting);
  window.removeEventListener("online", tryAgain);
  state = idle;
  for (const listener of listeners) {
    listener();
  }
};
