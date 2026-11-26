/**
 * Ask Grasp's chat (GRA-657), as the prototype's admin draws it
 * (`components/admin/admin-ask.tsx`) in the platform's chat design: when
 * empty, its heading over the box and the questions to start from as a
 * list of rows; then the conversation, the box under it. No files and no
 * model choice: Ask Grasp's model is fixed (src/admin/ask.ts). Each question goes with
 * the admin's document as the page shows it now (src/admin/ask-document.ts)
 * and the conversation so far; an answer can be stopped while it comes,
 * copied, and asked again.
 */
import { Bubble, BubbleContent } from "@grasp-os/ui/components/bubble";
import { Button } from "@grasp-os/ui/components/button";
import { Heading } from "@grasp-os/ui/components/heading";
import {
  Item,
  ItemContent,
  ItemGroup,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
} from "@grasp-os/ui/components/prompt-input";
import { Shimmer } from "@grasp-os/ui/components/shimmer";
import { Text } from "@grasp-os/ui/components/text";
import { CopyIcon, Icon, RefreshCwIcon } from "@grasp-os/ui/lib/icons";
import { colors, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef, useState } from "react";

import { askGraspFn } from "./ask-functions.ts";
import type { AskAnswer, AskRefusal } from "./ask.ts";

const styles = stylex.create({
  // Before anything is asked: the heading, the box and the questions to
  // start from, in the middle of the page.
  start: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "100%",
    paddingInline: space["6"],
    paddingBlock: space["12"],
  },
  startColumn: {
    display: "flex",
    flexDirection: "column",
    gap: space["8"],
    width: "100%",
    maxWidth: "48rem",
    paddingBlockEnd: space["10"],
  },
  centred: { alignSelf: "center" },
  // As wide as the column it stands in, as the box was.
  composer: { width: "100%", maxWidth: "none" },
  stack: { display: "flex", flexDirection: "column", gap: space["3"] },
  // The conversation over the box, held to the window.
  chat: { display: "flex", flexDirection: "column", flexGrow: 1, minHeight: 0 },
  scroll: { flexGrow: 1, minHeight: 0, overflowY: "auto" },
  column: {
    display: "flex",
    flexDirection: "column",
    gap: space["6"],
    width: "100%",
    maxWidth: "48rem",
    marginInline: "auto",
    paddingInline: space["6"],
    paddingBlock: space["6"],
    margin: 0,
    listStyle: "none",
  },
  mine: { display: "flex", justifyContent: "flex-end" },
  answer: { display: "flex", flexDirection: "column", gap: space["1"] },
  words: { whiteSpace: "pre-wrap", margin: 0 },
  failed: { color: colors.destructive },
  actions: { display: "flex", gap: space["1"] },
  foot: {
    display: "flex",
    flexDirection: "column",
    gap: space["2"],
    width: "100%",
    maxWidth: "48rem",
    marginInline: "auto",
    paddingInline: space["6"],
    paddingBlockEnd: space["4"],
  },
});

/** One thing said: a question, an answer, or why an answer didn't come. */
interface Said {
  role: "user" | "assistant";
  text: string;
  /** Why this turn is no answer, for one that failed. */
  failed?: boolean;
}

/**
 * What the chat says when Grasp didn't answer, by why: what's wrong, and
 * what to do next.
 */
const refusals: Readonly<Record<AskRefusal, string>> = {
  no_key:
    "Ask Grasp isn’t set up: Grasp’s OpenAI key (OPENAI_API_KEY) is missing from Secrets Store. Add it to the stage’s 1Password Environment, then run Deploy platform.",
  too_long: "This conversation is too long to send at once. Start a new one.",
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

/**
 * The most characters a question may have: what Ask Grasp takes of one
 * turn (src/admin/ask.ts, `maxTurnChars`, server-side). A longer one
 * would be refused, and stay in the conversation.
 */
const maxQuestionChars = 8000;

/** The box: the question as it is written, and the button that sends it, or stops the answer coming. */
const Composer = ({
  waiting,
  onSend,
  onStop,
}: {
  waiting: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
}) => (
  <PromptInput
    maxLength={maxQuestionChars}
    style={styles.composer}
    onSubmit={({ text }) => {
      if (text.trim() !== "" && !waiting) {
        onSend(text.trim());
      }
    }}
    status={waiting ? "streaming" : "ready"}
  >
    <PromptInputBody>
      <PromptInputTextarea
        aria-label="Your question"
        placeholder={placeholder}
      />
    </PromptInputBody>
    <PromptInputFooter>
      <PromptInputSubmit onStop={onStop} />
    </PromptInputFooter>
  </PromptInput>
);

/** An answer's actions: copy it, and ask its question again. */
const AnswerActions = ({
  text,
  onAgain,
}: {
  text: string;
  onAgain: (() => void) | null;
}) => (
  <div {...stylex.props(styles.actions)}>
    <Button
      aria-label="Copy the answer"
      onClick={() => {
        void navigator.clipboard.writeText(text);
      }}
      size="icon-xs"
      variant="ghost"
    >
      <Icon icon={CopyIcon} />
    </Button>
    {onAgain === null ? null : (
      <Button
        aria-label="Ask again"
        onClick={onAgain}
        size="icon-xs"
        variant="ghost"
      >
        <Icon icon={RefreshCwIcon} />
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
      <div {...stylex.props(styles.start)}>
        <div {...stylex.props(styles.startColumn)}>
          <Heading level={2} size="lg" style={styles.centred}>
            Ask about every organization
          </Heading>
          <div {...stylex.props(styles.stack)}>
            <Composer onSend={send} onStop={stop} waiting={waiting} />
            <ItemGroup aria-label="Questions to start from">
              {startersFor(about).map((starter) => (
                <Item
                  key={starter}
                  onClick={() => {
                    send(starter);
                  }}
                  size="sm"
                  variant="outline"
                >
                  <ItemContent>
                    <ItemTitle>{starter}</ItemTitle>
                  </ItemContent>
                </Item>
              ))}
            </ItemGroup>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div {...stylex.props(styles.chat)}>
      <div {...stylex.props(styles.scroll)}>
        <ol aria-label="The conversation" {...stylex.props(styles.column)}>
          {said.map((turn, index) =>
            turn.role === "user" ? (
              <li key={index} {...stylex.props(styles.mine)}>
                <Bubble align="end">
                  <BubbleContent>
                    <span {...stylex.props(styles.words)}>{turn.text}</span>
                  </BubbleContent>
                </Bubble>
              </li>
            ) : (
              <li key={index} {...stylex.props(styles.answer)}>
                <p
                  role={turn.failed === true ? "alert" : undefined}
                  {...stylex.props(
                    styles.words,
                    turn.failed === true && styles.failed
                  )}
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
      <div {...stylex.props(styles.foot)}>
        <Composer onSend={send} onStop={stop} waiting={waiting} />
        <Text color="muted" size="xs" style={styles.centred}>
          Grasp answers from the admin’s own numbers. It never sees what anyone
          said in an interview.
        </Text>
      </div>
    </div>
  );
};
