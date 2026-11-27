import { interviewLimits } from "@grasp-os/shared/interview-links";
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
  FactTag,
  InterviewPhase,
  VoiceTag,
} from "@grasp-os/shared/interview-turn";
import type {
  VoiceAnswered,
  VoiceLine,
} from "@grasp-os/shared/interview-voice";
import { useSyncExternalStore } from "react";

import { readingSeconds } from "../onboarding/setup.ts";
import { answerMeter } from "./answer-meter.ts";
import type { Measured } from "./answer-meter.ts";
import { answerVoice, askStory, isRefused } from "./api.ts";
import type { Refused } from "./api.ts";
import type { DotSign } from "./dot-signs.ts";
import { openEar, pauseMs } from "./ear.ts";
import type { Ear, EarEvent } from "./ear.ts";
import {
  approveWhenKept,
  kindNow,
  linkNow,
  progressNow,
  update,
} from "./kept.ts";
import { joinLive } from "./live.ts";
import type { AgentOpening, Live, LiveDoing, LiveSegment } from "./live.ts";
import {
  hangUp,
  lastHeard,
  micMuted,
  muteMic,
  reachMic,
  watchLevel,
  watchMute,
} from "./mic.ts";
import {
  afterTurn,
  approved,
  isReading,
  minutesAt,
  openingEvent,
  partConfirmed,
  steered,
  ticked,
  withFactText,
  withLine,
  withSpoken,
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
import type { Voicing } from "./speech.ts";
import {
  echoes,
  pauseFor,
  quietFloor,
  step,
  unanswered,
} from "./turn-taking.ts";
import type { Act, Floor, Happening, Wait } from "./turn-taking.ts";
import type { LoopWords } from "./words.ts";

// The interview as it runs. It is one live conversation with Grasp's
// ElevenLabs agent (live.ts): ElevenLabs hears them and Stephen answers
// and speaks there, so he answers at once and they can talk over him.
// Their words show over the box as they are heard, and go into the
// transcript as each stretch is settled. Whoever can't or won't talk
// types to the same agent, in a conversation without sound: his answers
// come as text, and stand on the stage to be read. Core writes down what
// was said after each answer, from the conversation as the page heard it
// (`/api/interview/voice`); an answer it couldn't write down is asked
// with again at the next, and before the read-back.
//
// When he says he will read back, the conversation is left and the
// read-back goes on here: he tells what he wrote down, a part at a time,
// as a short story (`/api/interview/story`), out loud (speech.ts), its
// lines lighting up as he says them, or at the pace he would say it
// without sound. They agree to it with the button or a plain yes, put a
// line right or take one out. What they put right, typed, said or
// changed on screen, core's notes write down like any answer, with the
// lines read back. What was said is kept with the interview (kept.ts);
// this is only the moment.
//
// In the read-back whose turn it is is decided by turn-taking.ts, which
// is told everything that happens there, also what his own ears hear
// (ear.ts), for whoever chose to talk: he doesn't listen until he asks
// whether it is right.
//
// Nothing goes on quietly in another way when the conversation can't be
// had. When core opens none, the bar at the top says why, as core said
// it; when it drops, that it dropped; when what they said can't be
// written down, that. Each with a way to try again where that can help.
//
// Every answer typed is measured from when it was sent
// (answer-meter.ts). Everything that happens in the read-back, what is
// done about it and each answer measured is told on `window` as a
// `loopEventName` event, so tests can follow the conversation.

/** What stands in the bar at the top when the conversation can't go on, and whether trying again can help (`goOn`). */
export interface LoopTrouble {
  message: string;
  again: boolean;
}

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
  /** The conversation can't go on: why, for the bar at the top, never as his line. */
  trouble: LoopTrouble | null;
  /**
   * His line as the session told it, ahead of his voice, which hasn't begun
   * in it yet: in the transcript already, but not to be seen there until he
   * says it.
   */
  ahead: string | null;
  /**
   * The summary he gives in the conversation (the agent's own, its one
   * summary): his line that sums it up, from the moment he begins it, and
   * whether he asked if it is right. Shown big on the stage in his place.
   */
  summary: { line: string; asked: boolean } | null;
}

/** What happens in the conversation, as it is told on `window` (`loopEventName`). */
export type LoopEvent =
  | { happened: Happening }
  | { did: Act }
  | { measured: Measured };

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
/** How long the summary's story is waited for once he brought it in: it is all of it, and takes a while to write. */
const storyWaitMs = 6000;
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
  trouble: null,
  ahead: null,
  summary: null,
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
/** In the read-back: whose turn it is, and what they said that he hasn't taken yet. */
let floor: Floor = quietFloor;
/** Which of his lines is being said: a later one makes an earlier one's end count for nothing. */
let speaking = 0;
let sayingCount = 0;
let noting = 0;
/** The waits the floor set, by name. */
const waits = new Map<Wait, number>();
/** How he says the line on screen, and whether it asked something. */
let tone: VoiceTag | null = null;
let asked = false;
/** What trying again does, while the bar at the top offers it. */
let owed: (() => void) | null = null;
let unmeasure: (() => void) | null = null;
/** The line he says or said last, and what follows it: said again when what cut him off was nothing. */
let lastSaid: { how: VoiceTag | null; after: () => void } | null = null;
/** The language the last session was opened in: one opened in another goes on in that one. */
let sessionIn: string | null = null;

/** Tells whoever follows the conversation what happens in it. */
const announce = (event: LoopEvent): void => {
  window.dispatchEvent(new CustomEvent(loopEventName, { detail: event }));
};

const meter = answerMeter((answer) => {
  announce({ measured: answer });
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
};

/** How he says a line: in the voice of whoever holds the interview. */
const voiceOf = (how: VoiceTag | null): Voicing => ({
  speaker: progressNow().interviewer ?? "stephen",
  tone: how,
});

/**
 * The conversation can't go on: why stands in the bar at the top, with a
 * way to try again (`again`) where that can help.
 */
const stuck = (message: string, again: (() => void) | null): void => {
  owed = again;
  set({ trouble: { message, again: again !== null } });
};

/** Nothing stands in the bar any more. */
const unstuck = (): void => {
  owed = null;
  if (state.trouble !== null) {
    set({ trouble: null });
  }
};

/** They press "Try again" in the bar at the top: what couldn't be done is tried once more. */
export const goOn = (): void => {
  const retry = owed;
  if (!on || retry === null) {
    return;
  }
  unstuck();
  retry();
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
 * says them; then `after`, unless something else happened meanwhile.
 */
const speak = (line: string, how: VoiceTag | null, after: () => void): void => {
  speaking += 1;
  const mine = speaking;
  rest();
  lastSaid = { how, after };
  // oxlint-disable-next-line no-use-before-define -- the floor decides whether he listens while he speaks
  happen({ type: "speak", at: performance.now() });
  tone = how;
  asked = line.trim().endsWith("?");
  sayingCount += 1;
  show("speaking", { line, saying: sayingCount, from: 0 });
  const saying = sayInPieces(line, voiceOf(how), { done: true });
  void (async () => {
    await saying.over;
    if (speaking === mine && on) {
      after();
    }
  })();
};

/** Says a line and waits until it is said; false when something else happened meanwhile. */
const sayThrough = async (
  line: string,
  mine: number,
  from = 0,
  /** What he says, when it is not what the screen shows: then the line on screen stands whole. */
  spoken?: string
): Promise<boolean> => {
  sayingCount += 1;
  set({
    line,
    saying: sayingCount,
    from: spoken === undefined ? from : line.length,
  });
  await say(spoken ?? line.slice(from), voiceOf(tone));
  return speaking === mine && on;
};

/** The line he may have to say out of turn is fetched ahead, a sentence at a time as he says it. */
const readyToTell = (told: LoopWords): void => {
  const voicing = voiceOf(sorry);
  for (const piece of piecesOf(told.unheard)) {
    prepare(piece.text, voicing);
  }
};

/**
 * Something he has to tell them that is no part of the conversation: he
 * couldn't hear them. He only says it: the screen keeps his own line,
 * whole.
 */
const notice = (line: string, then: () => void): void => {
  const was = state.line;
  const question = asked;
  speak(line, sorry, () => {
    asked = question;
    set({ line: was, from: was.length });
    then();
  });
  set({ line: was, from: was.length });
};

/** The lines of the part on screen, by id, as core is told what was read back. */
const readingIds = (facts: InterviewFact[], part: number): string[] =>
  (readBackParts(facts)[part]?.facts ?? []).map(({ id }) => id).slice(0, 60);

/** What they said, as the bubble shows it. */
const theirs = (said: InterviewLine): Said | null =>
  said.text === "" ? null : { text: said.text, marks: [], waiting: false };

/** What they said since his last line, as one line of theirs; none when nothing. */
const saidNow = (): InterviewLine | undefined => {
  const text = unanswered(floor);
  if (text === "") {
    return undefined;
  }
  const typed = floor.live === "" && floor.parts.every((part) => part.typed);
  // Stamped as it is said: the read-back tells when it was.
  return { from: "person", text, ...(typed ? { typed } : {}), at: Date.now() };
};

/** The stories asked for, by the lines they are of: each is asked for once. */
const stories = new Map<string, Promise<StorySentence[] | null>>();

/**
 * A part of the read-back as he tells it; none for a part of one line,
 * which is said as it stands. Asked for once per part and its lines: the
 * page shows the same story he tells (read-back-story.tsx).
 */
export const storyFor = async (
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

/** Their first name, as he says goodbye with it: the page tells it (`setLoopName`). */
let firstName = "";
/** His goodbye is being said: it goes on while the page moves to the thanks. */
let farewell = false;

/** Their first name, as the page told it: the guide greets them by it. */
export const loopFirstName = (): string => firstName;

/** Whether they lead a team and tell about its work, not their own. */
let leads = false;

/** Who he talks to, by the name the page knows them by, and whether they lead their team. */
export const setLoopName = (name: string, lead = false): void => {
  firstName = name.trim();
  leads = lead;
};

/**
 * What the agent's first line and prompt are filled in with (its dynamic
 * variables): his opening, new or coming back, and their name. Without
 * a name the agent's own opening stands.
 */
const openingFor = (
  told: LoopWords,
  back: boolean,
  minutes: number
): AgentOpening => {
  const known = {
    ...(firstName === "" ? {} : { first_name: firstName }),
    // The minutes before this conversation: the agent counts its own on top.
    minutes_used: String(Math.floor(minutes)),
  };
  if (back) {
    // His first line is the agent's own, `{{opening}}`: back, it asks only whether they're ready.
    return {
      variables: { opening: told.welcomeBack, ...known },
      note: told.backNote,
    };
  }
  return {
    variables:
      firstName === ""
        ? known
        : { opening: told.opening(firstName, leads), ...known },
    note: null,
  };
};

/**
 * They agreed to the summary: what they left in counts from now, and he
 * says goodbye, warmly and by name, while the thanks comes on screen.
 */
const finish = (): void => {
  unstuck();
  rest();
  show("idle", { line: "", said: null, sign: null });
  const goodbye = words?.farewell(firstName);
  if (goodbye !== undefined && progressNow().mode === "talk") {
    farewell = true;
    void (async () => {
      try {
        await say(goodbye, voiceOf("warm, grateful"));
      } finally {
        farewell = false;
      }
    })();
  }
  update(approved);
  approveWhenKept();
};

/** Where the interview stands, as core is told it with each call. */
const standingOf = (told: LoopWords) => {
  const link = linkNow();
  if (link === null) {
    return null;
  }
  // The clock moves on to this call first: the minutes core is told leave
  // out what was time away since the last one.
  const at = Date.now();
  update((progress) => ticked(progress, at));
  const now = progressNow();
  return {
    secret: link.secret,
    locale: told.locale,
    facts: now.facts
      .filter(({ out }) => out !== true)
      .map(({ id, tag, text }) => ({ id, tag, text })),
    phase: now.phase,
    minutes: minutesAt(now, at),
    adding: now.adding,
  };
};

/** Something they put right in the read-back, until core has written it down. */
interface Correction {
  /** Their line, as it stands in the conversation at `answered`. */
  said: InterviewLine;
  answered: number;
  /** The lines that were read back to them, by id, and the part they are of. */
  reading: string[];
  part: number;
  /** They changed this line on their screen themselves, to these words. */
  edit?: { id: string; text: string };
}

/** What they put right that core hasn't written down yet, oldest first. */
const corrections: Correction[] = [];
let correcting: Promise<boolean> | null = null;

/** What core's notes made of a correction: kept, pinned to the part it was said to. */
const tookCorrection = (
  { facts, changes }: NonNullable<VoiceAnswered["turn"]>,
  { answered, part }: Correction
): void => {
  update((progress) =>
    afterTurn(
      progress,
      {
        facts,
        changes,
        // It stays the read-back, where it stands.
        phase: progress.phase,
        wants: progress.wants,
      },
      { answered, kind: kindNow(), pin: part }
    )
  );
  if (on && facts.length + changes.length > 0) {
    wroteDown();
  }
};

/** One correction written down by core's notes, as any answer is, with the lines read back; false when it couldn't be. */
const correctOnce = async (correction: Correction): Promise<boolean> => {
  const standing = words === null ? null : standingOf(words);
  if (standing === null) {
    return false;
  }
  const { said, answered, reading, edit } = correction;
  const written = await answerVoice({
    action: "answer",
    ...standing,
    // The conversation it came after, which the notes read it with.
    before: progressNow()
      .lines.slice(0, answered)
      .filter(({ removed }) => removed !== true)
      .map(({ from, text }) => ({ from, text }))
      .slice(-interviewLimits.lines),
    noted: 0,
    said: [
      {
        from: "person",
        text: said.text,
        ...(said.typed === true ? { typed: true as const } : {}),
      },
    ],
    reading,
    ...(edit === undefined ? {} : { edit }),
  });
  if (isRefused(written)) {
    return false;
  }
  if (written.turn !== null) {
    tookCorrection(written.turn, correction);
  }
  return true;
};

/** Every correction still owed, written down one at a time, oldest first; false when one couldn't be, and it stays owed. */
const writeOwed = async (): Promise<boolean> => {
  let [next] = corrections;
  while (next !== undefined) {
    // oxlint-disable-next-line no-await-in-loop -- one at a time: each is read with the facts the one before left
    if (!(await correctOnce(next))) {
      return false;
    }
    corrections.shift();
    [next] = corrections;
  }
  return true;
};

/** What is owed is written down (`writeOwed`): one run at a time, which whoever asks meanwhile waits for too. */
const writeCorrections = async (): Promise<boolean> => {
  correcting ??= writeOwed();
  const run = correcting;
  try {
    return await run;
  } finally {
    if (correcting === run) {
      correcting = null;
    }
  }
};

/**
 * The end, once everything they put right is written down: they never
 * agree to a summary that misses what they changed in it.
 */
const finishWhenWritten = async (): Promise<void> => {
  const done = await writeCorrections();
  if (!on) {
    return;
  }
  if (done) {
    finish();
    return;
  }
  if (words !== null) {
    stuck(words.notNoted, () => {
      void finishWhenWritten();
    });
  }
  // Their turn again: they can try again, or put more right.
  listen(true);
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
    void finishWhenWritten();
    return;
  }
  speaking += 1;
  const mine = speaking;
  rest();
  // oxlint-disable-next-line no-use-before-define -- he doesn't listen until he asks whether it is right
  happen({ type: "speak", at: performance.now(), readsBack: true });
  tone = "easy, light";
  asked = true;
  // On screen the summary's heading; out loud he brings it in, in his own words.
  const intro = now.adding ? told.added : told.summary;
  const telling = storyFor(part);
  show("speaking", { said: null });
  if (
    !(await sayThrough(
      intro,
      mine,
      0,
      now.adding ? undefined : told.summaryIntro
    ))
  ) {
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
  const ask = now.adding ? told.addedAsk : told.summaryAsk;
  prepare(ask, voiceOf(tone));
  if (!(await tell(sentences, mine))) {
    return;
  }
  // The screen asks "Is that correct?"; he asks it as one asks it out loud.
  if (
    !(await sayThrough(
      `${intro} ${told.question}`,
      mine,
      intro.length + 1,
      ask
    ))
  ) {
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
      void finishWhenWritten();
      return;
    }
    update(partConfirmed);
    void readPart();
  }, agreedMs);
};

/** Their line goes in the conversation, and where it stands there: the line his marks go on. */
const conversed = (said: InterviewLine): number => {
  update((progress) => withLine(progress, said));
  return progressNow().lines.length - 1;
};

/**
 * They put something right in the read-back: typed, said, or changed on
 * their screen (`edit`). Their line goes in the conversation, core's
 * notes write it down, and he asks nothing more: the summary on screen
 * changes, and it is their turn again. One that couldn't be written down
 * stays owed, said so in the bar at the top, and is tried again with the
 * next, with the button there, and before they agree.
 */
const putRight = (said: InterviewLine, edit?: Correction["edit"]): void => {
  const now = progressNow();
  // He stops reading: what he read is what they answer.
  speaking += 1;
  rest();
  const at = performance.now();
  // oxlint-disable-next-line no-use-before-define -- what they said is his now, and he doesn't listen meanwhile
  happen({ type: "answered", at });
  // oxlint-disable-next-line no-use-before-define -- as above
  happen({ type: "wait", at });
  corrections.push({
    said,
    answered: conversed(said),
    reading: readingIds(now.facts, now.confirmed),
    part: now.confirmed,
    ...(edit === undefined ? {} : { edit }),
  });
  window.clearTimeout(noting);
  set({ said: theirs(said) });
  show("thinking");
  // oxlint-disable-next-line no-use-before-define -- written down, then their turn again
  void settleCorrections();
};

/** What they put right is written down; then it is their turn again, with what couldn't be said in the bar at the top. */
const settleCorrections = async (): Promise<void> => {
  const done = await writeCorrections();
  if (!on || !isReading(progressNow()) || state.doing !== "thinking") {
    return;
  }
  if (done) {
    unstuck();
  } else if (words !== null) {
    stuck(words.notNoted, () => {
      show("thinking");
      void settleCorrections();
    });
  }
  fade();
  listen(true);
};

/** What they said in the read-back goes to him: a plain yes agrees, anything else puts something right. */
const askedFor = ({ text, typed }: Extract<Act, { type: "ask" }>): void => {
  if (words === null) {
    return;
  }
  if (words.agrees.test(text)) {
    agreeToPart(text);
    return;
  }
  putRight({
    from: "person",
    text,
    ...(typed ? { typed } : {}),
    at: Date.now(),
  });
};

/** Stephen's own ears in the read-back, for whoever chose to talk. */
let ear: Ear | null = null;
let earOpening = false;
/** The ear numbers its stretches from 1; the floor's are counted on across ears. */
let stretchesBefore = 0;
/** Whether the stretch being said comes in live: then a breath ends it. */
let swift = false;

/** What the ear hears, as it happens to the floor. */
const heardBy =
  (opened: Ear, from: number) =>
  (event: EarEvent): void => {
    if (!on || ear !== opened) {
      return;
    }
    const at = performance.now();
    const stretch = from + ("stretch" in event ? event.stretch : 0);
    stretchesBefore = Math.max(stretchesBefore, stretch);
    switch (event.type) {
      case "stretch-start": {
        ({ live: swift } = event);
        // oxlint-disable-next-line no-use-before-define -- what is heard happens to the floor
        happen({ type: "stretch-start", at: event.at, stretch });
        break;
      }
      case "partial": {
        // oxlint-disable-next-line no-use-before-define -- as above
        happen({ type: "partial", at, stretch, text: event.text });
        break;
      }
      case "stretch-end": {
        // oxlint-disable-next-line no-use-before-define -- as above
        happen({ type: "stretch-end", at: lastHeard(), stretch });
        break;
      }
      case "final": {
        // What cut him off may be his own voice, where the microphone hears the speaker: never theirs to answer.
        const own = floor.cut && echoes(event.text, state.line);
        // oxlint-disable-next-line no-use-before-define -- as above
        happen(
          own
            ? { type: "echo", at, stretch }
            : { type: "final", at, stretch, text: event.text }
        );
        break;
      }
      case "unheard": {
        if (event.reason === "limited") {
          // Their voice for today is used up: said at the top, and they type from here.
          // oxlint-disable-next-line no-use-before-define -- as above
          voiceSpent();
          break;
        }
        // oxlint-disable-next-line no-use-before-define -- as above
        happen({ type: "unheard", at, stretch });
        break;
      }
      case "line": {
        // The ear falls back to recordings by itself: nothing changes here.
        break;
      }
      case "words": {
        // The floor goes by stretches: their partials and finals above.
        break;
      }
      default: {
        event satisfies never;
      }
    }
  };

/**
 * Their listening for today is used up, in the read-back: the bar at the
 * top says so, and from then on they type there, as without a microphone;
 * listening would only be refused again.
 */
const voiceSpent = (): void => {
  if (words !== null) {
    stuck(words.voiceSpent, null);
  }
  update((progress) => ({ ...progress, mode: "type" }));
  // oxlint-disable-next-line no-use-before-define -- the floor stops listening by ear
  happen({ type: "voice", at: performance.now(), on: false });
};

/** No microphone for his ears in the read-back: from then on they type; the box to type in is there anyway. */
const noMicrophone = (): void => {
  update((progress) => ({ ...progress, mode: "type" }));
  // oxlint-disable-next-line no-use-before-define -- the floor stops listening by ear
  happen({ type: "voice", at: performance.now(), on: false });
  listen();
};

/** Opens his ears, once, for whoever chose to talk; it hears from now on. */
const hearken = async (): Promise<void> => {
  if (ear !== null) {
    ear.setDeaf(false);
    return;
  }
  const link = linkNow();
  if (earOpening || words === null || link === null) {
    return;
  }
  earOpening = true;
  const opened = await openEar({
    locale: words.locale,
    link,
    pause: () => pauseFor(swift, pauseMs),
    wary: () => floor.doing === "speaking",
  });
  earOpening = false;
  if (opened === null) {
    if (on) {
      noMicrophone();
    }
    return;
  }
  if (!on) {
    opened.close();
    return;
  }
  ear = opened;
  opened.on(heardBy(opened, stretchesBefore));
  // The floor may have stopped listening while the microphone was asked for.
  opened.setDeaf(!floor.hearing);
};

/** His ears hear nothing for now: what is being said counts for nothing. */
const unhear = (): void => {
  ear?.setDeaf(true);
};

/** Lets go of his ears and of the microphone. */
const hangUpEar = (): void => {
  ear?.close();
  ear = null;
  swift = false;
  hangUp();
  // A new conversation never starts muted.
  muteMic(false);
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
      void hearken();
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
    case "hush": {
      speaking += 1;
      rest();
      return;
    }
    case "resume": {
      if (lastSaid !== null && state.line !== "") {
        speak(state.line, lastSaid.how, lastSaid.after);
      }
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
  // They talk on while he thinks, or over him while he speaks: he listens.
  const interrupted =
    happening.type === "stretch-start" &&
    state.doing === "speaking" &&
    floor.doing === "listening";
  if (
    (happening.type === "stretch-start" && state.doing === "thinking") ||
    interrupted
  ) {
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
    happening.type === "echo" ||
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

/** The live conversation they are in, while there is one (live.ts). */
let live: Live | null = null;
/** The one being opened or held is without sound: they type, and his answers come as text. */
let liveTextOnly = false;
/** Its pass, kept after it is left until everything said in it is written down. */
let livePass: string | null = null;
/** What the session heard, kept with its pass, for core to write down from. */
let liveSaid: (() => VoiceLine[]) | null = null;
/** An answer couldn't be written down: what they said since `liveNoted` is still owed. */
let notesBehind = false;
/** The conversation being left, until what was said in it is written down or given up. */
let leaving: Promise<void> = Promise.resolve();
/** What they typed while no conversation was open: said to him once one is. */
let unsent: string[] = [];
/** Our own ear beside the session, for their words as they talk (`overhearLive`). */
let liveEar: Ear | null = null;
/** How many of their answers in the session are written down. */
let liveNoted = 0;
/** Their stretches still being heard, by ID: the words over the box. */
const liveHeard = new Map<string, string>();
/** The stretch of his being said now. */
let hisStretch: string | null = null;
/** Its words so far. */
let hisWords = "";
/** He said he will read back: the session is left once his line is said. */
let liveReadsBack = false;
/** A line of his this long, once he goes to the read-back, is the summary itself, not the words before it. */
const summaryChars = 160;

let liveMuting: (() => void) | null = null;
/** Keeps the level of their voice for the hill in the box, while in a session. */
let liveLevel: (() => void) | null = null;
/** Their sentences just said: they rest over the box a moment before they go to the transcript. */
let liveResting: string[] = [];
let liveRest: number | undefined;
/** Bumped as a session is joined or left: what comes of an older one counts for nothing. */
let liveCount = 0;

/** How long a sentence of theirs rests over the box once said, in ms. */
const restMs = 900;
/**
 * How fast his words come on the stage while he speaks in a session, in
 * characters a second of his voice: the session tells his text ahead of
 * his voice and not where his voice is in it, so his words follow the
 * voice as it is heard: on at the pace of speech while it sounds, barely
 * on in the breath between two sentences, so they neither run ahead of
 * him nor fall behind (the owner's ask, 2026-11-27).
 */
const spokenCharsPerSecond = 17;
/** How much of that pace goes on while his voice is quiet, in a breath between words or sentences. */
const quietPace = 0.25;
/** How loud his voice must be to count as heard, 0 to 1, and how long it counts as heard after, in ms. */
const voicedLevel = 0.03;
const voicedHoldMs = 180;
/** When his voice began in the line on the stage; null while he doesn't speak. */
let liveSpokeAt: number | null = null;
/** How far his voice is in the line on the stage, in characters, and when that was last moved on. */
let liveReached = 0;
let liveTickAt = 0;
let liveHeardAt = -Infinity;
/** Whether his voice has begun in the line on the stage. */
let hisVoiced = false;
/** His line as told before his voice began in it: shown once it does. */
let hisUnseen: string | null = null;
let livePacing: number | undefined;

/** His words come on the stage at the pace of his voice as it is heard. */
const paceHis = (): void => {
  if (liveSpokeAt === null) {
    return;
  }
  const now = performance.now();
  const dt = Math.min(200, now - liveTickAt);
  liveTickAt = now;
  if ((live?.levels().his ?? 0) > voicedLevel) {
    liveHeardAt = now;
  }
  const pace = now - liveHeardAt < voicedHoldMs ? 1 : quietPace;
  liveReached += (dt / 1000) * spokenCharsPerSecond * pace;
  const at = Math.min(Math.floor(liveReached), state.line.length);
  if (at !== state.from) {
    set({ from: at });
  }
};

/** From `at` characters into the line on the stage, his words follow his voice on. */
const paceFrom = (at: number): void => {
  liveReached = at;
  liveTickAt = performance.now();
  liveHeardAt = liveTickAt;
};

/** His voice began (`true`) or stopped: his words follow it, or all stand. */
const paceLive = (speaks: boolean): void => {
  window.clearInterval(livePacing);
  livePacing = undefined;
  if (!speaks) {
    liveSpokeAt = null;
    return;
  }
  // Back to a line he had begun: on from where its words were.
  liveSpokeAt = performance.now();
  paceFrom(state.from);
  hisVoiced = true;
  if (hisUnseen !== null) {
    set({ line: hisUnseen, from: 0, ahead: null });
    hisUnseen = null;
  }
  livePacing = window.setInterval(paceHis, 60);
};

/** Where the line his marks go on stands: their last line. */
const lastAnswer = (): number =>
  progressNow().lines.findLastIndex(({ from }) => from === "person");

/** Their microphone in the session follows the box's mute; when that fails it stays as it was. */
const muteQuietly = async (session: Live, muted: boolean): Promise<void> => {
  try {
    await session.setMuted(muted);
  } catch {
    // As above.
  }
};

/**
 * His summary asks its answer, and the two buttons under it give it: their
 * microphone and our own ear rest until they choose to change something, so
 * talk around them never reaches him or the transcript.
 */
let summaryHeld = false;

/** Their microphone in the session: muted while they mute it, or while his summary waits for its answer. */
const micHeld = (): boolean => micMuted() || summaryHeld;

/** The summary's answer is waited for, or no longer: the microphone follows. */
const holdForSummary = (held: boolean): void => {
  summaryHeld = held;
  if (live !== null) {
    void muteQuietly(live, micHeld());
  }
};

/** What core wrote down after an answer: kept. */
const tookLive = (answered: VoiceAnswered): void => {
  liveNoted = answered.noted;
  const { turn } = answered;
  if (turn !== null) {
    const { facts, changes, phase } = turn;
    update((progress) =>
      afterTurn(
        progress,
        {
          facts,
          changes,
          // The read-back, once he said he goes there, stays where it is.
          phase: isReading(progress) ? progress.phase : phase,
          wants: progress.wants,
        },
        { answered: lastAnswer(), kind: kindNow() }
      )
    );
    if (facts.length > 0 && on) {
      wroteDown();
    }
  }
};

let liveNoting: Promise<void> | null = null;
let liveNoteOwed = false;
/** How long their answer is waited for, and how often, when the conversation as heard here doesn't hold it yet. */
const liveNoteWaitMs = 1500;
const liveNoteTries = 4;

/**
 * Core writes down what they said since the last answer noted: one call at
 * a time, as core asks, and once more when they said more meanwhile.
 */
const noteLive = async (): Promise<void> => {
  liveNoteOwed = true;
  if (liveNoting !== null) {
    await liveNoting;
    return;
  }
  // oxlint-disable-next-line no-use-before-define -- the run below
  liveNoting = notingLive();
  try {
    await liveNoting;
  } finally {
    liveNoting = null;
  }
};

/**
 * One answer written down, while one is owed: null once nothing more can
 * be. One that core couldn't write down stays owed (`notesBehind`):
 * `liveNoted` stands where it was, so the next request covers it.
 */
const noteOnce = async (waited: number): Promise<number | null> => {
  liveNoteOwed = false;
  const pass = livePass;
  const told = words;
  const standing = told === null ? null : standingOf(told);
  if (pass === null || standing === null) {
    return null;
  }
  const noted = liveNoted;
  const said = liveSaid?.() ?? [];
  const answered = await answerVoice({
    action: "answer",
    ...standing,
    pass,
    noted,
    // Only a new session is told what came before.
    before: [],
    said,
  });
  if (isRefused(answered)) {
    notesBehind = true;
    return null;
  }
  notesBehind = false;
  if (answered.noted === noted && waited < liveNoteTries) {
    // Their answer isn't heard here yet: a moment later.
    liveNoteOwed = true;
    await pause(liveNoteWaitMs);
    return waited + 1;
  }
  tookLive(answered);
  return 0;
};

/** Answers written down one after another, as long as one is owed. */
const notingLive = async (waited = 0): Promise<void> => {
  if (!liveNoteOwed) {
    return;
  }
  const next = await noteOnce(waited);
  if (next !== null) {
    await notingLive(next);
  }
};

/** How long after each try what was said is asked to be written down once more, in ms. */
const noteAgainMs = [800, 2000];

/**
 * Whether everything said in the conversation is written down. What
 * wasn't is asked for again, a moment apart: before the read-back, the
 * end and a new conversation, none of which may miss it.
 */
const written = async (): Promise<boolean> => {
  for (const wait of noteAgainMs) {
    if (!notesBehind) {
      return true;
    }
    // oxlint-disable-next-line no-await-in-loop -- backing off between tries
    await pause(wait);
    // oxlint-disable-next-line no-await-in-loop -- one try at a time
    await noteLive();
  }
  return !notesBehind;
};

/** Their words over the box: every stretch of theirs still being heard. */
const liveWords = (): string => [...liveHeard.values()].join(" ").trim();

/** What stands over the box: their sentences resting there, then what is still being heard. */
const showHeard = (): void => {
  const heard = [...liveResting, liveWords()]
    .filter((part) => part !== "")
    .join(" ");
  window.clearTimeout(noting);
  set({
    said: heard === "" ? null : { text: heard, marks: [], waiting: true },
    talking: liveWords() !== "",
  });
};

/** Their resting sentences go to the transcript, and the words over the box with them. */
const keepResting = (): void => {
  window.clearTimeout(liveRest);
  liveRest = undefined;
  const resting = liveResting;
  liveResting = [];
  for (const sentence of resting) {
    update((progress) =>
      withSpoken(progress, { from: "person", text: sentence, at: Date.now() })
    );
  }
  if (resting.length > 0) {
    void noteLive();
  }
};

const liveSegment = ({ id, from, text, final }: LiveSegment): void => {
  const heardText = text.trim();
  if (from === "person") {
    if (final) {
      liveHeard.delete(id);
      if (heardText !== "") {
        // Said: it rests a moment where it stands, then becomes their line.
        liveResting.push(heardText);
        window.clearTimeout(liveRest);
        liveRest = window.setTimeout(() => {
          if (liveWords() === "") {
            keepResting();
            showHeard();
          } else {
            // They talk on: it goes with what they say next.
            liveRest = undefined;
          }
        }, restMs);
      }
    } else if (heardText === "") {
      liveHeard.delete(id);
    } else {
      liveHeard.set(id, heardText);
    }
    showHeard();
    return;
  }
  if (heardText === "") {
    return;
  }
  if (liveResting.length > 0) {
    // He answers what they said: it stands in the transcript before his answer, never after it.
    keepResting();
    showHeard();
  }
  if (hisStretch !== id) {
    hisStretch = id;
    sayingCount += 1;
    tone = null;
    set({ saying: sayingCount, from: 0 });
    // A new line: its words follow his voice from where it is now.
    hisVoiced = liveSpokeAt !== null;
    if (liveSpokeAt !== null) {
      liveSpokeAt = performance.now();
      paceFrom(0);
    }
  }
  asked = heardText.endsWith("?");
  hisWords = heardText;
  if (liveReadsBack && heardText.length >= summaryChars) {
    // His summary: it stands big on the stage as he says it, in his place.
    set({ summary: { line: heardText, asked: false } });
  }
  if (liveTextOnly || (hisVoiced && liveSpokeAt === null)) {
    // Without sound his line stands whole at once, to be read.
    set({ line: heardText, from: heardText.length });
  } else if (hisVoiced) {
    // While his voice goes on, his words keep following it: never the whole line at once, for a frame.
    set({ line: heardText, from: Math.min(state.from, heardText.length) });
  } else {
    // Told ahead of his voice: it comes on the stage as he starts to say it.
    hisUnseen = heardText;
    set({ ahead: heardText });
  }
  if (final) {
    hisStretch = null;
    hisWords = "";
    update((progress) =>
      withSpoken(progress, { from: "stephen", text: heardText, at: Date.now() })
    );
  }
};

/** What he does, as the session says it. */
const liveDoing = (doing: LiveDoing): void => {
  if (doing === "speaking") {
    if (liveResting.length > 0) {
      // His voice answers what they said: it goes to the transcript first.
      keepResting();
      showHeard();
    }
    show("speaking");
    paceLive(true);
    // His voice plays as the agent sends it: when they talk over him, the agent
    // stops him itself. Hushing him here on what the microphone heard cut his own voice off.
    live?.hush(false);
    return;
  }
  paceLive(false);
  live?.hush(false);
  if (liveResting.length > 0 && liveRest === undefined && liveWords() === "") {
    keepResting();
    showHeard();
  }
  if (doing === "thinking" || doing === "initializing") {
    show("thinking");
    return;
  }
  if (state.summary !== null && !state.summary.asked) {
    // His summary is said, and he asks whether it is right: they answer under it, with the
    // buttons, and nothing more is listened to until they want to change something.
    set({ summary: { ...state.summary, asked: true } });
    holdForSummary(true);
  }
  show("listening");
};

/** He goes to another part: the screen follows, and the read-back waits for his line. */
const livePart = (part: InterviewPhase): void => {
  if (part === "readback") {
    // He sums it up himself, in the conversation: what he says is the one summary, shown on
    // the stage as he says it, and their yes or change goes back to him (the owner's ask,
    // 2026-11-27). He says goodbye and hangs up once they agree (`finished`).
    liveReadsBack = true;
    foretell();
    return;
  }
  update((progress) => steered(progress, { phase: part, wants: "answer" }));
};

/**
 * The session is left: what they said last is written down first, unless
 * `quick`, as when the page is left; then it is closed. What couldn't be
 * written down stays owed, with the pass and what was heard (`written`).
 */
const left = async (quick: boolean): Promise<void> => {
  const session = live;
  liveEar?.close();
  liveEar = null;
  // Nothing more of him is heard from now: what is still noted below takes a moment.
  session?.hush(true);
  void session?.setMuted(true);
  keepResting();
  liveCount += 1;
  live = null;
  liveMuting?.();
  liveMuting = null;
  paceLive(false);
  liveLevel?.();
  liveLevel = null;
  liveHeard.clear();
  // His line cut off: kept as far as it came, so he says it again when they come back.
  const cut = hisStretch === null ? "" : hisWords;
  if (session !== null && cut !== "") {
    update((progress) =>
      withSpoken(progress, { from: "stephen", text: cut, at: Date.now() })
    );
  }
  hisStretch = null;
  hisWords = "";
  hisVoiced = false;
  hisUnseen = null;
  summaryHeld = false;
  set({ ahead: null, summary: null });
  liveReadsBack = false;
  if (session === null) {
    return;
  }
  const pass = livePass;
  if (quick) {
    notesBehind = false;
  } else {
    await noteLive();
  }
  // Not when another conversation was opened meanwhile: the pass is that one's then.
  if (livePass === pass && !notesBehind) {
    livePass = null;
    liveSaid = null;
  }
  await session.close();
};

/** The conversation ended as it wasn't the person the link is for; kept for this page only. */
let notThemNow = false;
const notThemListeners = new Set<() => void>();
const setNotThem = (value: boolean): void => {
  notThemNow = value;
  for (const listener of notThemListeners) {
    listener();
  }
};
const onNotThem = (listener: () => void): (() => void) => {
  notThemListeners.add(listener);
  return () => {
    notThemListeners.delete(listener);
  };
};
/** Whether Stephen ended the conversation as it wasn't the person the link is for. */
export const useNotThem = (): boolean =>
  useSyncExternalStore(
    onNotThem,
    () => notThemNow,
    () => false
  );

/** Leaves the session (`left`), and has whoever opens the next one wait until it is left. */
const leaveLive = async ({ quick = false } = {}): Promise<void> => {
  leaving = left(quick);
  await leaving;
};

/** What they said couldn't be written down: said in the bar at the top, with `again` to try once more. */
const notWritten = (again: () => void): void => {
  show("idle", { sign: null });
  if (words !== null) {
    stuck(words.notNoted, again);
  }
};

/**
 * The agent summed up what they said, heard whether it is right and said
 * goodbye, then hung up: the session is left, what was said written down,
 * and it is agreed as it stands. No second summary is read back here.
 */
const toEnd = async (): Promise<void> => {
  const count = liveCount;
  show("thinking");
  await leaveLive();
  // oxlint-disable-next-line no-use-before-define -- the rest of it, also when tried again
  await endWritten(count + 1);
};

/** The end, once what was said is written down: nothing is agreed to that misses an answer. */
const endWritten = async (count: number): Promise<void> => {
  const done = await written();
  if (!on || liveCount !== count) {
    return;
  }
  if (!done) {
    notWritten(() => {
      show("thinking");
      void endWritten(count);
    });
    return;
  }
  rest();
  show("idle", { line: "", said: null, sign: null });
  update(approved);
  approveWhenKept();
};

/** How a new session opens: as the interview stands, or in the language they just switched to. */
const eventOf = (
  opening: ReturnType<typeof openingEvent>,
  locale: string
): "start" | "resume" | "add" | "language" => {
  const switched = sessionIn !== null && sessionIn !== locale;
  sessionIn = locale;
  if (opening === "start" || opening === "add") {
    return opening;
  }
  return switched ? "language" : "resume";
};

/** How often the session is told they are still talking, at most, in ms: the agent holds back a moment each time. */
const stillTalkingMs = 900;
let toldTalkingAt = 0;

/** Tells the session they are still talking, at most every `stillTalkingMs`. */
const stillTalking = (session: Live): void => {
  const now = performance.now();
  if (now - toldTalkingAt >= stillTalkingMs) {
    toldTalkingAt = now;
    session.typing();
  }
};

/**
 * Our own ear beside a session that only says their words once their turn
 * is over (the ElevenLabs agent): what it hears while they talk stands over
 * the box at once, until the session's words for that turn come. It only
 * shows: the session hears their answer.
 */
const overhearLive = async (session: Live, count: number): Promise<void> => {
  const { overheard } = session;
  const link = linkNow();
  if (words === null || link === null) {
    return;
  }
  const opened = await openEar({
    locale: words.locale,
    link,
    // While he speaks, only a voice that stays is theirs: his own, from the speaker, never.
    wary: () => state.doing === "speaking",
    // It only shows their words: the session hears their answer, so nothing is written down from a recording.
    recordings: false,
  });
  if (opened === null) {
    return;
  }
  if (!on || liveCount !== count || live !== session) {
    opened.close();
    return;
  }
  liveEar = opened;
  opened.on((event) => {
    if (liveEar !== opened || summaryHeld) {
      // Over his summary's buttons, what the room says is not theirs to show.
      return;
    }
    if (event.type === "words") {
      overheard(event.text, event.settled);
    }
    if (
      (event.type === "stretch-start" || event.type === "words") &&
      opened.talking &&
      state.doing !== "speaking"
    ) {
      // They are talking: he waits, rather than taking a breath of theirs for the end of their turn.
      stillTalking(session);
    }
  });
};

/** Whether asking core again can help: nothing came back, our side failed, or too much came at once. Not a budget spent, a link that doesn't work or an interview withdrawn. */
const worthAgain = ({ status, code }: Refused): boolean =>
  status === 0 || status >= 500 || code === "interview.limited";

/** No conversation could be had: why stands in the bar at the top, with a way to try again where that can help. */
const notOpened = (message: string, again: boolean): void => {
  show("idle", { sign: null });
  stuck(
    message,
    again
      ? () => {
          // oxlint-disable-next-line no-use-before-define -- opened once more
          void converse();
        }
      : null
  );
};

/** What the conversation tells, while it is the one the page is in. */
const handlersFor = (count: number): Parameters<typeof joinLive>[1] => {
  const mine = (): boolean => liveCount === count && on;
  return {
    segment: (segment) => {
      if (mine()) {
        liveSegment(segment);
      }
    },
    doing: (doing) => {
      if (mine()) {
        liveDoing(doing);
      }
    },
    part: (part) => {
      if (mine()) {
        livePart(part);
      }
    },
    ended: () => {
      if (mine() && words !== null) {
        // It dropped: what was said is kept and written down, and they are told, with a way to go on.
        void leaveLive();
        notOpened(words.dropped, true);
      }
    },
    notThem: () => {
      if (mine()) {
        // Not the person the link is for: it ends here, said on a screen of its own (page.tsx).
        void leaveLive({ quick: true });
        rest();
        show("idle", { line: "", said: null, sign: null });
        setNotThem(true);
      }
    },
    finished: () => {
      if (mine()) {
        // He summed it up, they agreed and he said goodbye: what was said is written down, and that is the end.
        void toEnd();
      }
    },
    failed: () => {
      if (mine() && words !== null) {
        // It began, but his first line never came: no conversation, said as one that could not start.
        void leaveLive({ quick: true });
        notOpened(words.notStarted, true);
      }
    },
  };
};

/** The conversation is the page's now: muted as the box says, and overheard for their words as they talk. */
const joinedLive = (joined: Live, count: number): void => {
  live = joined;
  livePass = joined.pass;
  liveSaid = joined.said;
  liveNoted = 0;
  // What they typed while there was none goes to him now, as their turn.
  for (const text of unsent) {
    joined.type(text);
  }
  if (unsent.length > 0) {
    unsent = [];
    void noteLive();
  }
  if (joined.textOnly) {
    return;
  }
  if (micHeld()) {
    void muteQuietly(joined, true);
  }
  liveMuting = watchMute(() => {
    void muteQuietly(joined, micHeld());
  });
  void overhearLive(joined, count);
};

/**
 * The conversation is opened, at the start or again where it stood: with
 * their voice, or without sound for whoever types or has no microphone
 * here. When none can be had the bar at the top says why; nothing goes on
 * in another way.
 */
const converse = async (): Promise<void> => {
  const told = words;
  if (told === null) {
    return;
  }
  show("thinking");
  const count = liveCount;
  // The one before is left first, and what was said in it written down: a new one's notes start at its own answers.
  await leaving;
  const done = await written();
  if (!on || liveCount !== count) {
    return;
  }
  if (!done) {
    notWritten(() => {
      void converse();
    });
    return;
  }
  if (progressNow().mode === "talk" && !(await reachMic())) {
    if (!on || liveCount !== count) {
      return;
    }
    // No microphone here: said in the bar at the top (composer.tsx), and they type to him instead.
    update((progress) => ({ ...progress, mode: "type" }));
    setSound(false);
  }
  const standing = standingOf(told);
  if (!on || liveCount !== count || standing === null) {
    return;
  }
  const now = progressNow();
  liveTextOnly = now.mode !== "talk";
  if (!liveTextOnly && liveLevel === null) {
    // The level of their voice, for the hill in the box: the session holds a microphone of its own.
    liveLevel = watchLevel(() => {
      // Only the level: the session hears them.
    });
  }
  const before = now.lines.filter(({ removed }) => removed !== true);
  const joined = await joinLive(
    {
      action: "open",
      event: eventOf(openingEvent(now), standing.locale),
      ...standing,
      // What a new session doesn't know: the conversation before.
      before: before
        .map(({ from, text }) => ({ from, text }))
        .slice(-interviewLimits.lines),
    },
    handlersFor(count),
    liveTextOnly,
    // Back after a pause or a reload: no new hello, just whether they're ready to go on.
    openingFor(told, before.length > 0, minutesAt(now, Date.now()))
  );
  if (!on || liveCount !== count) {
    if (joined !== null && !isRefused(joined)) {
      await joined.close();
    }
    return;
  }
  if (joined === null) {
    notOpened(told.notStarted, true);
    return;
  }
  if (isRefused(joined)) {
    // Why core opened none, as core said it: a budget spent for today, not set up, withdrawn, a link that doesn't work.
    notOpened(joined.message, worthAgain(joined));
    return;
  }
  unstuck();
  joinedLive(joined, count);
};

/** How loud he and they are in the session now, 0 to 1: nothing outside one. */
export const liveLevels = (): { his: number; theirs: number } =>
  live?.levels() ?? { his: 0, theirs: 0 };

/** They are typing: in a conversation, he waits for it. */
export const typingNow = (): void => {
  live?.typing();
};

/**
 * What they typed is their answer. In the conversation it goes to him
 * there, as their turn, with their voice or without sound; in the
 * read-back it is their answer to what he read, and stops him at once.
 * Typed while no conversation is open, it stands in the transcript and
 * goes to him once one is, which trying again opens.
 */
export const sendTyped = (text: string): void => {
  const typed = text.trim();
  if (!on || typed === "") {
    return;
  }
  const at = performance.now();
  meter.sent(at);
  if (isReading(progressNow())) {
    happen({ type: "typed", at, text: typed });
    return;
  }
  update((progress) =>
    withLine(progress, {
      from: "person",
      text: typed,
      typed: true,
      at: Date.now(),
    })
  );
  if (live === null) {
    unsent.push(typed);
    goOn();
    return;
  }
  live.type(typed);
  void noteLive();
};

/** They agree with the summary he gave: their yes goes to him, as said. */
export const agreeToSummary = (): void => {
  if (!on || words === null || state.summary === null) {
    return;
  }
  set({ sign: "check" });
  sendTyped(words.yes);
};

/** They want to change something in his summary: he listens again, and they say or type it. */
export const changeSummary = (): void => {
  holdForSummary(false);
};

/** A line as it is quoted in a sentence: without its own full stop. */
const quoted = (line: string): string => line.replace(/\.$/u, "");

/**
 * They put a line of the read-back right themselves: it says their words
 * at once, and core's notes hear of it as if they had typed it, told
 * which line and its new words, so the change is exactly theirs and what
 * is kept for the record follows.
 */
export const changeLine = (id: string, was: string, now: string): void => {
  const text = now.trim().slice(0, interviewLimits.fact);
  update((progress) => withFactText(progress, id, text));
  if (on && words !== null) {
    putRight(
      {
        from: "person",
        text: words.changed(quoted(was), quoted(text)),
        typed: true,
        at: Date.now(),
      },
      { id, text }
    );
  }
};

/**
 * The read-back, once the conversation before is left and everything said
 * in it is written down: the summary misses none of their last answer.
 */
const readBackWhenWritten = async (): Promise<void> => {
  show("thinking");
  await leaving;
  const done = await written();
  if (!on) {
    return;
  }
  if (!done) {
    notWritten(() => {
      void readBackWhenWritten();
    });
    return;
  }
  void readPart();
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
  owed = null;
  state = idle;
  unmeasure = onFirstSound((at) => {
    meter.voice(at);
  });
  readyToTell(words);
  const now = progressNow();
  // Whoever chose to type isn't surprised by a voice, back on the link too.
  if (now.mode === "type") {
    setSound(false);
  }
  if (isReading(now)) {
    // He reads back here, and hears their answer with his own ears.
    happen({ type: "voice", at: performance.now(), on: now.mode === "talk" });
    void readBackWhenWritten();
    return;
  }
  void converse();
};

/**
 * The conversation is left: what they typed in the read-back and he
 * didn't take yet is kept with it, unless the copy kept elsewhere took
 * this one's place; then nothing of this one is owed any more either.
 */
export const stopLoop = ({ keep = true }: { keep?: boolean } = {}): void => {
  const unsaid = saidNow();
  if (on && keep && unsaid !== undefined) {
    update((progress) => withLine(progress, unsaid));
  }
  on = false;
  void leaveLive({ quick: !keep });
  if (!keep) {
    corrections.length = 0;
    unsent = [];
  }
  speaking += 1;
  owed = null;
  happen({ type: "stop", at: performance.now() });
  floor = quietFloor;
  hangUpEar();
  meter.stop();
  unmeasure?.();
  unmeasure = null;
  // His goodbye is said to its end, as the thanks comes on screen.
  if (!farewell) {
    rest();
  }
  window.clearTimeout(noting);
  state = idle;
  for (const listener of listeners) {
    listener();
  }
};

/**
 * What the conversation says by itself follows the language on screen.
 * Switched while it runs, he stops at once, mid-word if he must, and goes
 * on in the new language: a new conversation in it, heard and answered in
 * it. Nothing of the old language is said in the new one's voice, nor the
 * other way round.
 */
export const setLoopWords = (next: LoopWords): void => {
  const was = words;
  if (on && next.unheard !== was?.unheard) {
    readyToTell(next);
  }
  words = next;
  if (on && was !== null && was.locale !== next.locale) {
    stopLoop();
    startLoop();
  }
};
