import type { ModelEfforts } from "@grasp-os/shared/models";
import { Button, buttonVariants } from "@grasp-os/ui/components/button";
import { Spinner } from "@grasp-os/ui/components/spinner";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { MessagesSquareIcon, XIcon } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";

import { appSlot, setActiveChat, useActiveChat } from "../chat/active-chat.ts";
import { AskOrCompose } from "../chat/asked-questions.tsx";
import { BuildsFailure } from "../chat/builds.tsx";
import type { ChatBuildsRead } from "../chat/builds.tsx";
import type { useFollowedChat } from "../chat/chat-watch.ts";
import { ConnectionRequests } from "../chat/connection-requests.tsx";
import { HeldWrites } from "../chat/held-writes.tsx";
import { useAsk } from "../chat/use-ask.ts";
import { ErrorText } from "../error-text.tsx";
import { ConnectAiProvider } from "../frame/connect-ai-provider.tsx";
import { loadFromCore, NotLoaded } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCore } from "../use-core.ts";

// The chat that builds an App, docked beside its preview in the App's
// workspace (app-workspace.tsx): the person's own chat for the App, which
// core keeps for them and the App (`chats.forApp`) and makes the first
// time. What they ask here, Grasp builds as a draft of the App, which the
// workspace previews; nothing goes live until they publish. The thread and
// the box are the chat's own (thread.tsx, composer.tsx), followed from the
// same watch as on Chat (chat-watch.ts), where "Open in Chat" opens it.

// The conversation, with its Markdown and code highlighting, loads with
// the panel, not with every page.
const ChatThread = lazy(async () => {
  const { ChatThread: thread } = await import("../chat/thread.tsx");
  return { default: thread };
});

/**
 * The person's chat for App `app`, in the tab's slot for the App: the one
 * handed over, the one kept there, or the one core gives (and makes, the first time), so their
 * other chats stay as they were. Why not, when core refuses.
 */
export const useAppChatId = (
  app: string,
  /**
   * The chat the person came from, where Grasp is building the App
   * (Chat's studio): carried on here, with its draft, in place of the
   * App's own chat.
   */
  handedOver?: string
): {
  chatId: string | undefined;
  failure: Loaded<unknown> | undefined;
  retry: () => void;
} => {
  // A handed-over chat is the address's alone, carried as the person moves
  // between the workspace's views: the App's own chat stays the tab's.
  const kept = useActiveChat(appSlot(app));
  const chatId = handedOver ?? kept;
  const core = useCore();
  const [failure, setFailure] = useState<{
    app: string;
    read: Loaded<unknown>;
  }>();
  // Asked again (Try again) after core gave no chat.
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = chatId === undefined;
    const open = async (): Promise<void> => {
      if (!live) {
        return;
      }
      const found = await loadFromCore(
        core,
        async (session) => await session.chats.forApp(app)
      );
      if (!live) {
        return;
      }
      if (found.state === "ready") {
        setActiveChat(found.data.id, appSlot(app));
      } else {
        setFailure({ app, read: found });
      }
    };
    void open();
    return () => {
      live = false;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `attempt` says when to ask again
  }, [core, app, chatId, attempt]);
  return {
    chatId,
    failure:
      failure?.app === app && chatId === undefined ? failure.read : undefined,
    retry: () => {
      setFailure(undefined);
      setAttempt(attempt + 1);
    },
  };
};

/** The panel's heading, the way to the chat at full size and, over the page, closing it. */
const ChatHeader = ({
  chatId,
  onClose,
}: {
  chatId: string | undefined;
  onClose: (() => void) | undefined;
}) => {
  const { t } = useLingui();
  return (
    <header className="flex h-12 flex-none items-center gap-1 border-b pr-2 pl-4">
      <h2 className="flex-1 font-medium">
        <Trans context="the chat that builds an app">Chat</Trans>
      </h2>
      {chatId === undefined ? null : (
        <Link
          aria-label={t`Open in Chat`}
          className={buttonVariants({ size: "icon-sm", variant: "ghost" })}
          search={{ chat: chatId, panel: true }}
          title={t`Open in Chat`}
          to="/"
        >
          <MessagesSquareIcon />
        </Link>
      )}
      {onClose === undefined ? null : (
        <Button
          aria-label={t`Close`}
          onClick={onClose}
          size="icon-sm"
          title={t`Close`}
          variant="ghost"
        >
          <XIcon />
        </Button>
      )}
    </header>
  );
};

/** The panel while the chat is found, or why it wasn't. */
export const AppChatPending = ({
  failure,
  onRetry,
  onClose,
}: {
  failure: Loaded<unknown> | undefined;
  /** Asks core for the chat again, after it gave none. */
  onRetry: () => void;
  /** Closes the panel, when it stands over the page. */
  onClose?: () => void;
}) => {
  const { t } = useLingui();
  return (
    <section aria-label={t`Chat`} className="bg-card flex h-full flex-col">
      <ChatHeader chatId={undefined} onClose={onClose} />
      <div className="flex flex-1 justify-center p-5">
        {failure === undefined ? (
          <Spinner aria-label={t`Loading…`} />
        ) : (
          <div className="flex flex-col items-center gap-3">
            <NotLoaded page={failure} />
            <Button onClick={onRetry} size="sm" variant="outline">
              <Trans>Try again</Trans>
            </Button>
          </div>
        )}
      </div>
    </section>
  );
};

/**
 * The box's state for App `app`'s chat: what is typed and attached, and
 * asking. Held by the workspace above the chat's panel, so hiding the
 * panel, or the window crossing into a sheet, keeps unsent work.
 */
export const useAppAsk = (
  app: string,
  chatId: string | undefined,
  models: readonly string[],
  efforts: Record<string, ModelEfforts>
) => useAsk(chatId, models, efforts, "here", appSlot(app));

/** The chat that builds App `name`, followed as `followed`, asked in with `asking`. */
export const AppChat = ({
  name,
  chatId,
  followed: { view, failure },
  builds,
  models,
  asking: { composer, ask },
  onClose,
}: {
  /** Closes the panel, when it stands over the page. */
  onClose?: () => void;
  name: string;
  chatId: string;
  followed: ReturnType<typeof useFollowedChat>;
  builds: ChatBuildsRead;
  models: string[];
  asking: ReturnType<typeof useAppAsk>;
}) => {
  const { t } = useLingui();
  const lastQuestion = view.messages.findLast(({ role }) => role === "user");
  const empty = view.loaded && view.messages.length === 0;
  return (
    <section
      aria-label={t`Chat`}
      className="bg-card flex h-full min-w-0 flex-col"
    >
      <ChatHeader chatId={chatId} onClose={onClose} />
      {empty ? (
        <p className="text-muted-foreground flex-1 p-5">
          <Trans>
            Say what {name} should do or change. Grasp builds it as a preview
            first: nothing goes live until you publish.
          </Trans>
        </p>
      ) : (
        <Suspense
          fallback={
            <div className="flex flex-1 justify-center py-8">
              <Spinner aria-label={t`Loading…`} />
            </div>
          }
        >
          <ChatThread
            chatId={chatId}
            compact
            loaded={view.loaded || failure !== undefined}
            messages={view.messages}
            onRetry={() => {
              if (lastQuestion?.role === "user") {
                void ask(lastQuestion.text);
              }
            }}
            output={view.output}
            partial={view.partial}
            running={view.running}
            tools={view.tools}
          >
            {failure === undefined && view.stopped === null ? null : (
              <div className="flex flex-col gap-2">
                <ErrorText>{failure}</ErrorText>
                <ErrorText>{view.stopped ?? undefined}</ErrorText>
              </div>
            )}
            <HeldWrites chatId={chatId} version={view.held} />
            <ConnectionRequests chatId={chatId} version={view.held} />
          </ChatThread>
        </Suspense>
      )}
      <div className="flex flex-none flex-col gap-2 px-4 pt-2 pb-4">
        <BuildsFailure read={builds} />
        {models.length === 0 ? <ConnectAiProvider size="xs" /> : null}
        <AskOrCompose
          {...composer}
          compact
          label={t`Ask for a change`}
          messages={view.messages}
          onAnswer={(answers) => {
            void ask(answers);
          }}
          placeholder={t`Say what should change`}
          running={view.running}
        />
      </div>
    </section>
  );
};
