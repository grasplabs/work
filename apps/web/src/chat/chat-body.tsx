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
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { lazy, Suspense } from "react";

import { notLoadedText } from "../load-from-core.tsx";
import { ConnectionRequests } from "./connection-requests.tsx";
import { FailureLine } from "./failure-line.tsx";
import type { GlobalChat } from "./global-chat.tsx";
import { HeldWrites } from "./held-writes.tsx";
import { PackageRequests } from "./package-requests.tsx";
import type { ChatThread as ChatThreadType } from "./thread.tsx";

// One chat's conversation, as the chat beside a page and full screen show
// it: the thread, with what waits on the person under its last answer
// (the writes held for them, the connections and packages asked for), or
// nothing before anything is asked: the box at its foot is enough.

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

/** The conversation, or what to ask before there is one; `focusBox` takes the person to the box. */
export const ChatConversation = ({
  chat,
  compact,
  focusBox,
}: {
  chat: GlobalChat;
  /** Narrow, beside the page: the thread's own reading column is left out. */
  compact: boolean;
  focusBox: () => void;
}) => {
  const { t, i18n } = useLingui();
  const { chatId, finding, view, failure, empty, ask, composer, offered } =
    chat;
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
        loaded={view.loaded || failure !== undefined}
        messages={view.messages}
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
        running={view.running}
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
        <HeldWrites
          chatId={chatId}
          // Confirmed, the agent reads how it ended and goes on, in a turn
          // the person's own message starts, as for approved packages
          // below: the decision itself reaches it as a note (GRA-2224).
          onConfirmed={() => {
            if (!view.running) {
              void ask(t`Confirmed. Carry on.`);
            }
          }}
          version={view.held}
        />
        <ConnectionRequests chatId={chatId} version={view.held} />
        <PackageRequests
          chatId={chatId}
          // Approved, the work the agent stopped for goes on, in a turn
          // the person's own message starts: the thread says why it did.
          onApproved={() => {
            if (!view.running) {
              void ask(t`The packages are approved. Carry on.`);
            }
          }}
          version={view.held}
        />
      </ChatThread>
    </Suspense>
  );
};
