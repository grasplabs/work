import { turnAnswerMax } from "@grasp-os/shared/interview-turn";
import type { FactTag } from "@grasp-os/shared/interview-turn";
import { Bubble, BubbleContent } from "@grasp-os/ui/components/bubble";
import {
  PromptInput,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  PromptInputVoice,
} from "@grasp-os/ui/components/prompt-input";
import { AudioWaveformIcon, Icon } from "@grasp-os/ui/lib/icons";
import { fadeIn } from "@grasp-os/ui/lib/styles";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";
import type { ReactNode } from "react";

import { TopError } from "../frame/top-error.tsx";
import { Heard } from "./heard.tsx";
import { useProgress, useSaveState } from "./kept.ts";
import type { LoopState, Said } from "./loop.ts";
import { Marked } from "./marked.tsx";
import { micLevel, muteMic, useMicMuted } from "./mic.ts";
import type { MicProblem } from "./mic.ts";

// The box at the bottom (prototype `interview-view.tsx`, `Composer` and
// `ChatBox`): Damsko's PromptInput, as in any chat. Enter sends,
// Shift+Enter starts a new line, and an answer stops at the most the
// notes read of one. For whoever chose to talk, the card is a spoken conversation
// (PromptInputVoice) while Stephen talks or thinks and while he listens:
// what they say written over it as it is heard (heard.tsx), the card one
// slim row with the sound as a field of light, the
// way to mute themselves for a moment, and the way to type instead, which
// brings the box back at once for the rest of his line. The product hears
// and speaks (mic.ts, speech.ts); the card only draws what it is told.
// Typed, what they just said shows over the box, as their side of the
// chat, with what Stephen marked in it; when it is long, its newest words
// stay and its top fades out under the stage.

const styles = stylex.create({
  root: { position: "relative", display: "flex", flexDirection: "column" },
  // The card in the middle of its room, however wide the room is.
  card: { width: "100%", marginInline: "auto" },
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
});

/** Whether `target` is in the box's text, where they type. */
const inText = (target: EventTarget | null): boolean =>
  target instanceof Element &&
  target.closest('[data-slot="prompt-input-body"]') !== null;

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
 * The conversation, spoken, in the card's place: the microphone theirs to
 * mute, and "Type instead" as the way out. The card answers their voice
 * alone: while Stephen talks or thinks its field lies flat, and no time
 * runs in it, for the minutes left stand in the header.
 */
const Spoken = ({
  doing,
  onType,
}: {
  doing: LoopState["doing"];
  onType: () => void;
}) => {
  const muted = useMicMuted();
  const listening = doing === "listening";
  return (
    <PromptInputVoice
      muted={muted}
      onClose={onType}
      onMutedChange={muteMic}
      sample={() => ({ level: listening ? micLevel() : 0 })}
      status={listening ? "listening" : "speaking"}
      timed={false}
    />
  );
};

export const Composer = ({
  placeholder,
  talking,
  micTrouble,
  doing,
  line,
  said,
  names,
  onSend,
  onTalk,
  onTyping,
}: {
  placeholder: string;
  /** They chose to talk, not to type. */
  talking: boolean;
  /** Why there is no microphone while they type, if there isn't: the top bar says so. */
  micTrouble: MicProblem | null;
  doing: LoopState["doing"];
  /** Which of his lines is on screen. */
  line: number;
  said: Said | null;
  names: Record<FactTag, string>;
  onSend: (text: string) => void;
  /** Back to talking, for whoever types now: the microphone is asked for again. */
  onTalk: () => void;
  /** They are typing: whoever they talk with waits for it. */
  onTyping: () => void;
}) => {
  const { t } = useLingui();
  // Whether something is typed: the card is spoken only while the box is empty.
  const [typed, setTyped] = useState(false);
  // The line during which they asked to type instead: the box stays until his next, or "Talk".
  const [typing, setTyping] = useState<number | null>(null);
  // While they are in the box it stays theirs, his next line or not: it never goes from under
  // their cursor, nor hands their focus to the mute as it goes.
  const [inBox, setInBox] = useState(false);
  const typingOn = typing === line || (typing !== null && inBox);
  const spoken = talking && !typed && !typingOn && doing !== "idle";
  // How many lines of theirs the transcript holds: one more, and what stands over the card goes there.
  const sent = useProgress().lines.filter(
    ({ from }) => from === "person"
  ).length;
  return (
    <div
      onBlur={(event) => {
        if (!inText(event.relatedTarget)) {
          setInBox(false);
        }
      }}
      onFocus={(event) => {
        setInBox(inText(event.target));
      }}
      {...stylex.props(styles.root)}
    >
      <div {...stylex.props(styles.over)}>
        {/* What they said as he took it, with what he marked: what is still on its way is Heard's. */}
        {said === null || said.waiting || spoken ? null : (
          <div key={said.text} {...stylex.props(styles.said, fadeIn)}>
            <Bubble align="end" variant="secondary">
              <BubbleContent>
                <SaidWords names={names} said={said} />
              </BubbleContent>
            </Bubble>
          </div>
        )}
      </div>
      {/* Theirs while it is on its way, typed or said, in one place and one motion whichever way
          they switch while they answer; once kept it is the transcript's, and goes there. */}
      <Heard sent={sent} text={said?.waiting === true ? said.text : ""} />
      <PromptInput
        compact
        style={styles.card}
        maxLength={turnAnswerMax}
        onSubmit={({ text }) => {
          const trimmed = text.trim();
          if (trimmed !== "") {
            onSend(trimmed);
          }
        }}
        onValueChange={(value) => {
          const holds = holdsWords(value);
          setTyped(holds);
          if (holds) {
            onTyping();
          }
        }}
      >
        {/* No microphone: said in the top bar, like every error here; "Talk" in the card asks again. */}
        {micTrouble === null ? null : (
          <TopError>
            {micTrouble === "blocked"
              ? t`Your browser blocked the microphone.`
              : t`The microphone is not available here. Type your answer.`}
          </TopError>
        )}
        {spoken ? (
          <Spoken
            doing={doing}
            onType={() => {
              setTyping(line);
            }}
          />
        ) : (
          <>
            <PromptInputBody>
              <PromptInputTextarea
                aria-label={t({
                  message: "Your answer",
                  context: "the person interviewed",
                })}
                // The cursor is in the box, so typing is all it takes.
                autoFocus
                placeholder={placeholder}
              />
            </PromptInputBody>
            <PromptInputFooter>
              <PromptInputTools>
                <PromptInputButton
                  onClick={() => {
                    if (talking) {
                      setTyping(null);
                    } else {
                      onTalk();
                    }
                  }}
                  tooltip={t`Switch back to voice`}
                >
                  <Icon icon={AudioWaveformIcon} />
                  {t`Talk`}
                </PromptInputButton>
              </PromptInputTools>
              <PromptInputSubmit />
            </PromptInputFooter>
          </>
        )}
      </PromptInput>
    </div>
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
  // In the bar at the top, as every error here is.
  return <TopError>{text}</TopError>;
};
