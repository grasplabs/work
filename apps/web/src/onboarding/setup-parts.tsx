import { Button } from "@grasp-os/ui/components/button";
import { PageHeaderTitle } from "@grasp-os/ui/components/page-header";
import { Spinner } from "@grasp-os/ui/components/spinner";
import { Stat } from "@grasp-os/ui/components/stat";
import { cn } from "@grasp-os/ui/lib/utils";
import { useLingui } from "@lingui/react/macro";
import { CheckIcon } from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";

import { SpokenText } from "../voice/spoken-text.tsx";
import { narrationOf } from "../voice/timing.ts";
import { speak, useSay, useVoice } from "../voice/voice.ts";
import type { Tone } from "../voice/voice.ts";
import { readingSeconds } from "./setup.ts";

// The parts every step of the client onboarding is made of (prototype
// `components/onboarding/onboarding-steps.tsx`): one title, one sentence,
// one small action, one main button. Stephen says each step's title and
// sentence as it arrives, the sentence lighting up as he goes, and its way
// on fades in once he has said it; with the sound off, once there was time
// to read it.

/**
 * How Stephen sounds in the onboarding, from the tones he may use. He is
 * professional and even: the same calm voice whether he explains, asks,
 * or says that something is done. Warmth is for the welcome and a
 * thank-you, reassurance for where he is trusted with something, and only
 * the end, when it is all in, is said with more feeling. A tone directs
 * an English line only: in another language it would turn the first word
 * English (core's src/onboarding/speech.ts).
 */
export const tones = {
  /** Explaining, asking, moving on: most of what he says. */
  even: "sincere, steady",
  /** That something is done, or cannot be done: said plainly. */
  plain: "clear, measured pace",
  /** What he will do with what he is given, and what he will not. */
  sure: "sincere, steady, reassuring",
  /** The welcome, and a thank-you. */
  warm: "warm",
  /** The last step: everything is in. */
  glad: "warm, grateful",
} as const satisfies Record<string, Tone>;

/**
 * How Stephen says a step's line: its tone, and `quick` when it holds
 * something only known as it is said, such as a count.
 */
export interface StepVoice {
  tone?: Tone;
  quick?: boolean;
}

/** How a step's line is said unless it says otherwise. */
export const evenVoice: StepVoice = { tone: tones.even };

/** A step's title and sentence as Stephen says them: one line. */
export const stepLine = (title: string, sentence: string | undefined) =>
  narrationOf(title, sentence ?? "");

/**
 * Whether a step has been explained yet: given its reading time. Its way
 * on, the main button and any "skip", waits for it and then fades in.
 */
export const Explained = createContext<{
  explained: boolean;
  onExplained: () => void;
}>({
  explained: true,
  onExplained: () => {
    // Explained from the start.
  },
});

/**
 * Whether the admin has been through this step before and Stephen finished
 * it: coming back to it, back or forward, his message is there in full at
 * once and its way on with it. He says nothing again, and nothing lights
 * up; only what is done on this visit he answers as ever.
 */
export const Seen = createContext(false);

/**
 * Whether a step finished before is still opening: so for what is drawn
 * as it arrives, which is there as it was left, at once; it stops once the
 * step is on screen, so what turns up after that, done on this visit,
 * comes in as ever. Read only as something is first drawn.
 */
export const Opening = createContext<{ readonly current: boolean }>({
  current: false,
});

/**
 * The classes that bring something in (`motion`: a fade, a slide), or
 * none for what is there as a step finished before opens: it shows as it
 * was left. `key` is what it shows; once that changes on this visit, it
 * comes in as ever.
 */
export const useEntrance = (key: string, motion: string): string => {
  const opening = useContext(Opening);
  // What it showed as the step opened, while that has not changed.
  const [asLeft, setAsLeft] = useState(() => (opening.current ? key : null));
  if (asLeft !== null && asLeft !== key) {
    setAsLeft(null);
  }
  return asLeft === null ? motion : "";
};

/**
 * Whether, on a phone, the step does not fit beside even the smallest
 * brain: its sentence then makes way once read and tells how much room that
 * frees, so the brain can make way too where that is not enough.
 */
export const Cramped = createContext<{
  cramped: boolean;
  onMadeWay: (freed: number) => void;
}>({
  cramped: false,
  onMadeWay: () => {
    // Nothing to make way for.
  },
});

/** How long to wait for a line to be explained, in ms: by the sound, by whether it was said, and by how long it is. */
const explainedWait = (line: string, on: boolean, heard: boolean): number => {
  const reading = readingSeconds(line) * 1000;
  if (!on) {
    return Math.min(reading * 0.7, 4000);
  }
  // Said: a beat after it ends. Waiting on the voice: never forever.
  return heard ? 200 : reading + 3500;
};

/**
 * Explained once `line` has been said, or, with the sound off, once there
 * was time to read it: most of its reading time, never more than four
 * seconds.
 */
export const useExplainedAfter = (line: string): void => {
  const { onExplained } = useContext(Explained);
  const voice = useVoice();
  const saying = voice.line?.text === line;
  const heard = useRef(false);
  useEffect(() => {
    if (saying) {
      heard.current = true;
    }
    const id = saying
      ? undefined
      : window.setTimeout(
          onExplained,
          explainedWait(line, voice.on, heard.current)
        );
    return () => {
      window.clearTimeout(id);
    };
  }, [line, saying, voice.on, onExplained]);
};

/**
 * Whether a step's sentence has made way for what the step shows, `when`
 * nothing else stands in its place: on a phone where the step does not fit,
 * once it has been said, or with the sound off, once there was time to read
 * it all. Gone, it stays gone on this visit, so it never comes and goes as
 * the room it leaves changes.
 */
const useMadeWay = (
  line: string,
  when: boolean,
  sentence: RefObject<HTMLElement | null>
): boolean => {
  const { cramped, onMadeWay } = useContext(Cramped);
  const { explained } = useContext(Explained);
  const { on } = useVoice();
  const seen = useContext(Seen);
  const arrived = useRef(0);
  const [away, setAway] = useState(false);
  useEffect(() => {
    arrived.current = Date.now();
  }, []);
  useEffect(() => {
    const due = !away && when && cramped && explained;
    // Said, it was explained once it ended; read, it waits for the time to read it all; read before, it makes way at once.
    const reading = on || seen ? 0 : readingSeconds(line) * 1000 * 0.7;
    const id = due
      ? window.setTimeout(
          () => {
            // The room it frees is measured as it goes, before it folds away.
            onMadeWay(sentence.current?.offsetHeight ?? 0);
            setAway(true);
          },
          Math.max(0, arrived.current + reading - Date.now())
        )
      : undefined;
    return () => {
      window.clearTimeout(id);
    };
  }, [away, when, cramped, explained, on, seen, line, onMadeWay, sentence]);
  return away;
};

/** Copies text, and says whether it worked: browsers refuse without focus or permission. */
export const copyText = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
};

/** The way on, fading in once the step has been explained, and `ready` if it waits on something more. */
export const Onward = ({
  children,
  ready = true,
}: {
  children: ReactNode;
  ready?: boolean;
}) => {
  const { explained } = useContext(Explained);
  const shown = explained && ready;
  return (
    <div
      className={cn(
        "flex w-full flex-col items-center gap-6 transition-all duration-1000 ease-out",
        !shown && "translate-y-1.5 opacity-0"
      )}
      inert={!shown}
    >
      {children}
    </div>
  );
};

/**
 * What Grasp says back to what was just done on a step, in place of its
 * sentence: said as soon as what he is saying reaches a natural break, or
 * at once with `cut`. `tone` and `quick` as for a step's line. With
 * `announce`, it is said on its own even when an answer was already there
 * as the step arrived: for something done again on this visit.
 */
export interface Answer extends StepVoice {
  text: string;
  cut?: boolean;
  announce?: boolean;
}

/**
 * A step's title and sentence. Stephen says both as the step arrives, and
 * the sentence lights up as he goes. Once something is done, his answer
 * takes the sentence's place, as in a conversation: the sentence fades at
 * once and the answer comes in, lit as he says it. The sentence keeps its
 * room, so nothing below moves. On a phone where the step does not fit,
 * the sentence makes way once said, giving its room to what the step
 * shows; an answer then takes only the room it needs.
 */
/** An answer said on its own, at the next natural break unless `cut`. */
const useAnswerSaid = (
  answer: Answer | undefined,
  alone: boolean,
  voice: StepVoice
): void => {
  useSay(answer?.text ?? "", {
    when: answer !== undefined && alone,
    soon: answer?.cut !== true,
    tone: answer?.tone ?? voice.tone,
    quick: answer?.quick ?? false,
  });
};

/**
 * What Stephen says of a step's heading: the line he arrives with (the
 * answer instead of the sentence, if it is already there when you come
 * back), said as the step fades in, a breath rather than a wait; said
 * again in another language, unless an answer came since, when only the
 * answer is. An answer that comes is said as one, and so is one
 * announced.
 */
const useHeadingSaid = ({
  title,
  sentence,
  answer,
  voice,
}: {
  title: string;
  sentence: string | undefined;
  answer: Answer | undefined;
  voice: StepVoice;
}) => {
  // oxlint-disable-next-line react/hook-use-state -- as it was on arrival, never set
  const [answeredOnArrival] = useState(answer !== undefined);
  const arrivingWith = answeredOnArrival ? answer : undefined;
  const { line, from } = stepLine(title, arrivingWith?.text ?? sentence);
  // oxlint-disable-next-line react/hook-use-state -- as it was on arrival, never set
  const [arrived] = useState(line);
  const seen = useContext(Seen);
  // Done again on this visit: his answer is said on its own, not his line again.
  const announced = answer?.announce === true;
  const alone = !answeredOnArrival || announced;
  useSay(line, {
    delay: 120,
    when:
      !seen &&
      (answer === undefined || answeredOnArrival || arrived === line) &&
      !(announced && arrived !== line),
    tone: arrivingWith?.tone ?? voice.tone,
    quick: arrivingWith === undefined ? voice.quick : arrivingWith.quick,
  });
  useAnswerSaid(answer, alone, voice);
  return { line, from, alone };
};

export const Heading = ({
  title,
  sentence,
  answer,
  voice = evenVoice,
}: {
  title: string;
  sentence?: string;
  answer?: Answer;
  voice?: StepVoice;
}) => {
  const heading = useRef<HTMLHeadingElement>(null);
  const paragraph = useRef<HTMLParagraphElement>(null);
  const { line, from, alone } = useHeadingSaid({
    title,
    sentence,
    answer,
    voice,
  });
  // A new step moves focus to its title, so a screen reader starts there, and the keys go on from it.
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);
  useExplainedAfter(line);
  const away = useMadeWay(line, answer === undefined, paragraph);
  const answerEntrance = useEntrance(
    answer?.text ?? "",
    "animate-in fade-in slide-in-from-bottom-1 duration-500"
  );
  return (
    <div className="flex flex-col gap-2">
      {/* A title that takes two lines breaks them evenly, never leaving one word alone on the second. */}
      <PageHeaderTitle ref={heading} tabIndex={-1}>
        {title}
      </PageHeaderTitle>
      {sentence === undefined ? null : (
        // Two lines kept in every language, and the sentence's own room once answered, so nothing below moves; once it made way, none.
        <p
          aria-live="polite"
          className={cn(
            "text-muted-foreground grid text-balance transition-all duration-500",
            away ? "overflow-hidden" : "min-h-10",
            away && answer === undefined && "h-0 opacity-0"
          )}
          ref={paragraph}
        >
          <span
            aria-hidden={answer === undefined ? undefined : true}
            className={cn(
              "col-start-1 row-start-1 transition-opacity",
              answer === undefined ? "duration-400" : "opacity-0 duration-200",
              away && answer !== undefined && "hidden"
            )}
          >
            <SpokenText from={from} line={line} text={sentence} />
          </span>
          {answer === undefined ? null : (
            <span
              className={cn(
                "col-start-1 row-start-1 self-center",
                answerEntrance
              )}
              key={answer.text}
            >
              {/* Said on its own, or as the end of the line he arrived with. */}
              <SpokenText
                from={alone ? 0 : from}
                line={alone ? answer.text : line}
                text={answer.text}
              />
            </span>
          )}
        </p>
      )}
    </div>
  );
};

/**
 * The main button of a step, which waits until the step has been explained
 * and then fades in. Never wider than a comfortable reach, centred under
 * the step however wide it is.
 */
export const Primary = ({
  children,
  busy = false,
  done = false,
  disabled = false,
  ready = true,
  onClick,
}: {
  children: ReactNode;
  busy?: boolean;
  done?: boolean;
  disabled?: boolean;
  /** Whether the step has what it needs beyond being explained, such as a language chosen. */
  ready?: boolean;
  onClick: () => void;
}) => {
  let icon: ReactNode = null;
  if (busy) {
    icon = <Spinner data-icon="inline-start" />;
  } else if (done) {
    icon = <CheckIcon data-icon="inline-start" />;
  }
  return (
    <Onward ready={ready}>
      <Button
        className="w-full max-w-sm"
        disabled={disabled || busy}
        onClick={onClick}
        size="xl"
        variant="highlight"
      >
        {icon}
        {children}
      </Button>
    </Onward>
  );
};

export const laterClass =
  "text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 rounded-sm underline-offset-4 outline-none hover:underline focus-visible:ring-3";

/** The small way past a step that can wait: a muted link, never a second button. */
export const LaterLink = ({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick: () => void;
}) => (
  <button className={laterClass} onClick={onClick} type="button">
    {children}
  </button>
);

/** That way past a step, on a line of its own: it waits with the main button. */
export const Later = (props: { children: ReactNode; onClick: () => void }) => (
  <Onward>
    <LaterLink {...props} />
  </Onward>
);

/** Grasp's support site, where every connection has a page of its own: what it reads, what it never reads, and how to take it away again. */
const supportUrl = "https://support.joingrasp.com";

/** The pages the onboarding links to, by what is connected on a step. */
const connectionPages = {
  /** The Microsoft or Google sign-in that tells who works where. */
  directory: "connections/sign-in",
  /** A staff list shared as a file. */
  staffList: "connections/staff-list",
  /** The places where documents live: SharePoint, Google Drive, Notion and the like. */
  documents: "connections/documents",
  /** Pulse, the app on the work laptops. */
  pulse: "connections/pulse",
  /** The HR platform: Personio, AFAS, HiBob and the like. */
  hr: "connections/hr",
} as const;

export type ConnectionPage = keyof typeof connectionPages;

/**
 * More about what a step connects, on Grasp's support site, in a new tab:
 * always underlined, so it is seen to be a link.
 */
export const SupportLink = ({
  page,
  children: label,
}: {
  page: ConnectionPage;
  children: string;
}) => {
  const { t } = useLingui();
  return (
    <a
      aria-label={t`${label}, on Grasp’s support site, in a new tab`}
      className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 rounded-sm underline underline-offset-4 outline-none focus-visible:ring-3"
      href={`${supportUrl}/${connectionPages[page]}`}
      rel="noopener noreferrer"
      target="_blank"
    >
      {label}
    </a>
  );
};

/** That link on a line of its own under a step: it waits with the step's way on. */
export const MoreAbout = (props: {
  page: ConnectionPage;
  children: string;
}) => (
  <Onward>
    <SupportLink {...props} />
  </Onward>
);

/**
 * The small lines under a step: a way past it, and more about what it
 * connects. Side by side where both fit, and under each other where they
 * do not. They wait with the step's way on.
 */
export const Asides = ({ children }: { children: ReactNode }) => (
  <Onward>
    <div className="flex w-full flex-wrap items-center justify-center gap-x-5 gap-y-2">
      {children}
    </div>
  </Onward>
);

/** A line that turns up on a step later on, said when it does, after what he is saying. */
export const Callout = ({
  text,
  tone = tones.even,
}: {
  text: string;
  tone?: Tone;
}) => {
  const seen = useContext(Seen);
  // oxlint-disable-next-line react/hook-use-state -- as it was on arrival, never set
  const [arrived] = useState(text);
  // On a step seen before, only a line that changed on this visit is said.
  useSay(text, { after: true, tone, when: !seen || text !== arrived });
  const entrance = useEntrance(text, "animate-in fade-in duration-500");
  return (
    <p className={entrance}>
      <SpokenText from={0} line={text} text={text} />
    </p>
  );
};

/** How long a line that follows a choice waits, in ms: a breath after the step's own line. */
const followsMs = 200;

/**
 * A line that follows what is chosen on a step, such as when the links go
 * out: said after what he is saying, and said again when the choice
 * changes it. A line changed again before its turn came is not said, so
 * quick choices never pile up behind him.
 */
export const useSayFollowing = (
  text: string,
  { tone = tones.even, quick = false }: StepVoice = {}
): void => {
  const shown = useRef(text);
  const seen = useContext(Seen);
  // oxlint-disable-next-line react/hook-use-state -- as it was on arrival, never set
  const [arrived] = useState(text);
  // On a step seen before, it is said only once a choice changes it.
  const quiet = seen && text === arrived;
  useEffect(() => {
    shown.current = text;
    const id = quiet
      ? undefined
      : window.setTimeout(() => {
          speak(text, {
            after: true,
            tone,
            quick,
            still: () => shown.current === text,
          });
        }, followsMs);
    return () => {
      window.clearTimeout(id);
    };
  }, [text, tone, quick, quiet]);
};

/** A number with what it counts. */
export const Figure = ({ value, label }: { value: string; label: string }) => (
  <div className="flex flex-col rounded-xl border p-4">
    <Stat>{value}</Stat>
    <span className="text-muted-foreground">{label}</span>
  </div>
);
