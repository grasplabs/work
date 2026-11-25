import { turnAnswerMax } from "@grasp-os/shared/interview-turn";
import type { FactTag } from "@grasp-os/shared/interview-turn";
import { interviewerNames } from "@grasp-os/shared/onboarding";
import { AgentIndicator } from "@grasp-os/ui/components/agent-indicator";
import { Bubble, BubbleContent } from "@grasp-os/ui/components/bubble";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputVoice,
} from "@grasp-os/ui/components/prompt-input";
import { Text } from "@grasp-os/ui/components/text";
import { fadeIn } from "@grasp-os/ui/lib/styles";
import { colors, font, space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";
import type { ReactNode } from "react";

import { useInterviewer, useSaveState } from "./kept.ts";
import type { LoopState, Said } from "./loop.ts";
import { micLevel, muteMic, useMicMuted } from "./mic.ts";
import { voiceLevel } from "./speech.ts";
import { Marked } from "./talk.tsx";

// The box at the bottom (prototype `interview-view.tsx`, `Composer` and
// `ChatBox`): Damsko's PromptInput, as in any chat. Enter sends,
// Shift+Enter starts a new line, and an answer stops at the most one turn
// takes. For whoever chose to talk, the card is a spoken conversation
// (PromptInputVoice) while Stephen talks or thinks and while he listens:
// what they say so far written in it, the sound as a field of light, the
// way to mute themselves for a moment, and the way to type instead, which
// brings the box back at once for the rest of his line. The product hears
// and speaks (mic.ts, speech.ts); the card only draws what it is told.
// Typed, what they just said shows over the box, as their side of the
// chat, with what Stephen marked in it; when it is long, its newest words
// stay and its top fades out under the stage.

const styles = stylex.create({
  root: { position: "relative", display: "flex", flexDirection: "column" },
  over: {
    position: "absolute",
    insetInline: 0,
    bottom: "100%",
    display: "flex",
    justifyContent: "flex-end",
    marginBlockEnd: space["4"],
    pointerEvents: "none",
  },
  // It grows upward to the room kept over the box, newest words at its foot; its top fades out under the stage.
  said: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    justifyContent: "flex-end",
    width: "100%",
    maxHeight: "5rem",
    overflow: "hidden",
    maskImage: "linear-gradient(to bottom, transparent 0, black 3.5rem)",
  },
  trouble: {
    paddingInline: space["5"],
    paddingBlockEnd: space["2"],
    textAlign: "center",
    textWrap: "balance",
    color: colors.warning,
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
  },
});

/** Whether a PromptInput's value holds anything but spaces. */
const holdsWords = (value: readonly unknown[]): boolean =>
  value.some((part) => typeof part !== "string" || part.trim() !== "");

/** What they said, with what Stephen marked in it: plain words resolve one by one as they come. */
const SaidWords = ({
  said,
  names,
}: {
  said: Said;
  names: Record<FactTag, string>;
}): ReactNode =>
  said.marks.length === 0 ? (
    said.text
  ) : (
    <Marked marks={said.marks} names={names} text={said.text} />
  );

/**
 * The conversation, spoken, in the card's place: their words while it is
 * their turn, his mark while it is his (thinking counts as his), the
 * microphone theirs to mute, and "Type instead" as the way out.
 */
const Spoken = ({
  doing,
  said,
  names,
  onType,
}: {
  doing: LoopState["doing"];
  said: Said | null;
  names: Record<FactTag, string>;
  onType: () => void;
}) => {
  const { t } = useLingui();
  const who = interviewerNames[useInterviewer()];
  const muted = useMicMuted();
  const listening = doing === "listening";
  let speaker = t`${who}, thinking.`;
  if (doing === "speaking") {
    speaker = t`${who} is talking`;
  }
  return (
    <PromptInputVoice
      muted={muted}
      onClose={onType}
      onMutedChange={muteMic}
      sample={() => ({ level: listening ? micLevel() : voiceLevel() })}
      speaker={<AgentIndicator aria-label={speaker} />}
      status={listening ? "listening" : "speaking"}
    >
      {said === null ? null : <SaidWords names={names} said={said} />}
    </PromptInputVoice>
  );
};

export const Composer = ({
  placeholder,
  talking,
  doing,
  line,
  said,
  names,
  onSend,
}: {
  placeholder: string;
  /** They chose to talk, not to type. */
  talking: boolean;
  doing: LoopState["doing"];
  /** Which of his lines is on screen. */
  line: number;
  said: Said | null;
  names: Record<FactTag, string>;
  onSend: (text: string) => void;
}) => {
  const { t } = useLingui();
  // Whether something is typed: the card is spoken only while the box is empty.
  const [typed, setTyped] = useState(false);
  // The line during which they asked to type instead: the box stays until his next.
  const [typing, setTyping] = useState<number | null>(null);
  const spoken = talking && !typed && typing !== line && doing !== "idle";
  return (
    <div {...stylex.props(styles.root)}>
      <div {...stylex.props(styles.over)}>
        {said === null || spoken ? null : (
          <div key={said.text} {...stylex.props(styles.said, fadeIn)}>
            <Bubble align="end" variant="secondary">
              <BubbleContent>
                <SaidWords names={names} said={said} />
                {said.waiting ? (
                  <Text as="span" color="muted">
                    {" "}
                    …
                  </Text>
                ) : null}
              </BubbleContent>
            </Bubble>
          </div>
        )}
      </div>
      <PromptInput
        compact
        maxLength={turnAnswerMax}
        onSubmit={({ text }) => {
          const trimmed = text.trim();
          if (trimmed !== "") {
            onSend(trimmed);
          }
        }}
        onValueChange={(value) => {
          setTyped(holdsWords(value));
        }}
      >
        {spoken ? (
          <Spoken
            doing={doing}
            names={names}
            onType={() => {
              setTyping(line);
            }}
            said={said}
          />
        ) : (
          <>
            <PromptInputBody>
              <PromptInputTextarea
                aria-label={t`Your answer`}
                // The cursor is in the box, so typing is all it takes.
                autoFocus
                placeholder={placeholder}
              />
            </PromptInputBody>
            <PromptInputFooter>
              <PromptInputSubmit />
            </PromptInputFooter>
          </>
        )}
      </PromptInput>
    </div>
  );
};

/** Whether what they said is kept, beside the mark: "Saved", or "Saving…" when it takes a moment. */
export const SaveNote = () => {
  const { t } = useLingui();
  const { state } = useSaveState();
  if (state !== "saved" && state !== "saving") {
    return null;
  }
  return (
    <span aria-live="polite">
      <Text as="span" color="muted" size="xs">
        {state === "saved" ? t`Saved` : t`Saving…`}
      </Text>
    </span>
  );
};

/** What they must know about saving, over the box: not kept yet and tried again, taken over by the copy kept elsewhere, or refused. */
export const SaveTrouble = () => {
  const { t } = useLingui();
  const save = useSaveState();
  let text: string | null = null;
  if (save.state === "retrying") {
    text = t`Not saved yet. Trying again.`;
  } else if (save.state === "elsewhere") {
    text = t`This interview went on in another window. You now see that one.`;
  } else if (save.state === "refused") {
    text = save.message;
  }
  return text === null ? null : (
    <p aria-live="polite" {...stylex.props(styles.trouble)}>
      {text}
    </p>
  );
};
