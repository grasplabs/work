/**
 * The Voice Lab: Grasp's staff talk with Stephen as one live
 * voice session at Mistral (src/admin/voice-lab.ts), to hear how it
 * compares with the interview as core holds it. The page shows where the
 * call stands, what was said as Mistral wrote it down, and how long each
 * answer took to begin.
 */
import { interviewLocales } from "@grasp-os/shared/onboarding";
import type { InterviewLocale } from "@grasp-os/shared/onboarding";
import { Alert, AlertDescription } from "@grasp-os/ui/components/alert";
import { Badge } from "@grasp-os/ui/components/badge";
import { Bubble, BubbleContent } from "@grasp-os/ui/components/bubble";
import { Button } from "@grasp-os/ui/components/button";
import { CardContent } from "@grasp-os/ui/components/card";
import {
  NativeSelect,
  NativeSelectOption,
} from "@grasp-os/ui/components/native-select";
import { StatGroup } from "@grasp-os/ui/components/stat";
import { Icon, MicIcon } from "@grasp-os/ui/lib/icons";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef, useState } from "react";

import { EmptyPanel, Panel } from "./panel.tsx";
import { beginCall, noCall } from "./voice-lab-call.ts";
import type {
  AgentState,
  Call,
  Calling,
  CallTrouble,
} from "./voice-lab-call.ts";
import { medianOf, replyTimes } from "./voice-lab-heard.ts";

const styles = stylex.create({
  page: { display: "flex", flexDirection: "column", gap: space["6"] },
  controls: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space["3"],
  },
  // As wide as its longest language, beside the call's buttons.
  language: { width: "auto" },
  said: {
    display: "flex",
    flexDirection: "column",
    gap: space["3"],
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  theirs: { display: "flex", justifyContent: "flex-end" },
  his: { maxWidth: "65ch", whiteSpace: "pre-wrap" },
});

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
      <Badge variant={call.agent === "speaking" ? "success" : "default"}>
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
    <Panel
      description="From your last words written down to his voice starting. The silence Mistral waits before it decides you are done comes on top."
      title="How fast he answers"
    >
      <CardContent>
        <StatGroup
          aria-label="How fast he answers"
          items={[
            {
              label: "Middle answer",
              value: median === null ? "–" : seconds(median),
            },
            {
              label: "Last answer",
              value: last === undefined ? "–" : seconds(last),
            },
            { label: "Answers timed", value: String(times.length) },
          ]}
        />
      </CardContent>
    </Panel>
  );
};

/**
 * What Mistral kept of the call, once it is over: how often he spoke, and
 * how often it heard them talk over him. Talking over him that it never
 * counted was not heard; counted but heard on, it was not acted on.
 */
const Record = ({ call }: { call: Call }) =>
  call.record === null ? null : (
    <Panel
      description="As Mistral recorded the call once it ended: how often Stephen spoke, and how often it heard you talk over him and cut him off."
      title="Talking over him"
    >
      <CardContent>
        <StatGroup
          aria-label="Talking over him"
          items={[
            { label: "Times he spoke", value: String(call.record.spoke) },
            { label: "Times cut off", value: String(call.record.cutOff) },
          ]}
        />
      </CardContent>
    </Panel>
  );

/** What was said, as Mistral wrote it down: theirs on the right, his on the left. */
const Conversation = ({ call }: { call: Call }) => {
  if (call.said.length === 0) {
    return (
      <EmptyPanel>
        What you and Stephen say shows here as it is said. Nothing of it is
        kept.
      </EmptyPanel>
    );
  }
  return (
    <Panel
      description="As Mistral writes it down while you talk. It is gone when you leave this page."
      title="What was said"
    >
      <CardContent>
        <ol aria-live="polite" {...stylex.props(styles.said)}>
          {call.said.map(({ id, role, content }) =>
            role === "user" ? (
              <li key={id} {...stylex.props(styles.theirs)}>
                <Bubble align="end" variant="secondary">
                  <BubbleContent>{content}</BubbleContent>
                </Bubble>
              </li>
            ) : (
              <li key={id} {...stylex.props(styles.his)}>
                {content}
              </li>
            )
          )}
        </ol>
      </CardContent>
    </Panel>
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
    style={styles.language}
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
  const latest = useRef<symbol | null>(null);
  // Leaving the page ends the call: the microphone is let go, and the session closed.
  useEffect(
    () => () => {
      calling.current?.end();
    },
    []
  );
  const busy = call.stands === "connecting" || call.stands === "live";
  const start = () => {
    // Only the latest call shows: one ended a moment ago may still answer
    // its close after "Talk again".
    const mine = Symbol("call");
    latest.current = mine;
    calling.current = beginCall({ locale }, (next) => {
      if (latest.current === mine) {
        setCall(next);
      }
    });
  };
  const end = () => {
    calling.current?.end();
    calling.current = null;
  };
  return (
    <div {...stylex.props(styles.page)}>
      <Panel
        action={<Standing call={call} />}
        description="A try-out of the interview as one live voice session at Mistral: it listens, answers and speaks there, and you can talk over him. Play an employee; your audio goes from this browser to Mistral."
        title="Talk with Stephen"
      >
        <CardContent>
          <div {...stylex.props(styles.controls)}>
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
                  {call.muted ? "Unmute" : "Mute"}
                </Button>
                <Button onClick={end} variant="destructive">
                  End
                </Button>
              </>
            ) : (
              <Button onClick={start}>
                <Icon icon={MicIcon} />
                {call.stands === "over" ? "Talk again" : "Start talking"}
              </Button>
            )}
          </div>
        </CardContent>
        {call.trouble === null ? null : (
          <CardContent>
            <Alert appearance="subtle" variant="destructive">
              <AlertDescription>
                {troubles[call.trouble]}
                {call.detail === null ? null : ` (${call.detail})`}
              </AlertDescription>
            </Alert>
          </CardContent>
        )}
      </Panel>
      <Timing call={call} />
      <Record call={call} />
      <Conversation call={call} />
    </div>
  );
};
