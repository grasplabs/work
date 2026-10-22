/**
 * Ask Grasp's chat (GRA-657), as the prototype's admin draws it
 * (`components/admin/admin-ask.tsx`) in the platform's chat design: when
 * empty, its heading over the box and the questions to start from as a
 * list of rows; then the conversation, the box under it. No files and no
 * model choice: Grasp's own core picks the model. Each question goes with
 * the admin's document as the page shows it now (src/admin/ask-document.ts)
 * and the conversation so far; an answer can be stopped while it comes,
 * copied, and asked again.
 */
import { Bubble, BubbleContent } from "@grasp-os/ui/components/bubble";
import { Button } from "@grasp-os/ui/components/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupTextarea,
} from "@grasp-os/ui/components/input-group";
import { PromptInputSubmit } from "@grasp-os/ui/components/prompt-input";
import { Shimmer } from "@grasp-os/ui/components/shimmer";
import { ChevronRightIcon, CopyIcon, RotateCcwIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { askGraspFn } from "./ask-functions.ts";
import type { AskAnswer, AskRefusal } from "./ask.ts";

/** One thing said: a question, an answer, or why an answer didn't come. */
interface Said {
  role: "user" | "assistant";
  text: string;
  /** Why this turn is no answer, for one that failed. */
  failed?: boolean;
}

/** What the chat says when Grasp didn't answer, by why. */
const refusals: Readonly<Record<AskRefusal, string>> = {
  not_set_up:
    "Ask Grasp isn’t set up yet: the console doesn’t know which deployment is Grasp’s own, or it isn’t deployed.",
  too_long: "This conversation is too long to send at once. Start a new one.",
  refused: "Grasp’s own platform turned the question away.",
  no_model:
    "Grasp’s own platform has no model it may send every company’s numbers to.",
  not_answered: "Grasp didn’t answer. Ask again in a moment.",
};

/** The questions to start from: one organization's call first, when the chat was opened for it. */
const startersFor = (name: string | undefined): string[] => [
  ...(name === undefined
    ? []
    : [
        `Prepare my next call with ${name}: where it stands, what to bring up, and what we still need to know.`,
      ]),
  "What needs us today, across every organization?",
  "Which organizations passed 80%, and which are waiting for our go?",
  "Compare the organizations by hours freed, and say where we could do more.",
  "Which organizations use more AI than their contract covers?",
];

const placeholder = "Ask about an organization, or compare them";

/** The box: a line that grows, and the button that sends, or stops the answer coming. */
const Composer = ({
  waiting,
  onSend,
  onStop,
}: {
  waiting: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
}) => {
  const [text, setText] = useState("");
  const send = () => {
    if (text.trim() === "" || waiting) {
      return;
    }
    onSend(text.trim());
    setText("");
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <InputGroup size="chat">
        <InputGroupTextarea
          aria-label="Your question"
          className="field-sizing-content max-h-40 min-h-0"
          maxLength={8000}
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
          rows={1}
          value={text}
        />
        <InputGroupAddon align="inline-end" className="self-end">
          <PromptInputSubmit
            disabled={!waiting && text.trim() === ""}
            onStop={waiting ? onStop : undefined}
            sendLabel="Send"
            size="icon-xs"
            status={waiting ? "submitted" : "ready"}
            stopLabel="Stop"
            variant={waiting || text.trim() !== "" ? "default" : "secondary"}
          />
        </InputGroupAddon>
      </InputGroup>
    </form>
  );
};

/** An answer's actions: copy it, and ask its question again. */
const AnswerActions = ({
  text,
  onAgain,
}: {
  text: string;
  onAgain: (() => void) | null;
}) => (
  <div className="flex gap-1">
    <Button
      aria-label="Copy the answer"
      onClick={() => {
        void navigator.clipboard.writeText(text);
      }}
      size="icon-xs"
      variant="ghost"
    >
      <CopyIcon />
    </Button>
    {onAgain === null ? null : (
      <Button
        aria-label="Ask again"
        onClick={onAgain}
        size="icon-xs"
        variant="ghost"
      >
        <RotateCcwIcon />
      </Button>
    )}
  </div>
);

/** The chat: `document` is the admin as the page shows it when a question is asked. */
export const AskChat = ({
  document,
  about,
}: {
  document: () => string;
  /** The organization the chat was opened for, whose call it offers to prepare. */
  about?: string;
}) => {
  const [said, setSaid] = useState<Said[]>([]);
  const [waiting, setWaiting] = useState(false);
  // Each question's number: a stopped one's answer, when it comes, is dropped.
  const asked = useRef(0);

  const ask = async (conversation: Said[]): Promise<void> => {
    asked.current += 1;
    const mine = asked.current;
    setSaid(conversation);
    setWaiting(true);
    let answer: AskAnswer = {
      text: null,
      truncated: false,
      refused: "not_answered",
    };
    try {
      answer = await askGraspFn({
        data: {
          document: document(),
          said: conversation
            .filter(({ failed }) => failed !== true)
            .map(({ role, text }) => ({ role, text })),
        },
      });
    } catch {
      // Said as not answered.
    }
    if (mine !== asked.current) {
      return;
    }
    setWaiting(false);
    setSaid([
      ...conversation,
      answer.refused === null
        ? {
            role: "assistant",
            text: answer.truncated
              ? `${answer.text}\n\n(The answer stopped at its length limit.)`
              : answer.text,
          }
        : { role: "assistant", text: refusals[answer.refused], failed: true },
    ]);
  };
  const send = (text: string) => {
    void ask([...said, { role: "user", text }]);
  };
  // Opened from an organization's brief, its call is prepared at once: that is what the button said.
  const prepared = useRef(false);
  useEffect(() => {
    const [first] = startersFor(about);
    if (prepared.current || about === undefined || first === undefined) {
      return;
    }
    prepared.current = true;
    send(first);
  });
  const stop = () => {
    asked.current += 1;
    setWaiting(false);
  };
  /** Asks the question before answer `index` again, in place of that answer and what followed. */
  const again = (index: number) => () => {
    void ask(said.slice(0, index));
  };

  if (said.length === 0) {
    return (
      <div className="flex min-h-full items-center justify-center px-6 py-12">
        <div className="flex w-full max-w-3xl flex-col gap-8 pb-10">
          <h2 className="text-center text-2xl font-medium tracking-tight text-balance">
            Ask about every organization
          </h2>
          <div className="flex flex-col gap-3">
            <Composer onSend={send} onStop={stop} waiting={waiting} />
            <ul
              aria-label="Questions to start from"
              className="bg-card overflow-hidden rounded-xl border"
            >
              {startersFor(about).map((starter) => (
                <li className="border-b last:border-b-0" key={starter}>
                  <button
                    className="hover:bg-muted/60 focus-visible:bg-muted/60 flex w-full items-center gap-3 px-3.5 py-2.5 text-left outline-none"
                    onClick={() => {
                      send(starter);
                    }}
                    type="button"
                  >
                    <span className="min-w-0 flex-1 text-pretty">
                      {starter}
                    </span>
                    <ChevronRightIcon
                      aria-hidden="true"
                      className="text-muted-foreground size-4 flex-none"
                    />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ol
          aria-label="The conversation"
          className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6 md:px-6"
        >
          {said.map((turn, index) =>
            turn.role === "user" ? (
              <li className="flex justify-end" key={index}>
                <Bubble align="end" variant="secondary">
                  <BubbleContent className="whitespace-pre-wrap">
                    {turn.text}
                  </BubbleContent>
                </Bubble>
              </li>
            ) : (
              <li className="flex flex-col gap-1" key={index}>
                <p
                  className={
                    turn.failed === true
                      ? "text-destructive whitespace-pre-wrap"
                      : "whitespace-pre-wrap"
                  }
                  role={turn.failed === true ? "alert" : undefined}
                >
                  {turn.text}
                </p>
                <AnswerActions
                  onAgain={waiting ? null : again(index)}
                  text={turn.text}
                />
              </li>
            )
          )}
          {waiting ? (
            <li>
              <Shimmer>Reading the admin</Shimmer>
            </li>
          ) : null}
        </ol>
      </div>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-4 pb-4 md:px-6">
        <Composer onSend={send} onStop={stop} waiting={waiting} />
        <p className="text-muted-foreground text-center text-xs">
          Grasp answers from the admin’s own numbers. It never sees what anyone
          said in an interview.
        </p>
      </div>
    </div>
  );
};
