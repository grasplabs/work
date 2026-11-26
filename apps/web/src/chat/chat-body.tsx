import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import { MessageSkeleton } from "@grasp-os/ui/components/message";
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@grasp-os/ui/components/message-scroller";
import { Icon, RefreshCwIcon } from "@grasp-os/ui/lib/icons";
import { size, space } from "@grasp-os/ui/lib/tokens.stylex";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { lazy, Suspense } from "react";

import { notLoadedText } from "../load-from-core.tsx";
import { AgentName, agentModelOf } from "./agent-choice.tsx";
import { AskOrCompose } from "./asked-questions.tsx";
import { BuildsFailure, workOf } from "./builds.tsx";
import { FailureLine } from "./failure-line.tsx";
import type { GlobalChat } from "./global-chat.tsx";
import { pendingCard } from "./make-card.tsx";
import {
  ModelsUnavailableNotice,
  unavailableText,
} from "./models-unavailable.tsx";
import { ChatSources } from "./sources.tsx";
import { useSubjectBar } from "./subject-bar.tsx";
import type { ChatThread as ChatThreadType } from "./thread.tsx";
import { useNewLine } from "./unread.ts";
import { WaitingForYou } from "./waiting-for-you.tsx";

// One chat's conversation and the box to ask in under it, as the chat
// beside a page (chat-panel.tsx) and a chat's own page (chat-page.tsx)
// both show it: the thread, its last answer folding what the chat read
// under its words, with what waits on the person under that answer (the
// writes held for them, the connections and packages asked for), or
// nothing before anything is asked; and the box, or the agent's questions
// in its place.

const styles = stylex.create({
  grow: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
  },
  centre: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    alignItems: "center",
    gap: space["3"],
    paddingBlock: space["8"],
  },
  stack: { display: "grid", gap: space["2"] },
  // The box at the chat's foot, and what stands with it: as far in from
  // the panel's sides and foot as the page's words are (#2503's).
  footer: {
    display: "flex",
    flexDirection: "column",
    flexShrink: 0,
    gap: space["1"],
    paddingInline: size.appShellPageInline,
    paddingBlockStart: space["2"],
    paddingBlockEnd: size.appShellPageInline,
  },
  // On a chat's page the column is already in from the card's sides: the
  // box in as far as the thread's rows are, so it is as wide as the thread.
  footerInColumn: { paddingInline: space["4"] },
  // The box as wide as the foot it stands in, as #2503's: full screen and
  // on a chat's page, its column's width, never the box's own most.
  box: { maxWidth: "none" },
});

// The conversation, with its Markdown and code highlighting, loads once a
// chat is shown: most pages show the chat idle.
type ThreadComponent = typeof ChatThreadType;

const ChatThread = lazy(async (): Promise<{ default: ThreadComponent }> => {
  const { ChatThread: thread } = await import("./thread.tsx");
  return { default: thread };
});

/** The chat loading, in the thread's place: the shape of a question and its answer. */
const Loading = () => {
  const { t } = useLingui();
  return (
    <div {...stylex.props(styles.grow)}>
      <MessageScrollerProvider loading>
        <MessageScroller>
          <MessageScrollerViewport aria-label={t`Messages`}>
            <MessageScrollerContent>
              <MessageScrollerItem>
                <div {...stylex.props(styles.stack)}>
                  <MessageSkeleton align="end" />
                  <MessageSkeleton />
                </div>
              </MessageScrollerItem>
            </MessageScrollerContent>
          </MessageScrollerViewport>
        </MessageScroller>
      </MessageScrollerProvider>
    </div>
  );
};

/**
 * The conversation, or what to ask before there is one; `focusBox` takes
 * the person to the box. One chat a mount: its caller keys it by chat, so
 * each chat opens afresh, with its own New line.
 */
export const ChatConversation = ({
  chat,
  compact,
  focusBox,
  seen,
}: {
  chat: GlobalChat;
  /** Narrow, beside the page: the thread's own reading column is left out. */
  compact: boolean;
  focusBox: () => void;
  /**
   * Whether it is in front of the person: on a chat's page, and in the
   * dock while it is open, never while it is closed to its bar. Only then
   * is it read (unread.ts).
   */
  seen: boolean;
}) => {
  const { t, i18n } = useLingui();
  const {
    chatId,
    finding,
    view,
    failure,
    empty,
    ask,
    composer,
    offered,
    sourceNames,
  } = chat;
  // Read as it opens here; the New line over what the person hadn't seen.
  const newLine = useNewLine(chatId, view, seen);
  // A subject's chat, while core finds it, or why it gave none.
  if (finding.searching || finding.failure !== undefined) {
    return finding.failure === undefined ? (
      <Loading />
    ) : (
      <div {...stylex.props(styles.centre)}>
        <FailureLine>{notLoadedText(finding.failure, i18n)}</FailureLine>
        <Button
          onClick={() => {
            finding.retry();
          }}
          size="sm"
          variant="outline"
        >
          <Icon icon={RefreshCwIcon} />
          <Trans>Try again</Trans>
        </Button>
      </div>
    );
  }
  if (chatId === undefined || empty) {
    // Before anything is asked the chat is empty: the box at its foot is enough.
    return <div {...stylex.props(styles.grow)} />;
  }
  const lastQuestion = view.messages.findLast(({ role }) => role === "user");
  return (
    <Suspense fallback={<Loading />}>
      <ChatThread
        agents={offered?.agents}
        chatId={chatId}
        compact={compact}
        loaded={newLine.decided || failure !== undefined}
        messages={view.messages}
        newLineBefore={newLine.before}
        // Ask again goes as its answer is drawn anew: the person is taken
        // to the box, not left on the page.
        onRetry={() => {
          if (lastQuestion !== undefined) {
            focusBox();
            void ask(lastQuestion.text);
          }
        }}
        output={view.output}
        partial={view.partial}
        checking={view.checking}
        modelWait={view.waiting}
        running={view.running}
        sources={
          <ChatSources names={sourceNames} sources={view.provenance.sources} />
        }
        tools={view.tools}
        build={{
          model: composer.model,
          effort: composer.effort,
          onChangePlan: focusBox,
        }}
      >
        {failure === undefined && view.stopped === null ? null : (
          <div {...stylex.props(styles.stack)}>
            <FailureLine>{failure}</FailureLine>
            <FailureLine>{view.stopped ?? undefined}</FailureLine>
            {/* A question stopped before the agent answered (a deploy, say)
              is asked again from here: it may be the chat's first. */}
            {view.stopped !== null &&
            !view.running &&
            lastQuestion !== undefined ? (
              <div>
                <Button
                  // It goes as the question runs again: the box takes the focus.
                  onClick={() => {
                    focusBox();
                    void ask(lastQuestion.text);
                  }}
                  size="sm"
                  variant="outline"
                >
                  <Icon icon={RefreshCwIcon} />
                  <Trans>Try again</Trans>
                </Button>
              </div>
            ) : null}
          </div>
        )}
        <WaitingForYou
          chatId={chatId}
          // One pause per chat: what is answered in one never holds another's.
          key={chatId}
          // Approved, the work the agent stopped for goes on, in a turn
          // the person's own message starts: the thread says why it did.
          onApproved={() => {
            if (!view.running) {
              void ask(t`The packages are approved. Carry on.`);
            }
          }}
          // Confirmed, the agent reads how it ended and goes on, in a turn
          // the person's own message starts, as for approved packages:
          // the decision itself reaches it as a note (GRA-2224).
          onConfirmed={() => {
            if (!view.running) {
              void ask(t`Confirmed. Carry on.`);
            }
          }}
          version={view.held}
        />
      </ChatThread>
    </Suspense>
  );
};

/**
 * The box to ask in, or the agent's questions in its place; dictating only
 * while the chat is seen (`listening`); `inColumn` on a chat's page, as
 * wide as its thread.
 */
export const ChatFooter = ({
  chat,
  listening,
  inColumn = false,
}: {
  chat: GlobalChat;
  listening: boolean;
  inColumn?: boolean;
}) => {
  const { t } = useLingui();
  const {
    builds,
    subject,
    chatId,
    composer,
    words,
    view,
    asking,
    ask,
    modelsUnavailable,
    retry,
    summary,
    offered,
    box,
  } = chat;
  const work = workOf(builds);
  const unavailable = unavailableText(modelsUnavailable);
  // Which of the company's agents answers here, where there are several.
  const agents = offered?.agents ?? [];
  // Under a card that waits for the person, the box is where to change it.
  const waiting = pendingCard(view.messages, view.running)?.kind;
  const changeWords = {
    planned: t`Change something about the plan`,
    agentDraft: t`Change something about the agent`,
    agentChange: t`Change something about the change`,
  };
  const placeholder =
    waiting === undefined ? words.placeholder : changeWords[waiting];
  // When the running turn began: its question's time.
  const turnSince = view.running
    ? view.messages.findLast(({ role }) => role === "user")?.at
    : undefined;
  // The page's subject, by name once it is known.
  const worked =
    subject.about === undefined || subject.name === undefined
      ? undefined
      : { ...subject.about, name: subject.name };
  const bar = useSubjectBar({
    subject: worked,
    work,
    chatId,
    since: turnSince,
  });
  return (
    <div {...stylex.props(styles.footer, inColumn && styles.footerInColumn)}>
      <BuildsFailure read={builds} />
      {/* A restricted chat stays so for good: said over the box, where the
        next question is asked, whatever the thread is doing. */}
      {view.provenance.restricted ? (
        <div>
          <Badge variant="warning">{t`Restricted`}</Badge>
        </div>
      ) : null}
      <AskOrCompose
        {...composer}
        {...(unavailable === undefined ? {} : { unavailable })}
        agent={
          summary === undefined ? undefined : (
            <AgentName agentId={summary.agentId} agents={agents} />
          )
        }
        agentModel={agentModelOf(agents, summary?.agentId)}
        {...(bar === undefined ? {} : { subject: bar })}
        asking={asking}
        dictates={listening}
        style={styles.box}
        label={words.title}
        onAnswer={async (text) => await ask(text)}
        // The box's editor takes its placeholder and its words as it
        // starts: another placeholder, or another chat's draft (whose
        // mentions may differ in the same words), starts it afresh; the
        // chat a question made from this draft keeps it, and its cursor.
        key={`${box} ${placeholder}`}
        placeholder={placeholder}
        running={view.running}
      />
      <ModelsUnavailableNotice onRetry={retry} why={modelsUnavailable} />
    </div>
  );
};

/** Where the cursor goes in the chat: its box's text. */
export const boxOf = (
  body: HTMLElement | null
): HTMLElement | null | undefined =>
  body?.querySelector<HTMLElement>('[role="textbox"]');
