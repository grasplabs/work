import { turnAnswerMax } from "@grasp-os/shared/interview-turn";
import type { FactTag } from "@grasp-os/shared/interview-turn";
import { interviewerNames } from "@grasp-os/shared/onboarding";
import { AgentIndicator } from "@grasp-os/ui/components/agent-indicator";
import { Bubble, BubbleContent } from "@grasp-os/ui/components/bubble";
import { Text } from "@grasp-os/ui/components/text";
import { VoiceComposer } from "@grasp-os/ui/components/voice-composer";
import { fadeIn } from "@grasp-os/ui/lib/styles";
import { colors, font, space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import { useInterviewer, useSaveState } from "./kept.ts";
import type { LoopState, Said } from "./loop.ts";
import { Marked } from "./marked.tsx";
import { micLevel, muteMic } from "./mic.ts";
import { voiceLevel } from "./speech.ts";

// The box at the bottom: Damsko's VoiceComposer, one card to answer in,
// typed or spoken. Enter sends, Shift+Enter starts a new line, and an
// answer stops at the most one turn takes. For whoever chose to talk the
// card listens while Stephen listens: the time runs, the dither along its
// foot rises with their voice, and each word they say is carried up from
// it into the text. While he talks or thinks the dither follows his voice
// and his mark stands where the time was. The round button stops the
// listening (the microphone is off and the box is there to type in, for
// the rest of his line) and starts it again. The product hears and speaks
// (mic.ts, speech.ts); the card only draws what it is told. Typed, what
// they just said shows over the box, as their side of the chat, with what
// Stephen marked in it; when it is long, its newest words stay and its top
// fades out under the stage.

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
  // The browser refused the microphone: one quiet line over the card.
  blocked: {
    paddingInline: space["5"],
    paddingBlockEnd: space["2"],
    color: colors.warning,
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
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

export const Composer = ({
  placeholder,
  talking,
  blocked,
  doing,
  line,
  said,
  names,
  onSend,
  onTalk,
}: {
  placeholder: string;
  /** They chose to talk, not to type. */
  talking: boolean;
  /** The browser refused the microphone: a line over the card says so. */
  blocked: boolean;
  doing: LoopState["doing"];
  /** Which of his lines is on screen. */
  line: number;
  said: Said | null;
  names: Record<FactTag, string>;
  onSend: (text: string) => void;
  /** Back to talking, for whoever types now: the microphone is asked for again. */
  onTalk: () => void;
}) => {
  const { t } = useLingui();
  const who = interviewerNames[useInterviewer()];
  // Whether something is typed: the card is spoken only while the box is empty.
  const [typed, setTyped] = useState(false);
  // The line during which they stopped the listening: the box stays until his next, or the microphone.
  const [typing, setTyping] = useState<number | null>(null);
  const spoken = talking && !typed && typing !== line && doing !== "idle";
  const listening = doing === "listening";
  // Stopped, the microphone is off; it is theirs again as the card listens again.
  const stopped = talking && typing === line;
  useEffect(() => {
    muteMic(stopped);
  }, [stopped]);
  let voice: "off" | "listening" | "speaking" = "off";
  if (spoken) {
    voice = listening ? "listening" : "speaking";
  }
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
      {blocked ? (
        <p aria-live="polite" {...stylex.props(styles.blocked)}>
          {t`Your browser blocked the microphone.`}
        </p>
      ) : null}
      <VoiceComposer
        // The cursor is in the box, so typing is all it takes.
        autoFocus
        heard={said?.text ?? ""}
        labels={{
          text: t`Your answer`,
          listening: t`Listening…`,
          hint: t`Tap and speak`,
          talk: t`Switch back to voice`,
          stop: t`Stop listening`,
          send: t`Send`,
        }}
        maxLength={turnAnswerMax}
        onSubmit={onSend}
        onValueChange={(text) => {
          setTyped(text.trim() !== "");
        }}
        onVoiceChange={(on) => {
          if (!on) {
            setTyping(line);
          } else if (talking) {
            setTyping(null);
          } else {
            onTalk();
          }
        }}
        placeholder={placeholder}
        sample={() => ({ level: listening ? micLevel() : voiceLevel() })}
        speaker={
          <AgentIndicator
            aria-label={
              doing === "speaking" ? t`${who} is talking` : t`${who}, thinking.`
            }
          />
        }
        style={styles.card}
        voice={voice}
      >
        {said !== null && said.marks.length > 0 ? (
          <Marked marks={said.marks} names={names} text={said.text} />
        ) : undefined}
      </VoiceComposer>
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
  return text === null ? null : (
    <p aria-live="polite" {...stylex.props(styles.trouble)}>
      {text}
    </p>
  );
};
