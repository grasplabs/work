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
import type { ReactNode } from "react";

import { ErrorText } from "../error-text.tsx";
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
// What the agent builds is in Chat's side panel: "Open in chat" opens it.

/** How the dock sits: its bar alone, a frame around it, or a drawer down the right side. */
type DockMode = "bar" | "frame" | "drawer";

/** The models a question may name, read once the dock is shown. */
const useModels = (): Loaded<string[]> | undefined => {
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
  return models;
};

/** Why nothing can be asked yet, if that is so: the models are what a question names. */
const useNoModels = (
  models: Loaded<string[]> | undefined
): string | undefined => {
  const { t } = useLingui();
  if (models === undefined || models.state === "ready") {
    return models?.state === "ready" && models.data.length === 0
      ? t`No model is set up for this deployment yet.`
      : undefined;
  }
  if (models.state === "offline") {
    return t`Grasp can't be reached right now. Try again in a moment.`;
  }
  return models.state === "refused" ? models.message : undefined;
};

/** A button in the dock's header, named by its label. */
const HeaderButton = ({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) => (
  <Button
    aria-label={label}
    onClick={onClick}
    size="icon-sm"
    title={label}
    variant="ghost"
  >
    {children}
  </Button>
);

/** The dock itself: on every page in the frame but Chat's. */
const Dock = () => {
  const { t } = useLingui();
  const chatId = useActiveChat();
  const { view, failure } = useFollowedChat(chatId);
  const models = useModels();
  const noModels = useNoModels(models);
  const { composer, ask } = useAsk(
    chatId,
    models?.state === "ready" ? models.data : [],
    "here"
  );
  const [mode, setMode] = useState<DockMode>("bar");
  // Once the person moved the dock, its box takes the focus where it shows
  // next, so the cursor stays in it as the frame opens or folds away.
  const [moved, setMoved] = useState(false);
  const moveTo = (next: DockMode): void => {
    setMoved(true);
    setMode(next);
  };
  const open = mode !== "bar";
  const lastQuestion = view.messages.findLast(({ role }) => role === "user");
  const box = (
    <Composer
      {...composer}
      autoFocus={moved}
      compact
      label={t`Ask Grasp`}
      onSend={() => {
        if (mode === "bar") {
          moveTo("frame");
        }
        composer.onSend();
      }}
      placeholder={t`Ask Grasp`}
      running={view.running}
    >
      {!open && chatId !== undefined ? (
        <Button
          aria-label={t`Open the chat`}
          onClick={() => {
            moveTo("frame");
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
  if (!open) {
    return (
      <div className="pointer-events-none fixed inset-x-7 bottom-7 z-40 flex justify-end">
        <div className="chat-glow bg-background/80 pointer-events-auto w-80 max-w-full rounded-md text-sm backdrop-blur-md transition-all duration-300 ease-out focus-within:w-104 motion-reduce:transition-none">
          {box}
          {noModels === undefined ? null : (
            <p className="text-muted-foreground px-3 pb-2 text-xs">
              {noModels}
            </p>
          )}
        </div>
      </div>
    );
  }
  return (
    <div
      className={
        mode === "drawer"
          ? "pointer-events-none fixed inset-y-2 right-2 left-2 z-40 flex justify-end"
          : "pointer-events-none fixed inset-x-4 bottom-4 z-40 flex justify-end"
      }
    >
      <section
        aria-label={t`Ask Grasp`}
        className={
          mode === "drawer"
            ? "bg-background pointer-events-auto flex h-full w-110 max-w-full flex-col border-l text-sm"
            : "chat-glow bg-background/80 pointer-events-auto flex h-136 max-h-svh w-110 max-w-full flex-col overflow-hidden rounded-2xl border text-sm backdrop-blur-md"
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
            <>
              <Link
                aria-label={t`Open in chat`}
                className={buttonVariants({
                  size: "icon-sm",
                  variant: "ghost",
                })}
                search={{ chat: chatId, panel: true }}
                title={t`Open in chat`}
                to="/"
              >
                <MessagesSquareIcon />
              </Link>
              <HeaderButton
                label={t`New chat`}
                onClick={() => {
                  setMoved(true);
                  setActiveChat(undefined);
                }}
              >
                <SquarePenIcon />
              </HeaderButton>
            </>
          )}
          {mode === "frame" ? (
            <HeaderButton
              label={t`Open at the side`}
              onClick={() => {
                moveTo("drawer");
              }}
            >
              <Maximize2Icon />
            </HeaderButton>
          ) : (
            <HeaderButton
              label={t`Back to the small chat`}
              onClick={() => {
                moveTo("frame");
              }}
            >
              <Minimize2Icon />
            </HeaderButton>
          )}
          <HeaderButton
            label={t`Fold the chat away`}
            onClick={() => {
              moveTo("bar");
            }}
          >
            <ChevronDownIcon />
          </HeaderButton>
        </header>
        {chatId === undefined ? (
          <p className="text-muted-foreground flex-1 p-4">
            <Trans>Ask anything, or describe a process</Trans>
          </p>
        ) : (
          <ChatThread
            loaded={view.loaded || failure !== undefined}
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
              <div className="flex flex-col gap-2">
                <ErrorText>{failure}</ErrorText>
                <ErrorText>{view.stopped ?? undefined}</ErrorText>
              </div>
            )}
            <HeldWrites chatId={chatId} version={view.held} />
          </ChatThread>
        )}
        <div className="flex flex-none flex-col gap-1 p-3">
          {box}
          {noModels === undefined ? null : (
            <p className="text-muted-foreground px-1 text-xs">{noModels}</p>
          )}
        </div>
      </section>
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
