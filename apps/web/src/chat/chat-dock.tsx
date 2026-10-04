import { Button, buttonVariants } from "@grasp-os/ui/components/button";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link, useLocation } from "@tanstack/react-router";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  Maximize2Icon,
  MessagesSquareIcon,
  Minimize2Icon,
  SquarePenIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCore } from "../use-core.ts";
import { setActiveChat, useActiveChat } from "./active-chat.ts";
import { useFollowedChat } from "./chat-watch.ts";
import { Composer } from "./composer.tsx";
import { HeldWrites } from "./held-writes.tsx";
import { ChatThread } from "./thread.tsx";
import { useAsk } from "./use-ask.ts";

// Grasp's chat on every page but Chat's own, bottom right, as in the
// prototype (`components/chat/global-chat.tsx`, `knowledge/brain-chat.tsx`):
// the person's open chat, so what is asked anywhere goes on there and shows
// in its list, and a new chat here is a new one there. A slim bar to ask in;
// sending, or its arrow, opens a frame around it with the conversation,
// which grows into a drawer down the right side and back, or folds away to
// the bar. The thread and the box are the chat's own (thread.tsx,
// composer.tsx), and the chat is the same watch as on Chat (chat-watch.ts).
// What the agent builds is in Chat's side panel: "Open in chat" goes there.

/** How the dock sits: its bar alone, a frame around it, or a drawer down the right side. */
type DockMode = "bar" | "frame" | "drawer";

/** The models a question may name, read once the dock is shown. */
const useModels = (): readonly string[] => {
  const core = useCore();
  const [models, setModels] = useState<Loaded<string[]>>();
  useEffect(() => {
    const left = new AbortController();
    const read = async (): Promise<void> => {
      const loaded = await loadFromCore(
        core,
        async (session) => await session.chats.models(),
        left.signal
      );
      if (!left.signal.aborted) {
        setModels(loaded);
      }
    };
    void read();
    return () => {
      left.abort();
    };
  }, [core]);
  return models?.state === "ready" ? models.data : [];
};

/** The dock itself: on every page in the frame but Chat's. */
const Dock = () => {
  const { t } = useLingui();
  const chatId = useActiveChat();
  const { view, failure } = useFollowedChat(chatId);
  const models = useModels();
  const { composer, ask } = useAsk(chatId, models, "here");
  const [mode, setMode] = useState<DockMode>("bar");
  const open = mode !== "bar";
  const talking = chatId !== undefined && view.messages.length > 0;
  const lastQuestion = view.messages.findLast(({ role }) => role === "user");
  const box = (
    <Composer
      {...composer}
      compact
      label={t`Ask Grasp`}
      onSend={() => {
        setMode((now) => (now === "bar" ? "frame" : now));
        composer.onSend();
      }}
      placeholder={t`Ask Grasp`}
      running={view.running}
    >
      {!open && talking ? (
        <Button
          aria-label={t`Open the chat`}
          onClick={() => {
            setMode("frame");
          }}
          size="icon-xs"
          title={t`Open the chat`}
          type="button"
          variant="ghost"
        >
          <ChevronUpIcon />
        </Button>
      ) : null}
    </Composer>
  );
  // The box is always this same element in this same place, so the cursor
  // stays in it when the frame opens around it or folds away; the frame
  // leaves room for it at its foot.
  return (
    <div className="pointer-events-none fixed inset-2 z-40">
      {open ? (
        <section
          aria-label={t`Ask Grasp`}
          className={
            mode === "drawer"
              ? "bg-background pointer-events-auto absolute inset-y-0 right-0 flex w-110 max-w-full flex-col border-l pb-20 text-sm"
              : "chat-glow bg-background/80 pointer-events-auto absolute right-2 bottom-2 flex h-136 max-h-full w-110 max-w-full flex-col overflow-hidden rounded-2xl border pb-20 text-sm backdrop-blur-md"
          }
        >
          <header
            className={
              mode === "drawer"
                ? "flex h-(--header-height) flex-none items-center gap-0.5 border-b pr-1.5 pl-4"
                : "flex flex-none items-center gap-0.5 border-b py-1.5 pr-1.5 pl-4"
            }
          >
            <h2 className="flex-1 font-medium">
              <Trans>Ask Grasp</Trans>
            </h2>
            {chatId === undefined ? null : (
              <Link
                aria-label={t`Open in chat`}
                className={buttonVariants({
                  size: "icon-sm",
                  variant: "ghost",
                })}
                search={{ chat: chatId }}
                title={t`Open in chat`}
                to="/"
              >
                <MessagesSquareIcon />
              </Link>
            )}
            {talking ? (
              <Button
                aria-label={t`New chat`}
                onClick={() => {
                  setActiveChat(undefined);
                }}
                size="icon-sm"
                title={t`New chat`}
                variant="ghost"
              >
                <SquarePenIcon />
              </Button>
            ) : null}
            {mode === "frame" ? (
              <Button
                aria-label={t`Open at the side`}
                onClick={() => {
                  setMode("drawer");
                }}
                size="icon-sm"
                title={t`Open at the side`}
                variant="ghost"
              >
                <Maximize2Icon />
              </Button>
            ) : (
              <Button
                aria-label={t`Back to the small chat`}
                onClick={() => {
                  setMode("frame");
                }}
                size="icon-sm"
                title={t`Back to the small chat`}
                variant="ghost"
              >
                <Minimize2Icon />
              </Button>
            )}
            <Button
              aria-label={t`Fold the chat away`}
              onClick={() => {
                setMode("bar");
              }}
              size="icon-sm"
              title={t`Fold the chat away`}
              variant="ghost"
            >
              <ChevronDownIcon />
            </Button>
          </header>
          {chatId === undefined || !view.loaded ? (
            <p className="text-muted-foreground flex-1 p-4">
              <Trans>Ask anything, or describe a process</Trans>
            </p>
          ) : (
            <ChatThread
              loaded={view.loaded}
              messages={view.messages}
              onRetry={() => {
                if (lastQuestion?.role === "user") {
                  void ask(lastQuestion.text);
                }
              }}
              partial={view.partial}
              running={view.running}
            >
              {failure === undefined && view.stopped === null ? null : (
                <p className="text-destructive text-sm" role="alert">
                  {failure ?? view.stopped}
                </p>
              )}
              <HeldWrites chatId={chatId} version={view.held} />
            </ChatThread>
          )}
        </section>
      ) : null}
      <div
        className={
          open
            ? "pointer-events-auto absolute right-5 bottom-5 w-104 max-w-full text-sm"
            : "chat-glow bg-background/80 pointer-events-auto absolute right-5 bottom-5 w-80 max-w-full rounded-md text-sm backdrop-blur-md transition-all duration-300 ease-out focus-within:w-104 motion-reduce:transition-none"
        }
      >
        {box}
      </div>
    </div>
  );
};

/**
 * The dock where it belongs: on every page in the frame but Chat's own,
 * which is the chat at full size.
 */
export const ChatDock = () => {
  const { pathname } = useLocation();
  return pathname === "/" ? null : <Dock />;
};
