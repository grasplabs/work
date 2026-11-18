import { turnAnswerMax } from "@grasp-os/shared/interview-turn";
import type { FactTag } from "@grasp-os/shared/interview-turn";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { Button } from "../grasp/button/index.ts";
import { ChatMessage } from "../grasp/chat-message/index.ts";
import { Composer as Box } from "../grasp/composer/index.ts";
import { arrive } from "../grasp/motion/arrive.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { useSaveState } from "./kept.ts";
import type { LoopState, Said } from "./loop.ts";
import { Marked } from "./talk.tsx";
import { VoiceBar } from "./voice-bar.tsx";
import type { BarDoing } from "./voice-bar.tsx";

// The box at the bottom (prototype `interview-view.tsx`, `Composer` and
// `ChatBox`): Grasp UI's Composer, as in any chat. Enter sends,
// Shift+Enter starts a new line, and an answer stops at the most one turn
// takes. For whoever chose to talk, a voice bar takes the card over: while
// Stephen talks or thinks, and while he listens, with the way to mute
// themselves for a moment; "Type instead" brings the box back at once, for
// the rest of his line. What they just said shows over it, as their side
// of the chat, with what Stephen marked in it; when it is long, its newest
// words stay and its top fades out under the stage.

const styles = stylex.create({
  root: { position: "relative", display: "flex", flexDirection: "column" },
  over: {
    position: "absolute",
    insetInline: 0,
    bottom: "100%",
    display: "flex",
    justifyContent: "flex-end",
    marginBlockEnd: grasp.space4,
    pointerEvents: "none",
  },
  // It grows upward to the room kept over the box, newest words at its foot; its top fades out under the stage.
  said: {
    display: "flex",
    flexDirection: "column",
    justifyContent: "flex-end",
    width: "100%",
    maxHeight: "5rem",
    overflow: "hidden",
    maskImage: "linear-gradient(to bottom, transparent 0, black 3.5rem)",
  },
  box: { width: "100%", maxWidth: "none" },
  trouble: {
    paddingInline: grasp.space5,
    paddingBlockEnd: grasp.space2,
    textAlign: "center",
    textWrap: "balance",
    color: grasp.attention,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
  },
});

/** The box to type in, its text kept by the caller so it outlasts the bar; the cursor in it from the start. */
const ChatBox = ({
  text,
  setText,
  placeholder,
  bar,
  onSend,
}: {
  text: string;
  setText: (text: string) => void;
  placeholder: string;
  /** The voice bar, in the text's place while they talk. */
  bar: ReactNode;
  onSend: (text: string) => void;
}) => {
  const { t } = useLingui();
  const room = useRef<HTMLDivElement>(null);
  // The cursor is in the box, so typing is all it takes.
  useEffect(() => {
    room.current?.querySelector("textarea")?.focus({ preventScroll: true });
  }, []);
  return (
    <div ref={room}>
      <Box
        aria-label={t`Your answer`}
        compact
        layout={styles.box}
        maxLength={turnAnswerMax}
        onSend={(sent: string) => {
          const trimmed = sent.trim();
          if (trimmed !== "") {
            onSend(trimmed);
            setText("");
          }
        }}
        onValueChange={(value: string) => {
          setText(value);
        }}
        placeholder={placeholder}
        takeover={bar}
        value={text}
      />
    </div>
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
  const [text, setText] = useState("");
  // The line during which they asked to type instead: the box stays until his next.
  const [typing, setTyping] = useState<number | null>(null);
  const bar = talking && text === "" && typing !== line && doing !== "idle";
  let barDoing: BarDoing = "thinking";
  if (doing === "speaking" || doing === "listening") {
    barDoing = doing;
  }
  return (
    <div {...stylex.props(styles.root)}>
      <div {...stylex.props(styles.over)}>
        {said === null ? null : (
          <div key={said.text} {...stylex.props(styles.said, arrive.in)}>
            <ChatMessage from="person">
              <Marked marks={said.marks} names={names} text={said.text} />
              {said.waiting ? (
                <Text element="span" tone="muted">
                  {" "}
                  …
                </Text>
              ) : null}
            </ChatMessage>
          </div>
        )}
      </div>
      <ChatBox
        bar={
          bar ? (
            <VoiceBar doing={barDoing} mute>
              <Button
                onClick={() => {
                  setTyping(line);
                }}
                size="md"
                variant="ghost"
              >
                {t`Type instead`}
              </Button>
            </VoiceBar>
          ) : undefined
        }
        onSend={onSend}
        placeholder={placeholder}
        setText={setText}
        text={text}
      />
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
      <Text element="span" size="xs" tone="muted">
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
