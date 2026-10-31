import { interviewerNames, interviewers } from "@grasp-os/shared/onboarding";
import type { InterviewKind, Interviewer } from "@grasp-os/shared/onboarding";
import { Button } from "@grasp-os/ui/components/button";
import { PageHeaderTitle } from "@grasp-os/ui/components/page-header";
import { useLingui } from "@lingui/react/macro";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { ReactNode } from "react";

import { LanguageChoice } from "../onboarding/language-choice.tsx";
import { isRefused, participate } from "./api.ts";
import { Head, headSizes, pair, useHead } from "./head.tsx";
import { linkNow, update, useInterviewer, useProgress } from "./kept.ts";
import { chose, toldWhat } from "./progress.ts";
import { Quiet, sayAfterMs, SoundCheck } from "./sound-check.tsx";
import type { AnswerBy } from "./sound-check.tsx";
import {
  prepare,
  say,
  setSound,
  stopSpeaking,
  useSaidOf,
  voiceLevel,
} from "./speech.ts";
import { SpokenText } from "./spoken.tsx";
import { usePromise } from "./words.ts";

// Before the interview (prototype `interview-intro.tsx`): first which
// language, then who they talk with, Stephen or Claire, then what this is,
// to read in peace, then a check that both can hear each other. Whoever has
// read what this is before goes straight to the check, with whoever they
// chose then. There is no button to say no: whoever doesn't want to talk
// closes the link. Kept plain: no cards or icons, one column. Going on from
// what this is tells core they agree to take part (GRA-329): nothing they
// say is heard or read by a model before core kept that.

/** The device's own language is marked already: a press on another switches to it, and nothing more. */
const keepGoing = (): void => {
  // The choice is the language itself; the way on is Continue.
};

/** A line as it stands on one of these screens, its words lighting up as they are said. */
const Line = ({
  text,
  heading = false,
}: {
  text: string;
  heading?: boolean;
}) => {
  const said = useSaidOf(text);
  const className =
    "type-display animate-in fade-in slide-in-from-bottom-2 motion-reduce:animate-none max-w-lg duration-500";
  return (
    <div
      aria-live="polite"
      className="flex min-h-16 w-full items-start justify-center"
    >
      {heading ? (
        <h1 className={className} key={text}>
          <SpokenText said={said} text={text} />
        </h1>
      ) : (
        <p className={className} key={text}>
          <SpokenText said={said} text={text} />
        </p>
      )}
    </div>
  );
};

/**
 * The first thing on the link, as in the onboarding: which language. The
 * interviewer asks in the language of the device, and that one is marked,
 * so most people only press Continue. Any other is one press away, and the
 * question is asked again in it. Where the browser plays no sound before a
 * first press, the words light up without it.
 */
const Language = ({ room, onNext }: { room: number; onNext: () => void }) => {
  const { t } = useLingui();
  const interviewer = useInterviewer();
  const who = interviewerNames[interviewer];
  const { body, size } = useHead(room, headSizes.talking);
  const question = t`Which language do you want to do this interview in?`;
  // Asked anew in every language chosen.
  useEffect(() => {
    const id = window.setTimeout(() => {
      void say(question, { speaker: interviewer, tone: "easy, light" });
    }, sayAfterMs);
    return () => {
      window.clearTimeout(id);
      stopSpeaking();
    };
  }, [question, interviewer]);
  return (
    <div className="flex w-full max-w-xl flex-col items-center gap-6 text-center">
      <Head
        fill={0.35}
        label={t`${who}, drawn in dots.`}
        sign="question"
        size={size}
        voice={voiceLevel}
        who={interviewer}
      />
      <div className="flex w-full flex-col items-center gap-6" ref={body}>
        <Line heading text={question} />
        <LanguageChoice onPick={keepGoing} picked />
        <Button
          className="w-full max-w-sm"
          onClick={onNext}
          size="xl"
          variant="highlight"
        >
          {t`Continue`}
        </Button>
      </div>
    </div>
  );
};

/**
 * Who they talk with: Stephen and Claire side by side, as the two people
 * they are. Each says who they are in their own voice, and nothing more:
 * the one speaking printed full, the other a shade lighter. Then Stephen
 * says there is a choice, and that line stays. A press on the name under
 * one of them is the choice and the way on; neither is marked beforehand.
 * The interview is the same with either: the same questions in the same
 * order.
 */
const Who = ({
  room,
  onChoose,
}: {
  room: number;
  onChoose: (interviewer: Interviewer) => void;
}) => {
  const { t } = useLingui();
  const { body, size } = useHead(room, headSizes.talking, true);
  const [first, second] = interviewers;
  const firstName = interviewerNames[first];
  const secondName = interviewerNames[second];
  const hello = t`I’m ${firstName}.`;
  const also = t`And I’m ${secondName}.`;
  const choice = t`Choose who you want to be interviewed by.`;
  // Who is speaking: the first from the start, so the other waits from the first frame; nobody once all is said.
  const [speaking, setSpeaking] = useState<Interviewer | null>(first);
  const [introduced, setIntroduced] = useState(false);
  // Which telling this is: one started again, or left, says no more.
  const telling = useRef(0);

  /** Each says who they are, one after the other; then the first says it is theirs to choose. */
  const introduce = async (
    opening: string,
    following: string,
    asking: string
  ): Promise<void> => {
    telling.current += 1;
    const mine = telling.current;
    stopSpeaking();
    setSpeaking(first);
    setIntroduced(false);
    // The next line is fetched while one is said, so the one follows the other without a gap.
    prepare(following, { speaker: second, tone: "warm, relaxed" });
    await say(opening, { speaker: first, tone: "warm, relaxed" });
    if (telling.current !== mine) {
      return;
    }
    setSpeaking(second);
    prepare(asking, { speaker: first, tone: "warm, relaxed" });
    await say(following, { speaker: second, tone: "warm, relaxed" });
    if (telling.current !== mine) {
      return;
    }
    setSpeaking(first);
    setIntroduced(true);
    await say(asking, { speaker: first, tone: "warm, relaxed" });
    if (telling.current === mine) {
      setSpeaking(null);
    }
  };
  const opened = useEffectEvent(
    (opening: string, following: string, asking: string) => {
      void introduce(opening, following, asking);
    }
  );
  // Said as the screen opens, and again in every language chosen.
  useEffect(() => {
    const id = window.setTimeout(() => {
      opened(hello, also, choice);
    }, sayAfterMs);
    const tellings = telling;
    return () => {
      window.clearTimeout(id);
      tellings.current += 1;
      stopSpeaking();
    };
  }, [hello, also, choice]);

  const choose = (interviewer: Interviewer): void => {
    telling.current += 1;
    stopSpeaking();
    onChoose(interviewer);
  };

  let line = choice;
  if (!introduced && speaking === first) {
    line = hello;
  } else if (!introduced && speaking === second) {
    line = also;
  }
  return (
    // As wide as the two figures, so each name stands under its own figure, as the prototype has them.
    <div className="flex w-fit max-w-full flex-col items-center gap-6 text-center">
      <div className="flex justify-center gap-4">
        {interviewers.map((each) => {
          const who = interviewerNames[each];
          return (
            <Head
              beside={{ speaking: speaking === each }}
              fill={speaking === null || speaking === each ? 1 : pair.waiting}
              key={each}
              label={
                speaking === each
                  ? t`${who} is talking`
                  : t`${who}, drawn in dots.`
              }
              size={size}
              voice={speaking === each ? voiceLevel : undefined}
              who={each}
            />
          );
        })}
      </div>
      <div className="flex w-full flex-col items-center gap-6" ref={body}>
        <Line text={line} />
        <fieldset className="grid w-full grid-cols-2 gap-4">
          <legend className="sr-only">{t`Who would you like to talk with?`}</legend>
          {interviewers.map((each) => (
            <Button
              className="w-full max-w-48 justify-self-center"
              key={each}
              onClick={() => {
                choose(each);
              }}
              size="xl"
              variant="outline"
            >
              {interviewerNames[each]}
            </Button>
          ))}
        </fieldset>
        <Quiet
          onClick={() => {
            void introduce(hello, also, choice);
          }}
        >
          {t`Hear both again`}
        </Quiet>
      </div>
    </div>
  );
};

/** What they are asked about: the team's work for a lead, their own work for everyone else. */
const useWhatWeDo = (kind: InterviewKind): string => {
  const { t } = useLingui();
  return kind === "lead"
    ? t`Your company wants to know how the work really goes. You lead your team, so I first ask how your team works with AI today. Then I ask what work the team does, and who does which. That takes about 20 minutes. Talking is the fastest. You can also type.`
    : t`Your company wants to know how the work really goes. First I ask how you work with AI today. Then I ask about one piece of your work. You tell me how you do it. That takes 12 to 15 minutes. Talking is the fastest. You can also type.`;
};

/**
 * What this is, on one calm screen, in words a child of ten follows: what
 * happens, what becomes of their words, and that it is theirs to stop.
 * What it promises is what the interviewer says when asked, word for word
 * (core's onboarding/stephen.ts, `WHO`). Nothing is said out loud here:
 * this is to be read at one's own pace. Whoever would rather talk with the
 * other one goes there with one quiet line.
 */
const About = ({
  name,
  kind,
  room,
  refusal,
  onNext,
  onType,
}: {
  name: string;
  kind: InterviewKind;
  room: number;
  /** Why taking part wasn't kept, when it wasn't. */
  refusal: string | null;
  onNext: () => void;
  onType: () => void;
}) => {
  const { t } = useLingui();
  const interviewer = useInterviewer();
  const who = interviewerNames[interviewer];
  const other = interviewers.find((each) => each !== interviewer) ?? "stephen";
  const otherName = interviewerNames[other];
  const { body, size } = useHead(room, headSizes.talking);
  const promise = usePromise();
  const rows = [
    { about: t`What we do`, text: useWhatWeDo(kind) },
    {
      about: t`Your words`,
      text: `${t`I write down what you tell me. At the end I read it back, and you say what is wrong. Your voice is not kept.`} ${promise}`,
    },
    {
      about: t`Your choice`,
      text: t`You decide. You can stop when you want, skip any question, and delete everything for 7 days afterwards.`,
    },
  ];
  return (
    <div className="flex w-full max-w-xl flex-col items-center gap-6 text-center">
      {/* Going to the other one after all, the one makes way for the other: two people, so neither turns into the other. */}
      <div className="animate-in fade-in duration-500" key={interviewer}>
        <Head
          fill={0.35}
          label={t`${who}, drawn in dots.`}
          size={size}
          who={interviewer}
        />
      </div>
      <div className="flex w-full flex-col items-center gap-6" ref={body}>
        <PageHeaderTitle>
          {t`Hi ${name}, I’m ${who}. I’m an AI, and I work for Grasp.`}
        </PageHeaderTitle>
        <dl className="w-full text-left">
          {rows.map((row) => (
            <div
              className="grid gap-x-6 gap-y-1 border-t py-3 last:border-b sm:grid-cols-[7rem_1fr]"
              key={row.about}
            >
              <dt className="text-muted-foreground">{row.about}</dt>
              <dd>{row.text}</dd>
            </div>
          ))}
        </dl>
        <div className="flex w-full max-w-sm flex-col items-center gap-3">
          <Button
            className="w-full"
            onClick={onNext}
            size="xl"
            variant="highlight"
          >
            {t`Check sound and microphone`}
          </Button>
          <Quiet onClick={onType}>{t`Type instead, without sound`}</Quiet>
          <Quiet
            onClick={() => {
              update((now) => chose(now, other));
            }}
          >
            {t`Rather talk with ${otherName}?`}
          </Quiet>
          {refusal === null ? null : (
            <p className="text-destructive text-sm" role="alert">
              {refusal}
            </p>
          )}
        </div>
      </div>
    </div>
  );
};

/** Which of the screens before the interview is on. */
type Screen = "language" | "who" | "about" | "check";

/**
 * The screens before the first question. Whoever read what this is before
 * goes straight to the check; the language is asked once, on the way in.
 */
export const Before = ({
  name,
  kind,
  room,
  onStart,
}: {
  name: string;
  kind: InterviewKind;
  room: number;
  onStart: (by: AnswerBy) => void;
}) => {
  const progress = useProgress();
  const [asked, setAsked] = useState(progress.told);
  const [refusal, setRefusal] = useState<string | null>(null);
  /** Core keeps that they take part, then `then`; or says why not. */
  const takePart = async (then: () => void): Promise<void> => {
    const link = linkNow();
    if (link === null) {
      return;
    }
    const answer = await participate(link.secret, link.key);
    if (isRefused(answer)) {
      setRefusal(answer.message);
      return;
    }
    setRefusal(null);
    then();
  };
  let screen: Screen = "who";
  if (!asked) {
    screen = "language";
  } else if (progress.told) {
    screen = "check";
  } else if (progress.interviewer !== undefined) {
    screen = "about";
  }
  let shown: ReactNode;
  switch (screen) {
    case "language": {
      shown = (
        <Language
          onNext={() => {
            setAsked(true);
          }}
          room={room}
        />
      );
      break;
    }
    case "who": {
      shown = (
        <Who
          onChoose={(interviewer) => {
            update((now) => chose(now, interviewer));
          }}
          room={room}
        />
      );
      break;
    }
    case "about": {
      shown = (
        <About
          kind={kind}
          name={name}
          onNext={() => {
            void takePart(() => {
              update(toldWhat);
            });
          }}
          onType={() => {
            // Whoever chooses to type here has no use for a sound check, and isn't surprised by a voice.
            stopSpeaking();
            setSound(false);
            void takePart(() => {
              onStart("type");
            });
          }}
          refusal={refusal}
          room={room}
        />
      );
      break;
    }
    case "check": {
      shown = <SoundCheck name={name} onStart={onStart} room={room} />;
      break;
    }
    default: {
      shown = screen satisfies never;
    }
  }
  return (
    <div
      className="animate-in fade-in flex w-full justify-center duration-500"
      key={screen}
    >
      {shown}
    </div>
  );
};
