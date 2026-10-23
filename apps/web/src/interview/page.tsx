import { interviewPhases } from "@grasp-os/shared/interview-links";
import type { InterviewLine } from "@grasp-os/shared/interview-links";
import type { InterviewPhase } from "@grasp-os/shared/interview-turn";
import { interviewerNames } from "@grasp-os/shared/onboarding";
import { Button } from "@grasp-os/ui/components/button";
import { cn } from "@grasp-os/ui/lib/utils";
import { useLingui } from "@lingui/react/macro";
import { MessagesSquareIcon, XIcon } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ReactNode, RefObject } from "react";

import { formatDay } from "../format.ts";
import { GraspMark } from "../grasp-mark.tsx";
import { isLocale } from "../i18n.ts";
import { LanguageButton } from "../language-picker.tsx";
import { deleteInterview, isRefused } from "./api.ts";
import type { OpenSession } from "./api.ts";
import { Before } from "./before.tsx";
import { Closed, DeleteInterview } from "./closed.tsx";
import { Composer, SaveNote, SaveTrouble } from "./composer.tsx";
import { Head, headSizes, useHead } from "./head.tsx";
import {
  forgetInterview,
  keepNow,
  linkNow,
  onTaken,
  update,
  useInterviewer,
  useProgress,
} from "./kept.ts";
import {
  sendTyped,
  setLoopWords,
  startLoop,
  stopLoop,
  useLoop,
} from "./loop.ts";
import {
  begun,
  isReading,
  isTalking,
  leftFor,
  rated,
  reopened,
  resumed,
} from "./progress.ts";
import { ReadBack } from "./read-back.tsx";
import { Talk } from "./talk.tsx";
import { Transcript, transcriptId } from "./transcript.tsx";
import { useInterviewWords, useLoopWords } from "./words.ts";

// Someone's interview, as their own link opens it (prototype
// `interview-view.tsx`): full screen, outside the app, as calm as the
// onboarding. Before it, the language, Stephen or Claire, what this is and
// a sound check (before.tsx). Then whoever they chose in the middle, the
// line lighting up as it is said; the box to type in at the bottom, a
// voice bar while he talks for whoever chose to talk, their own words as a
// bubble over it; the parts of the interview as a row of marks at the top;
// top left the way out for now, which keeps their place; top right the
// transcript, which floats at the right side. Last he reads back what he
// wrote down, a few lines at a time; what they leave in is what counts.
// Nothing on the page scrolls.

/** Room kept free over the box, for their words that show there. */
const overBox = 112;

/** From this wide the transcript has room beside the stage. */
const beside = "(min-width: 80rem)";

const onBeside = (listener: () => void): (() => void) => {
  const media = window.matchMedia(beside);
  media.addEventListener("change", listener);
  return () => {
    media.removeEventListener("change", listener);
  };
};

const onResize = (listener: () => void): (() => void) => {
  window.addEventListener("resize", listener);
  return () => {
    window.removeEventListener("resize", listener);
  };
};

/**
 * The height the stage has between the top and the bottom of the frame,
 * less `around`: so what is on stage is sized to fit, and nothing scrolls.
 */
const useStageRoom = (around: number) => {
  const top = useRef<HTMLElement>(null);
  const bottom = useRef<HTMLElement>(null);
  const [edges, setEdges] = useState(0);
  useLayoutEffect(() => {
    const measure = (): void => {
      setEdges(
        (top.current?.offsetHeight ?? 0) + (bottom.current?.offsetHeight ?? 0)
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (top.current !== null) {
      observer.observe(top.current);
    }
    if (bottom.current !== null) {
      observer.observe(bottom.current);
    }
    return () => {
      observer.disconnect();
    };
  }, []);
  const height = useSyncExternalStore(onResize, () => window.innerHeight);
  return { top, bottom, room: height - edges - around };
};

/** Where the interview is: its parts as a row of marks, with no words on screen. */
const PhaseBar = ({ phase }: { phase: InterviewPhase }) => {
  const { t } = useLingui();
  const label = useInterviewWords().phase[phase];
  const at = interviewPhases.indexOf(phase);
  const n = at + 1;
  const parts = interviewPhases.length;
  return (
    <div>
      <span className="sr-only">{t`Part ${n} of ${parts}: ${label}`}</span>
      <div aria-hidden="true" className="flex items-center gap-1">
        {interviewPhases.map((each, index) => (
          <span
            className={cn(
              "block h-1.5 rounded-full transition-all duration-300",
              index === at && "bg-foreground w-5",
              index < at && "bg-foreground w-1.5",
              index > at && "bg-border w-1.5"
            )}
            key={each}
          />
        ))}
      </div>
    </div>
  );
};

/** A screen of the interview with whoever holds it over what it says: after it, or instead of it. */
export const Said = ({
  room,
  sign = null,
  fill = 0.35,
  label,
  children,
}: {
  room: number;
  sign?: "question" | "heart" | "check" | null;
  fill?: number;
  label: string;
  children: ReactNode;
}) => {
  const { body, size } = useHead(room, headSizes.talking);
  const who = useInterviewer();
  return (
    <div className="flex w-full max-w-md flex-col items-center gap-6 text-center">
      <Head fill={fill} label={label} sign={sign} size={size} who={who} />
      <div className="flex w-full flex-col items-center gap-6" ref={body}>
        {children}
      </div>
    </div>
  );
};

/** The frame of every screen of the link: as little as possible around the stage. */
export const InterviewFrame = ({
  top,
  bottom,
  left,
  middle,
  right,
  box,
  children,
}: {
  /** Where the frame's top and bottom are measured, so the stage takes what is left. */
  top: RefObject<HTMLElement | null>;
  bottom: RefObject<HTMLElement | null>;
  left?: ReactNode;
  middle?: ReactNode;
  right?: ReactNode;
  box?: ReactNode;
  children: ReactNode;
}) => (
  <div className="bg-background flex h-svh flex-col overflow-hidden text-sm">
    <header
      className="flex h-18 flex-none items-center gap-3 px-4 sm:px-10"
      ref={top}
    >
      <div className="flex flex-1 basis-0 justify-start">{left}</div>
      {middle}
      <div className="flex flex-1 basis-0 justify-end">{right}</div>
    </header>
    <main
      className={cn(
        "relative flex min-h-0 flex-1 flex-col items-center justify-center px-4",
        box !== undefined && "pb-28"
      )}
    >
      {children}
    </main>
    <footer
      className="flex flex-none flex-col gap-3 px-4 pt-2 pb-5 sm:flex-row sm:items-end sm:gap-4 sm:px-10"
      ref={bottom}
    >
      {box === undefined ? null : (
        <div className="w-full min-w-0 sm:order-2 sm:max-w-xl">{box}</div>
      )}
      <div className="flex items-center justify-between sm:contents">
        <div className="flex h-14 items-center gap-2 sm:order-1 sm:flex-1 sm:basis-0">
          <GraspMark className="text-foreground size-5 flex-none" />
          <SaveNote />
        </div>
        <div className="flex h-14 items-center justify-end sm:order-3 sm:flex-1 sm:basis-0">
          <LanguageButton />
        </div>
      </div>
    </footer>
  </div>
);

/** Room over the stage for a screen without the box. */
export const useQuietRoom = () => useStageRoom(16);

/** They stopped for now: their place is kept. */
const Stopped = ({
  room,
  onCarryOn,
}: {
  room: number;
  onCarryOn: () => void;
}) => {
  const { t } = useLingui();
  const who = interviewerNames[useInterviewer()];
  return (
    <Said label={t`${who}, drawn in dots.`} room={room}>
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-medium tracking-tight text-balance">
          {t`Your place is kept.`}
        </h1>
        <p className="text-muted-foreground text-balance">
          {t`Open this link again whenever you like, and carry on where you stopped.`}
        </p>
      </div>
      <Button className="w-full max-w-sm" onClick={onCarryOn} size="xl">
        {t`Carry on now`}
      </Button>
    </Said>
  );
};

/** The interviews are over: what was said can be deleted, no more. */
const Over = ({ room }: { room: number }) => {
  const { t } = useLingui();
  const who = interviewerNames[useInterviewer()];
  return (
    <Said fill={1} label={t`${who}, drawn in dots.`} room={room} sign="heart">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-medium tracking-tight text-balance">
          {t`The interviews are over.`}
        </h1>
        <p className="text-muted-foreground text-balance">
          {t`Thank you for your time.`}
        </p>
      </div>
    </Said>
  );
};

/** They deleted it. */
const Deleted = ({ room }: { room: number }) => {
  const { t } = useLingui();
  const who = interviewerNames[useInterviewer()];
  return (
    <Said label={t`${who}, drawn in dots.`} room={room}>
      <h1
        aria-live="polite"
        className="text-2xl font-medium tracking-tight text-balance"
      >
        {t`Deleted. Nothing you said is kept.`}
      </h1>
    </Said>
  );
};

/**
 * Runs the conversation until stopped; a moment after, so a screen that
 * only flashes by asks nothing.
 */
const runLoop = (): (() => void) => {
  const id = window.setTimeout(startLoop, 80);
  const stopTaken = onTaken(() => {
    // The copy kept elsewhere is the interview now: the conversation goes on from it.
    stopLoop({ keep: false });
    startLoop();
  });
  return () => {
    window.clearTimeout(id);
    stopTaken();
    stopLoop();
  };
};

/** Does `then` when Escape is pressed, wherever the cursor is, until stopped. */
const onEscape = (then: () => void): (() => void) => {
  const putAway = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      then();
    }
  };
  window.addEventListener("keydown", putAway);
  return () => {
    window.removeEventListener("keydown", putAway);
  };
};

/** The button top right that shows the transcript, with a dot when something new is marked. */
const TranscriptButton = ({
  open,
  fresh,
  onToggle,
}: {
  open: boolean;
  fresh: boolean;
  onToggle: () => void;
}) => {
  const { t } = useLingui();
  return (
    <Button
      aria-controls={transcriptId}
      aria-expanded={open}
      onClick={onToggle}
      size="sm"
      title={t`Transcript`}
      variant="ghost"
    >
      <MessagesSquareIcon data-icon="inline-start" />
      <span className="sr-only sm:not-sr-only">{t`Transcript`}</span>
      {fresh ? (
        <>
          <span
            aria-hidden="true"
            className="bg-brain-heat size-1.5 rounded-full"
          />
          <span className="sr-only">{t`Something new is marked`}</span>
        </>
      ) : null}
    </Button>
  );
};

/** What stands in the middle: before the interview, in it, after it, or instead of it. */
const Stage = ({
  session,
  room,
  reading,
  stopped,
  deleted,
  onCarryOn,
}: {
  session: OpenSession;
  room: number;
  reading: boolean;
  stopped: boolean;
  deleted: boolean;
  onCarryOn: () => void;
}) => {
  const progress = useProgress();
  const started = progress.person !== "invited" && progress.person !== "opened";
  let stage: ReactNode;
  let key: string;
  if (deleted) {
    stage = <Deleted room={room} />;
    key = "deleted";
  } else if (session.closed) {
    stage = <Over room={room} />;
    key = "over";
  } else if (stopped) {
    stage = <Stopped onCarryOn={onCarryOn} room={room} />;
    key = "stopped";
  } else if (progress.person === "completed") {
    stage = (
      <Closed
        closes={formatDay(session.closes)}
        name={session.name}
        onAdd={() => {
          update(reopened);
        }}
        onRate={(rating) => {
          update((now) => rated(now, rating));
          keepNow();
        }}
        rating={progress.rating}
        room={room}
      />
    );
    key = "closed";
  } else if (!started) {
    stage = (
      <Before
        kind={session.kind}
        name={session.name}
        onStart={(by) => {
          update((now) => begun(now, Date.now(), by));
        }}
        room={room}
      />
    );
    key = "before";
  } else if (reading) {
    stage = <ReadBack room={room} />;
    key = `part-${progress.confirmed}`;
  } else {
    stage = <Talk phase={progress.phase} room={room} />;
    key = "talk";
  }
  return (
    <div
      className="animate-in fade-in flex w-full justify-center duration-500"
      key={key}
    >
      {stage}
    </div>
  );
};

/** The box at the bottom, with what they must know about saving over it. */
const AnswerBox = ({ reading }: { reading: boolean }) => {
  const { t } = useLingui();
  const loop = useLoop();
  const words = useInterviewWords();
  const { mode } = useProgress();
  return (
    <>
      <SaveTrouble />
      <Composer
        doing={loop.doing}
        line={loop.saying}
        names={words.tag}
        onSend={sendTyped}
        placeholder={
          reading ? t`Type what is missing, or yes` : t`Type your answer`
        }
        said={loop.said}
        talking={mode === "talk"}
      />
    </>
  );
};

/** The way out for now, top left: on a phone its sign alone, so the parts stay in the middle. */
const StopButton = ({ onStop }: { onStop: () => void }) => {
  const { t } = useLingui();
  return (
    <Button onClick={onStop} size="sm" title={t`Stop for now`} variant="ghost">
      <XIcon data-icon="inline-start" />
      <span className="sr-only sm:not-sr-only">{t`Stop for now`}</span>
    </Button>
  );
};

/** How many things Stephen marked in what was said. */
const markedIn = (lines: InterviewLine[]): number => {
  let count = 0;
  for (const { marks } of lines) {
    count += marks?.length ?? 0;
  }
  return count;
};

/** Deleting the interview: whether it is, and why it didn't work when it didn't. */
const useDeleting = () => {
  const [deleted, setDeleted] = useState<"no" | "deleting" | "yes">("no");
  const [deleteFailed, setDeleteFailed] = useState<string | null>(null);
  const remove = async (): Promise<void> => {
    const link = linkNow();
    if (link === null) {
      return;
    }
    setDeleted("deleting");
    const answer = await deleteInterview(link.secret, link.key);
    if (isRefused(answer)) {
      setDeleted("no");
      setDeleteFailed(answer.message);
      return;
    }
    forgetInterview();
    setDeleteFailed(null);
    setDeleted("yes");
  };
  return { deleted, deleteFailed, remove };
};

/** What the conversation says by itself follows the language on screen. */
const useWordsOnScreen = (): void => {
  const { i18n } = useLingui();
  const loopWords = useLoopWords(isLocale(i18n.locale) ? i18n.locale : "en");
  useEffect(() => {
    setLoopWords(loopWords);
  });
};

/** The interview on the link, held on this device. */
export const InterviewPage = ({ session }: { session: OpenSession }) => {
  const progress = useProgress();
  const [stopped, setStopped] = useState(false);
  const { deleted, deleteFailed, remove } = useDeleting();
  const [transcript, setTranscript] = useState(false);
  const talking =
    isTalking(progress) && !stopped && deleted === "no" && !session.closed;
  const reading = talking && isReading(progress);
  const { top, bottom, room } = useStageRoom(talking ? overBox + 8 : 16);

  useWordsOnScreen();
  // The conversation runs while it is on screen; a moment after, so a screen that only flashes by asks nothing.
  useEffect(() => (talking ? runLoop() : undefined), [talking]);

  // The transcript goes with the conversation; Escape puts it away.
  const floating = transcript && talking;
  const besideStage = useSyncExternalStore(
    onBeside,
    () => window.matchMedia(beside).matches
  );
  const away = floating && !besideStage;
  useEffect(
    () =>
      floating
        ? onEscape(() => {
            setTranscript(false);
          })
        : undefined,
    [floating]
  );
  // What he marked so far, and how much of it was looked at.
  const marked = markedIn(progress.lines);
  const [seen, setSeen] = useState(marked);
  const canDelete =
    deleted !== "yes" &&
    (progress.person === "completed" || session.closed) &&
    progress.lines.length > 0;

  let right: ReactNode = null;
  if (talking) {
    right = (
      <TranscriptButton
        fresh={marked > seen && !transcript}
        onToggle={() => {
          setSeen(marked);
          setTranscript(!transcript);
        }}
        open={transcript}
      />
    );
  } else if (canDelete) {
    right = (
      <DeleteInterview
        onDelete={() => {
          void remove();
        }}
      />
    );
  }

  return (
    <InterviewFrame
      bottom={bottom}
      box={talking ? <AnswerBox reading={reading} /> : undefined}
      left={
        talking ? (
          <StopButton
            onStop={() => {
              update(leftFor);
              keepNow();
              setTranscript(false);
              setStopped(true);
            }}
          />
        ) : null
      }
      middle={
        talking ? (
          <PhaseBar phase={reading ? "readback" : progress.phase} />
        ) : null
      }
      right={right}
      top={top}
    >
      {/* The stage stands over the box and what floats up from it. Where there's no room beside it, it makes way for the transcript. */}
      <div
        className={cn(
          "relative z-10 flex w-full justify-center transition-opacity duration-300",
          away && "opacity-0"
        )}
        inert={away}
      >
        <Stage
          deleted={deleted === "yes"}
          onCarryOn={() => {
            update(resumed);
            setStopped(false);
          }}
          reading={reading}
          room={room}
          session={session}
          stopped={stopped}
        />
      </div>
      {deleteFailed === null ? null : (
        <p className="text-destructive pt-4 text-sm" role="alert">
          {deleteFailed}
        </p>
      )}
      <Transcript alone={away} lines={progress.lines} open={floating} />
    </InterviewFrame>
  );
};
