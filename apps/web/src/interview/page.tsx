import { interviewPhases } from "@grasp-os/shared/interview-links";
import type {
  InterviewLine,
  InterviewProgress,
} from "@grasp-os/shared/interview-links";
import type { InterviewPhase } from "@grasp-os/shared/interview-turn";
import { interviewerNames } from "@grasp-os/shared/onboarding";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ReactNode, RefObject } from "react";

import { ErrorText } from "../error-text.tsx";
import { formatDay } from "../format.ts";
import { Button } from "../grasp/button/index.ts";
import { Heading } from "../grasp/heading/index.ts";
import { visuallyHidden } from "../grasp/hidden/hidden.ts";
import { Chat, Cross } from "../grasp/icons/index.ts";
import { arrive } from "../grasp/motion/arrive.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp, media } from "../grasp/tokens/tokens.stylex.ts";
import { isLocale } from "../i18n.ts";
import { LanguageButton } from "../language-picker.tsx";
import { deleteInterview, isRefused, withdrawInterview } from "./api.ts";
import type { OpenSession } from "./api.ts";
import { Before } from "./before.tsx";
import { Closed, DeleteInterview } from "./closed.tsx";
import { Composer, SaveNote, SaveTrouble } from "./composer.tsx";
import { Head, headSizes, useHead } from "./head.tsx";
import { voice } from "./interview.stylex.ts";
import {
  forgetInterview,
  keepNow,
  linkNow,
  onTaken,
  update,
  useInterviewer,
  useProgress,
} from "./kept.ts";
import { fullWidth, looks } from "./looks.ts";
import {
  sendTyped,
  setLoopWords,
  startLoop,
  stopLoop,
  useLoop,
} from "./loop.ts";
import { Mark } from "./mark.tsx";
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

const styles = stylex.create({
  frame: {
    display: "flex",
    flexDirection: "column",
    height: "100svh",
    overflow: "hidden",
    backgroundColor: grasp.paper,
    color: grasp.text,
  },
  header: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: grasp.space3,
    height: "4.5rem",
    paddingInline: { default: grasp.space4, [media.fromPhone]: grasp.space10 },
  },
  side: { display: "flex", flexGrow: 1, flexBasis: 0 },
  start: { justifyContent: "flex-start" },
  end: { justifyContent: "flex-end" },
  main: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    // Centred while it fits; on a window too low for it, it scrolls in its own room and never runs under the foot.
    justifyContent: "safe center",
    flexGrow: 1,
    minHeight: 0,
    overflowY: "auto",
    paddingInline: grasp.space4,
  },
  // Room under the stage for their words, which float up from the box.
  overBox: { paddingBlockEnd: "7rem" },
  footer: {
    display: "flex",
    flexShrink: 0,
    flexDirection: { default: "column", [media.fromPhone]: "row" },
    alignItems: { default: "stretch", [media.fromPhone]: "flex-end" },
    gap: { default: grasp.space3, [media.fromPhone]: grasp.space4 },
    paddingInline: { default: grasp.space4, [media.fromPhone]: grasp.space10 },
    paddingBlockStart: grasp.space2,
    paddingBlockEnd: grasp.space5,
  },
  box: {
    width: "100%",
    minWidth: 0,
    order: { default: null, [media.fromPhone]: 2 },
    maxWidth: { default: null, [media.fromPhone]: "36rem" },
  },
  // On a phone the mark and the language share a row under the box; wider, they stand at its sides.
  corners: {
    display: { default: "flex", [media.fromPhone]: "contents" },
    alignItems: "center",
    justifyContent: "space-between",
  },
  corner: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    height: "3.5rem",
  },
  cornerStart: {
    order: { default: null, [media.fromPhone]: 1 },
    flexGrow: { default: null, [media.fromPhone]: 1 },
    flexBasis: { default: null, [media.fromPhone]: 0 },
  },
  cornerEnd: {
    justifyContent: "flex-end",
    order: { default: null, [media.fromPhone]: 3 },
    flexGrow: { default: null, [media.fromPhone]: 1 },
    flexBasis: { default: null, [media.fromPhone]: 0 },
  },
  // The stage, over the box and what floats up from it.
  stage: {
    position: "relative",
    zIndex: 1,
    display: "flex",
    justifyContent: "center",
    width: "100%",
    opacity: 1,
    transitionProperty: "opacity",
    transitionDuration: grasp.durationUi,
    transitionTimingFunction: grasp.ease,
  },
  away: { opacity: 0 },
  shown: { display: "flex", justifyContent: "center", width: "100%" },
  phases: { display: "flex", alignItems: "center", gap: grasp.space1 },
  phase: {
    display: "block",
    width: "0.375rem",
    height: "0.375rem",
    borderRadius: grasp.cornerPill,
    backgroundColor: grasp.line,
    transitionProperty: "width, background-color",
    transitionDuration: grasp.durationUi,
    transitionTimingFunction: grasp.ease,
  },
  phaseDone: { backgroundColor: grasp.ink },
  phaseNow: { width: "1.25rem", backgroundColor: grasp.ink },
  // Something new is marked in the transcript.
  fresh: {
    display: "inline-block",
    width: "0.375rem",
    height: "0.375rem",
    marginInlineStart: grasp.space1,
    borderRadius: grasp.cornerCircle,
    backgroundColor: voice.heat,
  },
  failed: { paddingBlockStart: grasp.space4 },
});

/** Room kept free over the box, for their words that show there. */
const overBox = 112;

/** From this wide the transcript has room beside the stage. */
const beside = "(min-width: 80rem)";

const onBeside = (listener: () => void): (() => void) => {
  const query = window.matchMedia(beside);
  query.addEventListener("change", listener);
  return () => {
    query.removeEventListener("change", listener);
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
      <span {...stylex.props(visuallyHidden)}>
        {t`Part ${n} of ${parts}: ${label}`}
      </span>
      <div aria-hidden="true" {...stylex.props(styles.phases)}>
        {interviewPhases.map((each, index) => (
          <span
            key={each}
            {...stylex.props(
              styles.phase,
              index < at && styles.phaseDone,
              index === at && styles.phaseNow
            )}
          />
        ))}
      </div>
    </div>
  );
};

/** A screen of the interview with whoever holds it over what it says: after it, or instead of it. */
const Said = ({
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
    <div {...stylex.props(looks.screen, looks.narrow)}>
      <Head fill={fill} label={label} sign={sign} size={size} who={who} />
      <div ref={body} {...stylex.props(looks.body)}>
        {children}
      </div>
    </div>
  );
};

/** The frame of every screen of the link: as little as possible around the stage. */
const InterviewFrame = ({
  top,
  bottom,
  left,
  middle,
  right,
  box,
  open = false,
  children,
}: {
  /**
   * Whether the interview is open on this device, so what they say is
   * kept: only then does the frame say "Saved". A link that can't be
   * opened, or is open elsewhere, has kept nothing here.
   */
  open?: boolean;
  /** Where the frame's top and bottom are measured, so the stage takes what is left. */
  top: RefObject<HTMLElement | null>;
  bottom: RefObject<HTMLElement | null>;
  left?: ReactNode;
  middle?: ReactNode;
  right?: ReactNode;
  box?: ReactNode;
  children: ReactNode;
}) => (
  <div {...stylex.props(styles.frame)}>
    <header ref={top} {...stylex.props(styles.header)}>
      <div {...stylex.props(styles.side, styles.start)}>{left}</div>
      {middle}
      <div {...stylex.props(styles.side, styles.end)}>{right}</div>
    </header>
    <main {...stylex.props(styles.main, box !== undefined && styles.overBox)}>
      {children}
    </main>
    <footer ref={bottom} {...stylex.props(styles.footer)}>
      {box === undefined ? null : (
        <div {...stylex.props(styles.box)}>{box}</div>
      )}
      <div {...stylex.props(styles.corners)}>
        <div {...stylex.props(styles.corner, styles.cornerStart)}>
          <Mark />
          {open ? <SaveNote /> : null}
        </div>
        <div {...stylex.props(styles.corner, styles.cornerEnd)}>
          <LanguageButton />
        </div>
      </div>
    </footer>
  </div>
);

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
      <div {...stylex.props(looks.words)}>
        <Heading level={1} size="md">
          {t`Your place is kept.`}
        </Heading>
        <Text tone="muted">
          {t`Open this link again whenever you like, and carry on where you stopped.`}
        </Text>
      </div>
      <div {...stylex.props(looks.actions)}>
        <Button
          layout={fullWidth.button}
          onClick={onCarryOn}
          size="lg"
          variant="ink"
        >
          {t`Carry on now`}
        </Button>
      </div>
    </Said>
  );
};

/** The interviews are over: what was said can be deleted, no more. */
const Over = ({ room }: { room: number }) => {
  const { t } = useLingui();
  const who = interviewerNames[useInterviewer()];
  return (
    <Said fill={1} label={t`${who}, drawn in dots.`} room={room} sign="heart">
      <div {...stylex.props(looks.words)}>
        <Heading level={1} size="md">
          {t`The interviews are over.`}
        </Heading>
        <Text tone="muted">{t`Thank you for your time.`}</Text>
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
      <div aria-live="polite">
        <Heading level={1} size="md">
          {t`Deleted. Nothing you said is kept.`}
        </Heading>
      </div>
    </Said>
  );
};

/** They withdrew: what they said stays theirs to read and delete, and nothing of it is used. */
const Withdrawn = ({ room }: { room: number }) => {
  const { t } = useLingui();
  const who = interviewerNames[useInterviewer()];
  return (
    <Said label={t`${who}, drawn in dots.`} room={room}>
      <div aria-live="polite" {...stylex.props(looks.words)}>
        <Heading level={1} size="md">
          {t`You withdrew. Nothing you said is used from now on.`}
        </Heading>
        <Text tone="muted">
          {t`It stays here for you to read. You can still delete it.`}
        </Text>
      </div>
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
      icon={Chat}
      onClick={onToggle}
      size="sm"
      title={t`Transcript`}
      variant="ghost"
    >
      {[
        <span key="words" {...stylex.props(looks.wideOnly)}>
          {t`Transcript`}
        </span>,
        ...(fresh
          ? [
              <span
                aria-hidden="true"
                key="dot"
                {...stylex.props(styles.fresh)}
              />,
              <span key="said" {...stylex.props(visuallyHidden)}>
                {t`Something new is marked`}
              </span>,
            ]
          : []),
      ]}
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
  withdrawn,
  onCarryOn,
}: {
  session: OpenSession;
  room: number;
  reading: boolean;
  stopped: boolean;
  deleted: boolean;
  withdrawn: boolean;
  onCarryOn: () => void;
}) => {
  const progress = useProgress();
  const started = progress.person !== "invited" && progress.person !== "opened";
  let stage: ReactNode;
  let key: string;
  if (deleted) {
    stage = <Deleted room={room} />;
    key = "deleted";
  } else if (withdrawn) {
    stage = <Withdrawn room={room} />;
    key = "withdrawn";
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
  } else if (!(started && progress.told)) {
    // Not started, or core doesn't hold that they agreed to take part, to
    // what this is as it says now: they read it, and agree, first.
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
    <div key={key} {...stylex.props(styles.shown, arrive.in)}>
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
    <Button
      icon={Cross}
      onClick={onStop}
      size="sm"
      title={t`Stop for now`}
      variant="ghost"
    >
      <span {...stylex.props(looks.wideOnly)}>{t`Stop for now`}</span>
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

/** In the conversation, and core holds that they agreed to take part. */
const inConversation = (progress: InterviewProgress): boolean =>
  isTalking(progress) && progress.told;

/** Whether there is an interview to delete: something said, and it is agreed to, over or withdrawn from. */
const deletable = (progress: InterviewProgress, ended: boolean): boolean =>
  (progress.person === "completed" || ended) && progress.lines.length > 0;

/** Why deleting or withdrawing didn't work, when it didn't. */
const Failed = ({ message }: { message: string | null }) =>
  message === null ? null : (
    <div {...stylex.props(styles.failed)}>
      <ErrorText>{message}</ErrorText>
    </div>
  );

/** Withdrawing is offered while they take part and haven't withdrawn. */
const withdrawOffered = (
  withdrawn: boolean,
  told: boolean,
  withdraw: () => Promise<void>
): (() => void) | undefined =>
  withdrawn || !told
    ? undefined
    : () => {
        void withdraw();
      };

/** Withdrawing: whether they did, and why it didn't work when it didn't. */
const useWithdrawing = (session: OpenSession) => {
  const [withdrawn, setWithdrawn] = useState(session.withdrawn);
  const [withdrawFailed, setWithdrawFailed] = useState<string | null>(null);
  const withdraw = async (): Promise<void> => {
    const link = linkNow();
    if (link === null) {
      return;
    }
    const answer = await withdrawInterview(link.secret, link.key);
    if (isRefused(answer)) {
      setWithdrawFailed(answer.message);
      return;
    }
    setWithdrawFailed(null);
    setWithdrawn(true);
  };
  return { withdrawn, withdrawFailed, withdraw };
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
  const { withdrawn, withdrawFailed, withdraw } = useWithdrawing(session);
  const [transcript, setTranscript] = useState(false);
  const talking =
    inConversation(progress) &&
    !(stopped || withdrawn || session.closed) &&
    deleted === "no";
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
    deleted !== "yes" && deletable(progress, session.closed || withdrawn);

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
        onWithdraw={withdrawOffered(withdrawn, progress.told, withdraw)}
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
      open
      right={right}
      top={top}
    >
      {/* The stage stands over the box and what floats up from it. Where there's no room beside it, it makes way for the transcript. */}
      <div inert={away} {...stylex.props(styles.stage, away && styles.away)}>
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
          withdrawn={withdrawn}
        />
      </div>
      <Failed message={deleteFailed ?? withdrawFailed} />
      <Transcript alone={away} lines={progress.lines} open={floating} />
    </InterviewFrame>
  );
};
