/**
 * The Voice Lab: Grasp's staff talk with Stephen as one live
 * voice session at Mistral (src/admin/voice-lab.ts), to hear how it
 * compares with the interview as core holds it. The page shows where the
 * call stands, what was said as Mistral wrote it down, and how long each
 * answer took to begin.
 */
import { Badge } from "@grasp-os/app-kit/components/badge";
import { Bubble, BubbleContent } from "@grasp-os/app-kit/components/bubble";
import { Button } from "@grasp-os/app-kit/components/button";
import {
  NativeSelect,
  NativeSelectOption,
} from "@grasp-os/app-kit/components/native-select";
import { Stat } from "@grasp-os/app-kit/components/stat";
import { interviewLocales } from "@grasp-os/shared/onboarding";
import type { InterviewLocale } from "@grasp-os/shared/onboarding";
import { MicIcon, MicOffIcon, PhoneIcon, PhoneOffIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { EmptySection, Section, SectionRow } from "./section.tsx";
import { beginCall, noCall } from "./voice-lab-call.ts";
import type {
  AgentState,
  Call,
  Calling,
  CallTrouble,
} from "./voice-lab-call.ts";
import { medianOf, replyTimes } from "./voice-lab-heard.ts";

/** Each language Stephen speaks, by its own name. */
const languageWords: Record<InterviewLocale, string> = {
  en: "English",
  nl: "Nederlands",
  de: "Deutsch",
  fr: "Français",
  es: "Español",
};

/** What went wrong, in words someone can act on. */
const troubles: Record<CallTrouble, string> = {
  no_key: "Grasp's Mistral key isn't in Secrets Store for this admin.",
  not_opened:
    "Mistral didn't open a session. Voice agents may not be enabled for Grasp's key.",
  not_connected:
    "The page couldn't join the session. Check that the microphone is allowed.",
  broke_off: "The session broke off.",
};

/** What the interviewer is doing, in a word. */
const agentWords: Record<AgentState, string> = {
  initializing: "Starting",
  idle: "Waiting",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
};

/** Where the call stands, as its badge says it. */
const Standing = ({ call }: { call: Call }) => {
  if (call.stands === "connecting") {
    return <Badge>Connecting</Badge>;
  }
  if (call.stands === "live") {
    return (
      <Badge variant={call.agent === "speaking" ? "passed" : "default"}>
        {call.agent === null ? "Connected" : agentWords[call.agent]}
      </Badge>
    );
  }
  return call.stands === "over" ? <Badge>Ended</Badge> : null;
};

/** A time in ms as a figure in seconds: 0.65 s. */
const seconds = (ms: number): string => `${(ms / 1000).toFixed(2)} s`;

/** How fast he answered: the middle answer, the last, and how many were timed. */
const Timing = ({ call }: { call: Call }) => {
  const times = replyTimes(call.moments);
  const median = medianOf(times);
  const last = times.at(-1);
  return (
    <Section
      description="From your last words written down to his voice starting. The silence Mistral waits before it decides you are done comes on top."
      title="How fast he answers"
    >
      <SectionRow label="Middle answer">
        <Stat>{median === null ? "–" : seconds(median)}</Stat>
      </SectionRow>
      <SectionRow label="Last answer">
        <Stat>{last === undefined ? "–" : seconds(last)}</Stat>
      </SectionRow>
      <SectionRow label="Answers timed">
        <Stat>{times.length}</Stat>
      </SectionRow>
    </Section>
  );
};

/** What was said, as Mistral wrote it down: theirs on the right, his on the left. */
const Conversation = ({ call }: { call: Call }) => {
  if (call.said.length === 0) {
    return (
      <EmptySection>
        What you and Stephen say shows here as it is said. Nothing of it is
        kept.
      </EmptySection>
    );
  }
  return (
    <Section
      description="As Mistral writes it down while you talk. It is gone when you leave this page."
      title="What was said"
    >
      <ol aria-live="polite" className="flex flex-col gap-3 p-4">
        {call.said.map(({ id, role, content }) =>
          role === "user" ? (
            <li className="flex justify-end" key={id}>
              <Bubble align="end" variant="secondary">
                <BubbleContent className="whitespace-pre-wrap">
                  {content}
                </BubbleContent>
              </Bubble>
            </li>
          ) : (
            <li className="max-w-prose whitespace-pre-wrap" key={id}>
              {content}
            </li>
          )
        )}
      </ol>
    </Section>
  );
};

/** The language of the try-out, chosen before the call. */
const Language = ({
  busy,
  locale,
  onLocale,
}: {
  busy: boolean;
  locale: InterviewLocale;
  onLocale: (locale: InterviewLocale) => void;
}) => (
  <NativeSelect
    aria-label="Language"
    disabled={busy}
    onChange={(event) => {
      onLocale(
        interviewLocales.find((each) => each === event.target.value) ?? "en"
      );
    }}
    value={locale}
  >
    {interviewLocales.map((each) => (
      <NativeSelectOption key={each} value={each}>
        {languageWords[each]}
      </NativeSelectOption>
    ))}
  </NativeSelect>
);

/** The Voice Lab: the language, the call's controls, the conversation and its timing. */
export const VoiceLab = () => {
  const [locale, setLocale] = useState<InterviewLocale>("en");
  const [call, setCall] = useState<Call>(noCall);
  const calling = useRef<Calling | null>(null);
  // Leaving the page ends the call: the microphone is let go, and the session closed.
  useEffect(
    () => () => {
      calling.current?.end();
    },
    []
  );
  const busy = call.stands === "connecting" || call.stands === "live";
  const start = () => {
    calling.current = beginCall({ locale }, setCall);
  };
  const end = () => {
    calling.current?.end();
    calling.current = null;
  };
  return (
    <div className="flex flex-col gap-6">
      <Section
        action={<Standing call={call} />}
        description="A try-out of the interview as one live voice session at Mistral: it listens, answers and speaks there, and you can talk over him. Play an employee; your audio goes from this browser to Mistral."
        title="Talk with Stephen"
      >
        <div className="flex flex-wrap items-center gap-3 p-4">
          <Language busy={busy} locale={locale} onLocale={setLocale} />
          {busy ? (
            <>
              <Button
                disabled={call.stands !== "live"}
                onClick={() => {
                  calling.current?.setMuted(!call.muted);
                }}
                variant="outline"
              >
                {call.muted ? <MicOffIcon /> : <MicIcon />}
                {call.muted ? "Unmute" : "Mute"}
              </Button>
              <Button onClick={end} variant="destructive">
                <PhoneOffIcon />
                End
              </Button>
            </>
          ) : (
            <Button onClick={start}>
              <PhoneIcon />
              {call.stands === "over" ? "Talk again" : "Start talking"}
            </Button>
          )}
        </div>
        {call.trouble === null ? null : (
          <p className="text-destructive px-4 pb-4" role="alert">
            {troubles[call.trouble]}
            {call.detail === null ? null : ` (${call.detail})`}
          </p>
        )}
      </Section>
      <Timing call={call} />
      <Conversation call={call} />
    </div>
  );
};
