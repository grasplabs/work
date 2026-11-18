import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Suspense, lazy } from "react";

import { Alert } from "../grasp/alert/index.ts";
import { Button } from "../grasp/button/index.ts";
import { Empty, EmptyHeader, EmptyDescription } from "../grasp/empty/index.ts";
import { Retry } from "../grasp/icons/index.ts";
import { Text } from "../grasp/text/index.ts";
import { Thread } from "../grasp/thread/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { NotLoaded } from "../load-from-core.tsx";
import { agentModelOf } from "./agent-choice.tsx";
import { AskOrCompose } from "./asked-questions.tsx";
import { pendingPlan } from "./build-progress.tsx";
import { BuildsFailure, workOf } from "./builds.tsx";
import { ConnectionRequests } from "./connection-requests.tsx";
import type {
  ChatSession,
  GlobalChat,
  ModelsUnavailable,
} from "./global-chat.tsx";
import { HeldWrites } from "./held-writes.tsx";
import { PackageRequests } from "./package-requests.tsx";
import { ChatSources } from "./sources.tsx";
import { SubjectBarContent, subjectBarOf } from "./subject-bar.tsx";
import type { ChatThread as ChatThreadType } from "./thread.tsx";

// One chat's conversation and the box to ask in under it, as the dock
// (chat-panel.tsx) and a chat's own page (chat-page.tsx) both show it: the
// thread, or what to ask before there is one, and the box, or the agent's
// questions in its place.

/** What a chat's conversation and box need: the chat, and the frame's say about asking. */
export type ChatBodyValues = ChatSession &
  Pick<
    GlobalChat,
    | "finding"
    | "words"
    | "subject"
    | "modelsUnavailable"
    | "retry"
    | "sourceNames"
    | "offered"
  >;

const styles = stylex.create({
  grow: {
    display: "grid",
    flexGrow: 1,
  },
  centre: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    alignItems: "center",
    gap: grasp.space3,
    paddingBlock: grasp.space8,
  },
  stack: {
    display: "grid",
    gap: grasp.space2,
  },
  start: {
    justifySelf: "start",
  },
  // The box at the chat's foot, and what stands with it.
  footer: {
    display: "flex",
    flexDirection: "column",
    flexShrink: 0,
    gap: grasp.space1,
    // As far in from the panel's sides and foot as the page's words are.
    paddingInline: grasp.shellPageInline,
    paddingBlockStart: grasp.space2,
    paddingBlockEnd: grasp.shellPageInline,
  },
  // On a chat's page the column is already in from the card's sides: the box is as wide as the thread.
  footerInColumn: { paddingInline: 0 },
  notice: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    paddingInline: grasp.space1,
  },
});

// The conversation, with its Markdown and code highlighting, loads once a
// chat is shown: most pages show the chat idle. A chat's page waits for it
// in its loader (`loadThread`), so a chat just started never shows the
// thread's loading shapes while its code arrives: once in, it is drawn
// at once rather than through Suspense.
type ThreadComponent = typeof ChatThreadType;

let threadLoaded: ThreadComponent | undefined;
let threadLoading: Promise<ThreadComponent> | undefined;

/** Loads the conversation's code, once; what a chat's page waits for. */
export const loadThread = async (): Promise<ThreadComponent> => {
  threadLoading ??= (async () => {
    const { ChatThread: thread } = await import("./thread.tsx");
    threadLoaded = thread;
    return thread;
  })();
  return await threadLoading;
};

const LazyThread = lazy(async () => ({ default: await loadThread() }));

/** What the chat says before anything is asked in it. */
const Welcome = ({ text }: { text: string }) => (
  <div {...stylex.props(styles.grow)}>
    <Empty shape="thread">
      <EmptyHeader>
        <EmptyDescription>{text}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  </div>
);

/** The chat loading, in the thread's place: Grasp UI's Thread, loading. */
const Loading = () => {
  const { t } = useLingui();
  return (
    <div {...stylex.props(styles.grow)}>
      <Thread
        aria-label={t`Messages`}
        items={[]}
        loading
        renderItem={() => null}
      />
    </div>
  );
};

/** The conversation, or what to ask before there is one; `focusBox` takes the person to the box. */
export const ChatConversation = ({
  chat,
  compact,
  focusBox,
}: {
  chat: ChatBodyValues;
  /** Narrow, beside the page: the thread's own reading column is left out. */
  compact: boolean;
  focusBox: () => void;
}) => {
  const { t } = useLingui();
  const { chatId, finding, view, failure, empty, words, ask, composer } = chat;
  // A subject's chat, while core finds it, or why it gave none.
  if (finding.searching || finding.failure !== undefined) {
    return finding.failure === undefined ? (
      <Loading />
    ) : (
      <div {...stylex.props(styles.centre)}>
        <NotLoaded page={finding.failure} />
        <Button
          onClick={() => {
            finding.retry();
          }}
          size="sm"
        >
          {t`Try again`}
        </Button>
      </div>
    );
  }
  if (chatId === undefined || empty) {
    return <Welcome text={words.empty} />;
  }
  const lastQuestion = view.messages.findLast(({ role }) => role === "user");
  const ChatThread = threadLoaded ?? LazyThread;
  return (
    <Suspense fallback={<Loading />}>
      <ChatThread
        chatId={chatId}
        compact={compact}
        loaded={view.loaded || failure !== undefined}
        messages={view.messages}
        onRetry={() => {
          if (lastQuestion !== undefined) {
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
            {failure === undefined ? null : (
              <Alert tone="danger">{failure}</Alert>
            )}
            {view.stopped === null ? null : (
              <Alert tone="danger">{view.stopped}</Alert>
            )}
            {/* A question stopped before the agent answered (a deploy, say)
              is asked again from here: it may be the chat's first. */}
            {view.stopped !== null &&
            !view.running &&
            lastQuestion !== undefined ? (
              <Button
                icon={Retry}
                layout={styles.start}
                onClick={() => {
                  void ask(lastQuestion.text);
                }}
                size="sm"
              >
                {t`Try again`}
              </Button>
            ) : null}
          </div>
        )}
        <HeldWrites chatId={chatId} version={view.held} />
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

/** Why nothing can be asked yet, under the box, with the way out. */
const ModelsUnavailableNotice = ({
  why,
  onRetry,
}: {
  why: ModelsUnavailable;
  onRetry: (() => void) | undefined;
}) => {
  // No provider is the box's own to say: it is covered (composer.tsx).
  if (why.why === "provider") {
    return null;
  }
  return (
    <div {...stylex.props(styles.notice)}>
      <Text size="xs" tone="muted">
        {why.text}
      </Text>
      {onRetry === undefined ? null : (
        <Button
          onClick={() => {
            onRetry();
          }}
          size="xs"
          variant="ghost"
        >
          <Trans>Try again</Trans>
        </Button>
      )}
    </div>
  );
};

/**
 * Whether the fold of what the chat's answers drew on gives way over the
 * box: over the agent's questions or a plan that waits, which take the
 * person's eye, and when the last answer's own sources (its pile) are
 * right above it.
 */
export const sourcesGiveWay = (
  messages: ChatBodyValues["view"]["messages"],
  asking: ChatBodyValues["asking"],
  planWaits: boolean
): boolean => {
  const last = messages.findLast(({ role }) => role === "assistant");
  const cites =
    last !== undefined && "citations" in last && last.citations.length > 0;
  return asking !== undefined || planWaits || cites;
};

/** The box to ask in, or the agent's questions in its place; `inColumn` on a chat's page, as wide as its thread. */
export const ChatFooter = ({
  chat,
  inColumn = false,
}: {
  chat: ChatBodyValues;
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
    sourceNames,
    summary,
    offered,
  } = chat;
  const work = workOf(builds);
  // Which of the company's agents answers here, where there are several.
  const agents = offered?.agents ?? [];
  // Under a plan that waits for the person, the box is where to change it.
  const placeholder =
    pendingPlan(view.messages, view.running) === undefined
      ? words.placeholder
      : t`Change something about the plan`;
  // When the running turn began: its question's time.
  const turnSince = view.running
    ? view.messages.findLast(({ role }) => role === "user")?.at
    : undefined;
  // The page's subject, by name once it is known.
  const worked =
    subject.about === undefined || subject.name === undefined
      ? undefined
      : { ...subject.about, name: subject.name };
  return (
    <div {...stylex.props(styles.footer, inColumn && styles.footerInColumn)}>
      <BuildsFailure read={builds} />
      <ChatSources
        names={sourceNames}
        provenance={view.provenance}
        sourcesShown={
          !sourcesGiveWay(
            view.messages,
            asking,
            pendingPlan(view.messages, view.running) !== undefined
          )
        }
      />
      <AskOrCompose
        {...composer}
        agentModel={agentModelOf(agents, summary?.agentId)}
        subject={
          subjectBarOf(worked, work) === undefined ? undefined : (
            <SubjectBarContent
              chatId={chatId}
              work={work}
              since={turnSince}
              subject={worked}
            />
          )
        }
        asking={asking}
        label={words.title}
        onAnswer={(text) => {
          void ask(text);
        }}
        // The box's editor takes its placeholder as it starts: another
        // starts it afresh, with the text it holds.
        key={placeholder}
        placeholder={placeholder}
        running={view.running}
      />
      {modelsUnavailable === undefined ? null : (
        <ModelsUnavailableNotice onRetry={retry} why={modelsUnavailable} />
      )}
    </div>
  );
};

/**
 * Where the cursor goes in the chat: its box's text, or, while Grasp's
 * questions stand in its place, the option picked, or the first.
 */
export const boxOf = (
  body: HTMLElement | null
): HTMLElement | null | undefined =>
  body?.querySelector<HTMLElement>("textarea") ??
  body?.querySelector<HTMLElement>('[aria-checked="true"]') ??
  body?.querySelector<HTMLElement>('[role="radio"], [role="checkbox"]');
