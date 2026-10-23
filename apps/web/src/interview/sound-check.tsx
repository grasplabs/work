import { interviewerNames } from "@grasp-os/shared/onboarding";
import { Button } from "@grasp-os/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import { useLingui } from "@lingui/react/macro";
import { ChevronDownIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import type { DotSign } from "./dot-signs.ts";
import { Head, headSizes, useHead } from "./head.tsx";
import { useInterviewer } from "./kept.ts";
import {
  chooseMic,
  hangUp,
  listenForVoice,
  micProblem,
  microphone,
  microphones,
  reachMic,
} from "./mic.ts";
import type { MicProblem, Microphone } from "./mic.ts";
import {
  say,
  setSound,
  stopSpeaking,
  useSaidOf,
  voiceLevel,
} from "./speech.ts";
import { SpokenText } from "./spoken.tsx";
import { VoiceBar } from "./voice-bar.tsx";
import type { BarDoing } from "./voice-bar.tsx";

// The check before the first question (prototype `interview-intro.tsx`,
// `Setup`), so nobody finds out halfway that the other can't be heard.
// First whether they hear the interviewer: a hello out loud, and they say
// so. Then whether the interviewer hears them: the browser asks for the
// microphone, they say a few words and see their own voice move as a wave,
// and pick another microphone where the wrong one listens. Typing is there
// for whoever can't or won't talk, as one quiet line that says what it
// costs: talking is what this is made for.

/** How they answer: out loud, or by typing. */
export type AnswerBy = "talk" | "type";

/** Which check they are at: whether they hear the interviewer, whether they are heard, or both done. */
type Check = "sound" | "mic" | "ready";

/** What the bar under the line shows: the microphone being asked for, their voice, or the interviewer's. */
type Doing = Exclude<BarDoing, "thinking">;

/** How soon a screen's first line is said, so it is said once the screen has faded in. */
export const sayAfterMs = 350;

/** A quiet way to do something else: a line of text, never a second button. */
export const Quiet = ({
  onClick,
  children,
}: {
  onClick: () => void;
  children: string;
}) => (
  <button
    className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 rounded-sm font-medium text-balance underline-offset-4 outline-none hover:underline focus-visible:ring-3"
    onClick={onClick}
    type="button"
  >
    {children}
  </button>
);

/** Which microphone is listened through, to change where there is more than one. */
const Microphones = ({
  devices,
  device,
  onChoose,
}: {
  devices: Microphone[];
  device: string;
  onChoose: (id: string) => void;
}) => {
  const { t } = useLingui();
  const name =
    devices.find((each) => each.id === device)?.name ?? devices[0]?.name ?? "";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t`Microphone: ${name}`}
        render={<Button className="max-w-full" size="sm" variant="ghost" />}
      >
        <span className="truncate">{name}</span>
        <ChevronDownIcon data-icon="inline-end" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center">
        <DropdownMenuRadioGroup
          onValueChange={(id: unknown) => {
            if (typeof id === "string") {
              onChoose(id);
            }
          }}
          value={device}
        >
          {devices.map((each) => (
            <DropdownMenuRadioItem key={each.id} value={each.id}>
              {each.name}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/** What they see while the microphone is checked: the bar, what is wrong, and the way on. */
const MicStep = ({
  check,
  mic,
  hearing,
  devices,
  device,
  onChoose,
  onRetry,
  onStart,
}: {
  check: Check;
  mic: "asking" | "on" | MicProblem;
  hearing: boolean;
  devices: Microphone[];
  device: string | null;
  onChoose: (id: string) => void;
  onRetry: () => void;
  onStart: (by: AnswerBy) => void;
}) => {
  const { t } = useLingui();
  const problems: Record<MicProblem, string> = {
    blocked: t`Your browser is not letting me use the microphone. Allow it next to the address, and try again.`,
    missing: t`I cannot find a microphone. Plug one in and try again.`,
    unsupported: t`This browser cannot listen. You can type your answers.`,
  };
  if (mic !== "asking" && mic !== "on") {
    return (
      <div className="flex w-full max-w-sm flex-col items-center gap-3">
        <p aria-live="polite" className="text-muted-foreground text-balance">
          {problems[mic]}
        </p>
        <Button
          className="w-full"
          onClick={() => {
            onStart("type");
          }}
          size="xl"
        >
          {t`Start by typing`}
        </Button>
        {mic === "unsupported" ? null : (
          <Quiet onClick={onRetry}>{t`Try again`}</Quiet>
        )}
      </div>
    );
  }
  let doing: Doing = "speaking";
  if (mic === "asking") {
    doing = "asking";
  } else if (hearing) {
    doing = "listening";
  }
  return (
    <div className="flex w-full max-w-sm flex-col items-center gap-3">
      {check === "mic" ? <VoiceBar doing={doing} /> : null}
      {check === "mic" && mic === "asking" ? (
        <p className="text-muted-foreground text-balance">
          {t`Allow the microphone when your browser asks.`}
        </p>
      ) : null}
      {check === "mic" && devices.length > 1 && device !== null ? (
        <Microphones device={device} devices={devices} onChoose={onChoose} />
      ) : null}
      {check === "ready" ? (
        <Button
          className="w-full"
          onClick={() => {
            onStart("talk");
          }}
          size="xl"
        >
          {t({ message: "Start", context: "begin the interview" })}
        </Button>
      ) : null}
      <Quiet
        onClick={() => {
          onStart("type");
        }}
      >
        {t`Rather type?`}
      </Quiet>
    </div>
  );
};

/** The check: first whether they hear the interviewer, then whether they are heard. */
export const SoundCheck = ({
  name,
  room,
  onStart,
}: {
  name: string;
  room: number;
  onStart: (by: AnswerBy) => void;
}) => {
  const { t } = useLingui();
  const interviewer = useInterviewer();
  const who = interviewerNames[interviewer];
  const [check, setCheck] = useState<Check>("sound");
  // How often they asked to hear it again: after the first time there is more to say.
  const [replayed, setReplayed] = useState(0);
  const [mic, setMic] = useState<"asking" | "on" | MicProblem>("asking");
  // Whether it listens for their voice right now: not while the interviewer says a line.
  const [hearing, setHearing] = useState(false);
  const [devices, setDevices] = useState<Microphone[]>([]);
  const [device, setDevice] = useState<string | null>(null);
  const stopListening = useRef<(() => void) | null>(null);
  // Whether the check is still on screen: what comes back after it left does nothing.
  const here = useRef(true);

  const hello = t`Hi ${name}, I’m ${who}, an AI. Can you hear me?`;
  const now = t`Good. Now say something, so I can hear you too.`;
  const heard = t`I hear you. Shall we start?`;
  let line = heard;
  if (check === "sound") {
    line = hello;
  } else if (check === "mic") {
    line = now;
  }
  const said = useSaidOf(line);
  const { body, size } = useHead(room, headSizes.talking);

  const greet = (): void => {
    void say(hello, { speaker: interviewer, tone: "warm, relaxed" });
  };
  const opened = useEffectEvent(greet);
  // The hello as the check opens: the press that led here lets the browser play it.
  useEffect(() => {
    setSound(true);
    const id = window.setTimeout(opened, sayAfterMs);
    return () => {
      window.clearTimeout(id);
      stopSpeaking();
    };
  }, []);
  useEffect(() => {
    here.current = true;
    return () => {
      here.current = false;
      stopListening.current?.();
      stopListening.current = null;
      hangUp();
    };
  }, []);

  const stop = (): void => {
    stopListening.current?.();
    stopListening.current = null;
    setHearing(false);
  };

  /** They are heard: that is all it listened for. */
  const heardThem = (): void => {
    stop();
    setCheck("ready");
    void say(heard, { speaker: interviewer, tone: "easy, light" });
  };

  /** Listens for a voice, through the microphone as it is now. */
  const open = (): void => {
    stop();
    stopListening.current = listenForVoice(heardThem);
    setHearing(true);
  };

  /** The microphone is asked for, and once given, `then`. */
  const reach = async (then: () => Promise<void> | void): Promise<void> => {
    stop();
    setMic("asking");
    if (!(await reachMic())) {
      if (here.current) {
        setMic(micProblem() ?? "blocked");
      }
      return;
    }
    const found = await microphones();
    if (!here.current) {
      return;
    }
    setDevices(found);
    setDevice(microphone());
    setMic("on");
    await then();
  };

  /** They hear the interviewer, or go on without: now the other way round, asked at once while the press still counts. */
  const toMic = (): void => {
    stopSpeaking();
    setCheck("mic");
    void reach(async () => {
      // It listens once the line is said, so it doesn't hear the interviewer.
      await say(now, { speaker: interviewer, tone: "easy, light" });
      if (here.current) {
        open();
      }
    });
  };

  /** Another microphone: listened to from now on, and they have to be heard again. */
  const choose = async (id: string): Promise<void> => {
    stopSpeaking();
    stop();
    setCheck("mic");
    setMic("asking");
    const reached = await chooseMic(id);
    if (!here.current) {
      return;
    }
    if (!reached) {
      setMic(micProblem() ?? "blocked");
      return;
    }
    setDevice(microphone());
    setMic("on");
    open();
  };

  const start = (by: AnswerBy): void => {
    stopSpeaking();
    stop();
    hangUp();
    if (by === "type") {
      setSound(false);
    }
    onStart(by);
  };

  const problem = mic !== "asking" && mic !== "on";
  let sign: DotSign | null = null;
  if (check === "ready") {
    sign = "smile";
  } else if (check === "sound" || (mic === "on" && !problem)) {
    sign = "question";
  }

  return (
    <div className="flex w-full max-w-xl flex-col items-center gap-6 text-center">
      <Head
        fill={0.35}
        label={t`${who}, drawn in dots.`}
        sign={sign}
        size={size}
        voice={voiceLevel}
        who={interviewer}
      />
      <div className="flex w-full flex-col items-center gap-6" ref={body}>
        <div
          aria-live="polite"
          className="flex min-h-16 w-full items-start justify-center"
        >
          <h1
            className="animate-in fade-in slide-in-from-bottom-2 max-w-lg text-2xl font-medium tracking-tight text-balance duration-500"
            key={check}
          >
            <SpokenText said={said} text={line} />
          </h1>
        </div>
        {check === "sound" ? (
          <div className="flex w-full max-w-sm flex-col items-center gap-3">
            <Button className="w-full" onClick={toMic} size="xl">
              {t`Yes, I can hear you`}
            </Button>
            {replayed > 0 ? (
              <p className="text-muted-foreground text-balance">
                {t`Still nothing? Turn your volume up, or check where your sound goes.`}
              </p>
            ) : null}
            <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
              <Quiet
                onClick={() => {
                  setReplayed(replayed + 1);
                  greet();
                }}
              >
                {t`Play it again`}
              </Quiet>
              <Quiet
                onClick={() => {
                  start("type");
                }}
              >
                {t`Type instead, without sound`}
              </Quiet>
              {replayed > 0 ? (
                <Quiet
                  onClick={() => {
                    setSound(false);
                    toMic();
                  }}
                >
                  {t`Go on without sound`}
                </Quiet>
              ) : null}
            </div>
          </div>
        ) : (
          <MicStep
            check={check}
            device={device}
            devices={devices}
            hearing={hearing}
            mic={mic}
            onChoose={(id) => {
              void choose(id);
            }}
            onRetry={() => {
              void reach(open);
            }}
            onStart={start}
          />
        )}
      </div>
    </div>
  );
};
