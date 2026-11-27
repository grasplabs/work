import type { InterviewProgress } from "@grasp-os/shared/interview-links";
import { interviewerNames } from "@grasp-os/shared/onboarding";
import { Button } from "@grasp-os/ui/components/button";
import { Icon, MessageSquareIcon, PauseIcon } from "@grasp-os/ui/lib/icons";
import { useLingui } from "@lingui/react/macro";
import {
  isValidElement,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import type { ReactNode } from "react";

import { formatDay } from "../format.ts";
import { TopError } from "../frame/top-error.tsx";
import { isLocale } from "../i18n.ts";
import type { Pose } from "../onboarding/field/engine.ts";
import { beside } from "../onboarding/field/poses.ts";
import {
  deleteInterview,
  isRefused,
  participate,
  remindLater,
  withdrawInterview,
} from "./api.ts";
import type { OpenSession } from "./api.ts";
import { Page, Words } from "./calm.tsx";
import { Closed, DeleteInterview } from "./closed.tsx";
import { besideQuery, Conversation, TimeUp } from "./conversation.tsx";
import {
  Countdown,
  secondsLeft,
  useCountdownMarks,
  useNow,
} from "./countdown.tsx";
import { DevJump } from "./dev-jump.tsx";
import { Frame, tool } from "./frame.tsx";
import { useGuided } from "./guide.tsx";
import {
  forgetInterview,
  keepNow,
  linkNow,
  onTaken,
  update,
  useInterviewer,
  useProgress,
} from "./kept.ts";
import { setLoopName, setLoopWords, startLoop, stopLoop } from "./loop.ts";
import { reachMic } from "./mic.ts";
import {
  begun,
  feedbackGiven,
  isReading,
  isTalking,
  leftFor,
  rated,
  reopened,
  resumed,
  steered,
  ticked,
} from "./progress.ts";
import { readingPose } from "./read-back-story.tsx";
import { setSound } from "./speech.ts";
import {
  Consent,
  NotNow,
  PickLanguage,
  remindTimes,
  Reminded,
} from "./start.tsx";
import type { RemindAt } from "./start.tsx";
import { useLoopWords } from "./words.ts";

// Someone's interview, as their own link opens it: full screen, outside
// the app, in the calm frame (frame.tsx). First one screen to agree, with
// its quiet way out (start.tsx); then the conversation, Stephen's line
// on a stage over the card they answer in, the minutes left over it
// (conversation.tsx); at the end of the minutes, or when Stephen gets
// there, the read-back; then his thanks (closed.tsx). The header holds the
// transcript and the pause while they talk, and the way to delete what was
// said once there is something to delete. Nothing on the page scrolls but
// a screen's own room.

/** Where they are before the conversation: the start, or one of its ways out. */
type Before =
  | { at: "language" }
  | { at: "start" }
  | { at: "not-now" }
  | { at: "reminded"; picked: RemindAt };

const onBeside = (listener: () => void): (() => void) => {
  const query = window.matchMedia(besideQuery);
  query.addEventListener("change", listener);
  return () => {
    query.removeEventListener("change", listener);
  };
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

/** In the conversation, and core holds that they agreed to take part. */
const inConversation = (progress: InterviewProgress): boolean =>
  isTalking(progress) && progress.told;

/**
 * Whether there is an interview to delete: something said, and it is
 * agreed to, over or withdrawn from; never once the link only reads.
 */
const deletable = (
  progress: InterviewProgress,
  ended: boolean,
  readOnly: boolean
): boolean =>
  !readOnly &&
  (progress.person === "completed" || ended) &&
  progress.lines.length > 0;

/** Deleting the interview: whether it is, and why it didn't work when it didn't. */
const useDeleting = () => {
  const [deleted, setDeleted] = useState<"no" | "deleting" | "yes">("no");
  const [removingDeleted, setRemovingDeleted] = useState(false);
  const [deleteFailed, setDeleteFailed] = useState<string | null>(null);
  const remove = async (): Promise<void> => {
    const link = linkNow();
    if (link === null) {
      return;
    }
    setDeleted("deleting");
    const answer = await deleteInterview(link.secret);
    if (isRefused(answer)) {
      setDeleted("no");
      setDeleteFailed(answer.message);
      return;
    }
    forgetInterview();
    setDeleteFailed(null);
    setRemovingDeleted(answer.removing === true);
    setDeleted("yes");
  };
  return { deleted, removingDeleted, deleteFailed, remove };
};

/** Withdrawing: whether they did, and why it didn't work when it didn't. */
const useWithdrawing = (session: OpenSession) => {
  const [withdrawn, setWithdrawn] = useState(session.withdrawn);
  // Still being removed, as core said when the page opened, until it isn't.
  const [removing, setRemoving] = useState(session.removing);
  const [withdrawFailed, setWithdrawFailed] = useState<string | null>(null);
  const withdraw = async (): Promise<void> => {
    const link = linkNow();
    if (link === null) {
      return;
    }
    const answer = await withdrawInterview(link.secret);
    if (isRefused(answer)) {
      setWithdrawFailed(answer.message);
      return;
    }
    setWithdrawFailed(null);
    setRemoving(answer.removing === true);
    setWithdrawn(true);
  };
  return { withdrawn, removing, withdrawFailed, withdraw };
};

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

/** What the conversation says by itself follows the language on screen. */
const useWordsOnScreen = (): void => {
  const { i18n } = useLingui();
  const loopWords = useLoopWords(isLocale(i18n.locale) ? i18n.locale : "en");
  useEffect(() => {
    setLoopWords(loopWords);
  });
};

/**
 * Back to talking, for whoever types: the microphone is asked for again,
 * and given, the conversation goes on out loud from where it is.
 */
const talkAgain = async (): Promise<void> => {
  if (!(await reachMic())) {
    // Still refused: the line over the card stays.
    return;
  }
  setSound(true);
  update((now) => ({ ...now, mode: "talk" }));
  stopLoop();
  startLoop();
};

/** The header while they talk: the transcript, and the pause. */
const TalkActions = ({
  transcript,
  onTranscript,
  onPause,
}: {
  transcript: boolean;
  onTranscript: () => void;
  onPause: () => void;
}) => {
  const { t } = useLingui();
  return (
    <>
      <Button
        aria-expanded={transcript}
        aria-label={t`Transcript`}
        // Where what they said is seen going while the transcript is closed (heard.tsx).
        data-transcript-button=""
        onClick={(event) => {
          onTranscript();
          // Pressed with a pointer, it lets go of focus: a key pressed later (Escape, to close it)
          // would otherwise turn the press into keyboard focus and draw the ring round it.
          if (event.detail > 0) {
            event.currentTarget.blur();
          }
        }}
        size={tool.button}
        tooltip={t`Transcript`}
        variant={transcript ? "secondary" : "ghost"}
      >
        <Icon icon={MessageSquareIcon} />
      </Button>
      <Button
        aria-label={t`Pause`}
        data-guide="pause"
        onClick={onPause}
        size={tool.button}
        tooltip={t`Pause`}
        variant="ghost"
      >
        <Icon icon={PauseIcon} />
      </Button>
    </>
  );
};

/** The interviews are over: what was said can be deleted, no more. */
const Over = () => {
  const { t } = useLingui();
  return (
    <Page>
      <Words
        line={t`Thank you for your time.`}
        title={t`The interviews are over.`}
      />
    </Page>
  );
};

/** They deleted it; or, while what the Brain kept of it is still being removed, they are told that instead. */
const Deleted = ({ removing }: { removing: boolean }) => {
  const { t } = useLingui();
  return (
    <Page>
      <Words
        live
        title={
          removing
            ? t`Deleted. What the Brain kept of it is being removed.`
            : t`Deleted. Nothing you said is kept.`
        }
      />
    </Page>
  );
};

/**
 * They withdrew: what they said stays theirs to read and delete, and
 * nothing of it is used; or, while what the Brain kept of it is still
 * being removed, they are told that instead.
 */
const Withdrawn = ({
  removing,
  readOnly,
}: {
  removing: boolean;
  /** The link's 7 days are over: it is no longer theirs to delete here. */
  readOnly: boolean;
}) => {
  const { t } = useLingui();
  return (
    <Page>
      <Words
        line={
          readOnly
            ? t`It stays here for you to read.`
            : t`It stays here for you to read. You can still delete it.`
        }
        live
        title={
          removing
            ? t`You withdrew. What the Brain kept of it is being removed.`
            : t`You withdrew. Nothing you said is used from now on.`
        }
      />
    </Page>
  );
};

/**
 * Whether they picked their language on this visit. A new language remounts the
 * whole page, so the pick lives outside it, or they would be asked again.
 */
let languagePicked = false;

/** Before the conversation: the start, and its ways out. */
const BeforeTalk = ({
  session,
  closes,
}: {
  session: OpenSession;
  closes: string;
}) => {
  const who = interviewerNames[useInterviewer()];
  // First the language they talk in, then the welcome in it.
  const [before, setBefore] = useState<Before>(() =>
    languagePicked ? { at: "start" } : { at: "language" }
  );
  const [refusal, setRefusal] = useState<string | null>(null);
  // A second press while core is asked does nothing.
  const [asking, setAsking] = useState(false);
  const toStart = (): void => {
    setRefusal(null);
    setBefore({ at: "start" });
  };
  /** Core keeps that they take part, then they talk; or it says why not. */
  const agree = async (): Promise<void> => {
    const link = linkNow();
    if (link === null) {
      return;
    }
    const answer = await participate(link.secret);
    if (isRefused(answer)) {
      setRefusal(answer.message);
      return;
    }
    setRefusal(null);
    // Voice first: whoever has no microphone here is told so, and types.
    setSound(true);
    update((now) => begun(now, Date.now(), "talk"));
  };
  // The times to be reminded at, while any is left before the interviews close.
  const times = remindTimes(new Date(), session.closes);
  /** Core keeps the time they picked and sends the reminder then; or it says why not. */
  const remind = async (picked: RemindAt): Promise<void> => {
    const link = linkNow();
    if (link === null || asking) {
      return;
    }
    setAsking(true);
    const answer = await remindLater(link.secret, picked.at.toISOString());
    setAsking(false);
    if (isRefused(answer)) {
      setRefusal(answer.message);
      return;
    }
    setRefusal(null);
    // The time as core keeps it, never this page's own.
    setBefore({
      at: "reminded",
      picked: { id: picked.id, at: new Date(answer.at) },
    });
  };
  switch (before.at) {
    case "language": {
      return (
        <PickLanguage
          name={session.name}
          onPicked={() => {
            languagePicked = true;
          }}
          onChosen={() => {
            setBefore({ at: "start" });
          }}
        />
      );
    }
    case "not-now": {
      return (
        <NotNow
          closes={closes}
          onBack={toStart}
          onPick={(picked) => {
            void remind(picked);
          }}
          refusal={refusal}
          times={times}
        />
      );
    }
    case "reminded": {
      return <Reminded onStart={toStart} picked={before.picked} />;
    }
    case "start": {
      return (
        <Consent
          company={session.company}
          name={session.name}
          onAgree={() => {
            void agree();
          }}
          onNotNow={
            times.length === 0
              ? undefined
              : () => {
                  setRefusal(null);
                  setBefore({ at: "not-now" });
                }
          }
          refusal={refusal}
          who={who}
        />
      );
    }
    default: {
      return before satisfies never;
    }
  }
};

/** Why deleting or withdrawing didn't work, when it didn't. */
const Failed = ({ message }: { message: string | null }) => (
  <TopError>{message}</TopError>
);

/** They pause: the clock stops with them, and what is away from here is not interview time. */
const pauseNow = (): void => {
  update((was) => leftFor(ticked(was, Date.now())));
  keepNow();
};

/** Back from the pause: all of it was time away. */
const carryOn = (): void => {
  const at = Date.now();
  update((was) => ({
    ...resumed(was),
    seenAt: at,
    awayMs: (was.awayMs ?? 0) + Math.max(0, at - (was.seenAt ?? at)),
  }));
};

/** The minutes are over: on to the read-back. */
const readBackNow = (): void => {
  update((was) => steered(was, { phase: "readback", wants: "readback" }));
  keepNow();
};

/** His thanks, once they agreed to the read-back; only that once the link's 7 days are over. */
const Thanks = ({ name, readOnly }: { name: string; readOnly: boolean }) => {
  const { rating, feedback } = useProgress();
  return (
    <Page>
      <Closed
        feedback={feedback}
        name={name}
        readOnly={readOnly}
        onAdd={() => {
          update(reopened);
        }}
        onFeedback={(given) => {
          update((was) => feedbackGiven(was, given));
          keepNow();
        }}
        onRate={(given) => {
          update((was) => rated(was, given));
          keepNow();
        }}
        rating={rating}
      />
    </Page>
  );
};

/**
 * What stands once the interview is deleted, withdrawn from, over, or only
 * read now that the link's 7 days are over (also when they had gone back
 * in to add something); nothing while it is none of these.
 */
const endedAs = ({
  name,
  deleted,
  removingDeleted,
  withdrawn,
  removingWithdrawn,
  closed,
  readOnly,
}: {
  name: string;
  deleted: boolean;
  removingDeleted: boolean;
  withdrawn: boolean;
  removingWithdrawn: boolean;
  closed: boolean;
  readOnly: boolean;
}): ReactNode => {
  if (deleted) {
    return <Deleted removing={removingDeleted} />;
  }
  if (withdrawn) {
    return <Withdrawn readOnly={readOnly} removing={removingWithdrawn} />;
  }
  if (closed) {
    return <Over />;
  }
  return readOnly ? <Thanks name={name} readOnly /> : null;
};

/** The minutes left, counted while they are `asking`; the read-back is never cut short. */
const useClock = (progress: InterviewProgress, asking: boolean) => {
  const now = useNow(asking);
  const left = secondsLeft(progress, now);
  useCountdownMarks(left, asking);
  return { left, timeUp: asking && left <= 0 };
};

/** The transcript goes with the conversation, beside the stage or in its place; Escape puts it away. */
const useTranscript = (running: boolean) => {
  // Open from the start where it has room beside the stage (the owner's ask, 2026-11-26); on a
  // narrow window it would take the stage's place, so there it waits to be asked for.
  const [transcript, setTranscript] = useState(
    () =>
      typeof window !== "undefined" && window.matchMedia(besideQuery).matches
  );
  const floating = transcript && running;
  const besideStage = useSyncExternalStore(
    onBeside,
    () => window.matchMedia(besideQuery).matches
  );
  useEffect(
    () =>
      floating
        ? onEscape(() => {
            setTranscript(false);
          })
        : undefined,
    [floating]
  );
  return {
    transcript,
    setTranscript,
    floating,
    alone: floating && !besideStage,
  };
};

/** The conversation, its read-back, or the end of its minutes. */
const Talking = ({
  name,
  reading,
  guiding,
  timeUp,
  transcript,
  alone,
  paused = false,
  onResume,
}: {
  name: string;
  reading: boolean;
  /** The quick look round before the first question (guide.tsx). */
  guiding: boolean;
  timeUp: boolean;
  transcript: boolean;
  alone: boolean;
  /** Paused where they were: his orb falls asleep in place, and the box is a button to go on. */
  paused?: boolean;
  onResume?: () => void;
}) =>
  timeUp && !paused ? (
    <TimeUp name={name} onReadBack={readBackNow} />
  ) : (
    <Conversation
      alone={alone}
      guiding={guiding}
      onTalk={() => {
        void talkAgain();
      }}
      {...(onResume === undefined ? {} : { onResume })}
      paused={paused}
      reading={reading}
      transcript={transcript}
    />
  );

/**
 * Every screen but the conversation stands on Stephen's field; the
 * conversation keeps its own room. The read-back told as a story stands
 * in his light, softly from the top.
 */
const poseOf = (stage: ReactNode, story: boolean): Pose | undefined => {
  if (story) {
    return readingPose;
  }
  return isValidElement(stage) && stage.type === Talking ? undefined : beside;
};

/**
 * The header's end: on a local stack the jump menu, then the page's own
 * actions, and while they talk the minutes left, at its far end.
 */
const HeaderEnd = ({
  actions,
  left,
  running,
  reading,
  onJumped,
}: {
  actions: ReactNode;
  /** Seconds left. */
  left: number;
  /** The conversation runs, and the read-back isn't on screen: the minutes count. */
  running: boolean;
  reading: boolean;
  onJumped: () => void;
}) => (
  <>
    <DevJump onJumped={onJumped} />
    {actions}
    {running && !reading ? <Countdown left={left} /> : null}
  </>
);

/**
 * Where the conversation stands: read back, or, once, before anything is
 * said, the quick look round first (guide.tsx), which the minutes and the
 * conversation wait for.
 */
const useTalkingAt = (progress: InterviewProgress, talking: boolean) => {
  const guided = useGuided();
  const reading = talking && isReading(progress);
  const guiding = talking && !reading && !guided && progress.lines.length === 0;
  return { reading, guiding, asking: talking && !reading && !guiding };
};

/**
 * Whether the link still takes what they say: not withdrawn from, not over,
 * and not past its 7 days, after which it only reads (core refuses the
 * rest), so no talking, adding or deleting is offered.
 */
const stillTakes = (session: OpenSession, withdrawn: boolean): boolean =>
  !(withdrawn || session.closed || session.readOnly);

/** The interview on the link, held on this device. */
export const InterviewPage = ({ session }: { session: OpenSession }) => {
  const progress = useProgress();
  const [stopped, setStopped] = useState(false);
  const { deleted, removingDeleted, deleteFailed, remove } = useDeleting();
  const { withdrawn, removing, withdrawFailed, withdraw } =
    useWithdrawing(session);
  const closes = formatDay(session.closes);
  const { readOnly } = session;
  const talking =
    inConversation(progress) &&
    !stopped &&
    stillTakes(session, withdrawn) &&
    deleted === "no";
  const { reading, guiding, asking } = useTalkingAt(progress, talking);
  const { left, timeUp } = useClock(progress, asking);

  useWordsOnScreen();
  // He says goodbye by the name they are greeted by.
  useEffect(() => {
    setLoopName(session.name, session.kind === "lead");
  }, [session.name, session.kind]);
  // The conversation runs while it is on screen; a moment after, so a screen that only flashes by asks nothing.
  const running = talking && !timeUp && !guiding;
  useEffect(() => (running ? runLoop() : undefined), [running]);
  // The header's tools for talking are there from the guide on, which tells about them.
  const talkTools = running || guiding;
  // Paused, the transcript stays as it was, where it was: only his orb falls asleep.
  const { transcript, setTranscript, floating, alone } = useTranscript(
    talkTools || stopped
  );
  const canDelete =
    deleted !== "yes" &&
    deletable(progress, session.closed || withdrawn, readOnly);

  let actions: ReactNode = null;
  if (talkTools) {
    actions = (
      <TalkActions
        onPause={() => {
          // The transcript stays as it was: it is there again once they carry on.
          pauseNow();
          setStopped(true);
        }}
        onTranscript={() => {
          setTranscript(!transcript);
        }}
        transcript={transcript}
      />
    );
  } else if (canDelete) {
    actions = (
      <DeleteInterview
        onDelete={() => {
          void remove();
        }}
        onWithdraw={withdrawOffered(withdrawn, progress.told, withdraw)}
      />
    );
  }

  const started = progress.person !== "invited" && progress.person !== "opened";
  const ended = endedAs({
    name: session.name,
    deleted: deleted === "yes",
    removingDeleted,
    withdrawn,
    removingWithdrawn: removing,
    closed: session.closed,
    readOnly,
  });
  let stage: ReactNode;
  if (ended !== null) {
    stage = ended;
  } else if (stopped) {
    // Paused where they were, on the same stage: his orb falls asleep, and the box is a button to go on.
    stage = (
      <Talking
        alone={alone}
        guiding={false}
        name={session.name}
        onResume={() => {
          carryOn();
          setStopped(false);
        }}
        paused
        reading={false}
        timeUp={false}
        transcript={floating}
      />
    );
  } else if (progress.person === "completed" && progress.told) {
    stage = <Thanks name={session.name} readOnly={false} />;
  } else if (started && progress.told) {
    stage = (
      <Talking
        alone={alone}
        guiding={guiding}
        name={session.name}
        reading={reading}
        timeUp={timeUp}
        transcript={floating}
      />
    );
  } else {
    // Not started, or core doesn't hold that they agreed to take part, to
    // what this is as it says now: they read it, and agree, first.
    stage = <BeforeTalk closes={closes} session={session} />;
  }

  return (
    <Frame
      actions={
        <HeaderEnd
          actions={actions}
          left={left}
          reading={reading}
          running={running}
          onJumped={() => {
            setStopped(false);
          }}
        />
      }
      pose={poseOf(stage, reading)}
      strip={!reading}
    >
      {stage}
      <Failed message={deleteFailed ?? withdrawFailed} />
    </Frame>
  );
};
