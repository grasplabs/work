import { turnAnswerMax } from "@grasp-os/shared/interview-turn";
import type { FactTag } from "@grasp-os/shared/interview-turn";
import { Button } from "@grasp-os/ui/components/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@grasp-os/ui/components/input-group";
import { Spinner } from "@grasp-os/ui/components/spinner";
import { useLingui } from "@lingui/react/macro";
import { ArrowUpIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useSaveState } from "./kept.ts";
import type { LoopState, Said } from "./loop.ts";
import { Marked, Own } from "./talk.tsx";
import { VoiceBar } from "./voice-bar.tsx";

// The box at the bottom (prototype `interview-view.tsx`, `Composer` and
// `ChatBox`): as in any chat, only larger and rounder. Enter sends,
// Shift+Enter starts a new line. For whoever chose to talk, it becomes a
// voice bar while Stephen talks or thinks, and the box again when it is
// their turn, until his ears come; "Type instead" brings the box back at
// once, for the rest of his line. What they just said shows over it, as
// their side of the chat, with what Stephen marked in it; when it is long,
// its newest words stay and its top fades out under the stage.

/** The box to type in: one line at rest, growing with what is typed. */
const ChatBox = ({
  text,
  setText,
  placeholder,
  thinking,
  onSend,
}: {
  /** What is typed: kept by the composer, so it outlasts the bar. */
  text: string;
  setText: (text: string) => void;
  placeholder: string;
  thinking: boolean;
  onSend: (text: string) => void;
}) => {
  const { t } = useLingui();
  const field = useRef<HTMLTextAreaElement>(null);
  // The cursor is in the box, so typing is all it takes.
  useEffect(() => {
    field.current?.focus({ preventScroll: true });
  }, []);
  // Longer than one answer may be: said before it is sent, so nothing is cut without them knowing.
  const tooLong = text.trim().length > turnAnswerMax;
  const ready = text.trim() !== "" && !tooLong;
  const send = (): void => {
    if (ready) {
      onSend(text.trim());
      setText("");
    }
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <InputGroup size="lg">
        <InputGroupTextarea
          aria-invalid={tooLong || undefined}
          aria-label={t`Your answer`}
          className="max-h-40 min-h-0"
          onChange={(event) => {
            setText(event.target.value);
          }}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              send();
            }
          }}
          placeholder={placeholder}
          ref={field}
          rows={1}
          value={text}
        />
        <InputGroupAddon align="inline-end" className="self-end">
          <InputGroupButton
            aria-label={t`Send`}
            disabled={!ready}
            size="icon-lg"
            type="submit"
            variant={ready ? "default" : "secondary"}
          >
            {thinking && !ready ? <Spinner /> : <ArrowUpIcon />}
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      {tooLong ? (
        <p
          aria-live="polite"
          className="text-muted-foreground px-5 pt-2 text-xs"
        >
          {t`That is too long to send in one go. Send it in two parts.`}
        </p>
      ) : null}
    </form>
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
  const bar =
    talking &&
    text === "" &&
    typing !== line &&
    (doing === "speaking" || doing === "thinking");
  return (
    <div className="relative flex flex-col">
      <div className="pointer-events-none absolute inset-x-0 bottom-full mb-4 flex justify-end">
        {said === null ? null : (
          // It grows upward to the room kept over the box, newest words at its foot; its top fades out under the stage.
          <div
            className="animate-in fade-in slide-in-from-bottom-2 flex max-h-20 w-full flex-col justify-end overflow-hidden mask-t-from-14 mask-t-to-20 duration-300"
            key={said.text}
          >
            <Own>
              <Marked marks={said.marks} names={names} text={said.text} />
              {said.waiting ? (
                <span className="text-muted-foreground"> …</span>
              ) : null}
            </Own>
          </div>
        )}
      </div>
      {bar ? (
        <div
          className="animate-in fade-in slide-in-from-bottom-1 duration-300"
          key="bar"
        >
          <VoiceBar doing={doing === "speaking" ? "speaking" : "thinking"}>
            <Button
              onClick={() => {
                setTyping(line);
              }}
              size="lg"
              variant="ghost"
            >
              {t`Type instead`}
            </Button>
          </VoiceBar>
        </div>
      ) : (
        <div
          className="animate-in fade-in slide-in-from-bottom-1 duration-300"
          key="box"
        >
          <ChatBox
            onSend={onSend}
            placeholder={placeholder}
            setText={setText}
            text={text}
            thinking={doing === "thinking"}
          />
        </div>
      )}
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
    <span aria-live="polite" className="text-muted-foreground text-xs">
      {state === "saved" ? t`Saved` : t`Saving…`}
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
    <p
      aria-live="polite"
      className="text-status-attention px-5 pb-2 text-center text-xs text-balance"
    >
      {text}
    </p>
  );
};
