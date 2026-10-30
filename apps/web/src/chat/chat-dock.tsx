import type { ModelEfforts } from "@grasp-os/shared/models";
import { Button, buttonVariants } from "@grasp-os/ui/components/button";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  Link,
  useLocation,
  useMatch,
  useRouteContext,
  useRouter,
} from "@tanstack/react-router";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  Maximize2Icon,
  MessagesSquareIcon,
  Minimize2Icon,
  SquarePenIcon,
} from "lucide-react";
import { useRef } from "react";
import type { ReactNode } from "react";

import type { CoreConnection } from "../core-connection.ts";
import { ErrorText } from "../error-text.tsx";
import { useFrameRead } from "../frame/frame-read.ts";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { setActiveChat, useActiveChat } from "./active-chat.ts";
import type { ChatSlot } from "./active-chat.ts";
import { BrainQuestions } from "./brain-questions.tsx";
import { useFollowedChat } from "./chat-watch.ts";
import { Composer } from "./composer.tsx";
import { setDockMode, useDockMode } from "./dock-mode.ts";
import type { DockMode } from "./dock-mode.ts";
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

/** The models a question may name, and the efforts each takes. */
interface Offered {
  models: string[];
  efforts: Record<string, ModelEfforts>;
}

/** The models a question may name, as core lists them, with their efforts. */
const readModels = async (
  core: CoreConnection,
  signal?: AbortSignal
): Promise<Loaded<Offered>> =>
  await loadFromCore(
    core,
    async (session) => {
      const [models, efforts] = await Promise.all([
        session.chats.models(),
        session.chats.efforts(),
      ]);
      return { models, efforts };
    },
    signal
  );

/** Why nothing can be asked yet, if that is so: the models are what a question names. */
const useNoModels = (
  models: Loaded<Offered> | undefined
): string | undefined => {
  const { t } = useLingui();
  if (models === undefined || models.state === "ready") {
    return models?.state === "ready" && models.data.models.length === 0
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

/** The open dock's header: its title, then the ways to go on with the chat and to move the dock. */
const DockHeader = ({
  title,
  chatId,
  mode,
  onMove,
  onNewChat,
}: {
  title: string;
  chatId: string | undefined;
  mode: "frame" | "drawer";
  onMove: (next: DockMode) => void;
  onNewChat: () => void;
}) => {
  const { t } = useLingui();
  return (
    <header
      className={
        mode === "drawer"
          ? "flex h-(--header-height) flex-none items-center gap-0.5 border-b pr-1.5 pl-4"
          : "flex flex-none items-center gap-0.5 border-b py-1.5 pr-1.5 pl-4"
      }
    >
      <h2 className="flex-1 font-medium">{title}</h2>
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
          <HeaderButton label={t`New chat`} onClick={onNewChat}>
            <SquarePenIcon />
          </HeaderButton>
        </>
      )}
      {mode === "frame" ? (
        <HeaderButton
          label={t`Open at the side`}
          onClick={() => {
            onMove("drawer");
          }}
        >
          <Maximize2Icon />
        </HeaderButton>
      ) : (
        <HeaderButton
          label={t`Back to the small chat`}
          onClick={() => {
            onMove("frame");
          }}
        >
          <Minimize2Icon />
        </HeaderButton>
      )}
      <HeaderButton
        label={t`Fold the chat away`}
        onClick={() => {
          onMove("bar");
        }}
      >
        <ChevronDownIcon />
      </HeaderButton>
    </header>
  );
};

/** The open dock's conversation, or what to ask before there is one. */
const DockThread = ({
  empty,
  chatId,
  view,
  failure,
  onRetry,
}: {
  /** What it says before anything is asked. */
  empty: string;
  chatId: string | undefined;
  view: ReturnType<typeof useFollowedChat>["view"];
  failure: string | undefined;
  onRetry: () => void;
}) => {
  if (chatId === undefined) {
    return <p className="text-muted-foreground flex-1 p-4">{empty}</p>;
  }
  return (
    <ChatThread
      chatId={chatId}
      loaded={view.loaded || failure !== undefined}
      messages={view.messages}
      onRetry={onRetry}
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
    </ChatThread>
  );
};

/** What the dock is called and says: Grasp's, or over the atlas the brain's. */
interface DockWords {
  title: string;
  placeholder: string;
  empty: string;
}

/**
 * The brain's open questions, as the brain page read them (the brain's
 * layout loads them: routes/_shell.brain.tsx), to answer or have asked
 * about; the brain is read again when one was.
 */
const DockQuestions = ({ slot }: { slot: ChatSlot }) => {
  const router = useRouter();
  const { identity } = useRouteContext({ from: "/_shell" });
  const brain = useMatch({ from: "/_shell/brain", shouldThrow: false });
  const loaded = brain?.loaderData;
  if (slot !== "brain" || loaded?.state !== "ready") {
    return null;
  }
  return (
    <BrainQuestions
      gaps={loaded.data.workspace.gaps}
      identity={identity}
      onChanged={() => {
        void router.invalidate();
      }}
    />
  );
};

/**
 * The dock itself: on every page in the frame but Chat's, carrying on the
 * tab's open chat of `slot` (active-chat.ts).
 */
const Dock = ({
  slot,
  words,
  models,
  retry,
}: {
  slot: ChatSlot;
  words: DockWords;
  /** The models a question may name; none while they are read. */
  models: Loaded<Offered> | undefined;
  /** Reads the models again, as after core was out of reach. */
  retry: () => void;
}) => {
  const { t } = useLingui();
  const chatId = useActiveChat(slot);
  const { view, failure } = useFollowedChat(chatId);
  const noModels = useNoModels(models);
  // Core out of reach or refusing may pass: the read can be asked for again.
  const canRetry = models !== undefined && models.state !== "ready";
  const offered = models?.state === "ready" ? models.data : undefined;
  const { composer, ask } = useAsk(
    chatId,
    offered?.models ?? [],
    offered?.efforts,
    "here",
    undefined,
    slot
  );
  const mode = useDockMode();
  // The box stays as the dock moves, but the button that moved it may go:
  // the focus goes back to the box, so the cursor stays in it as the frame
  // opens, grows or folds away.
  const dock = useRef<HTMLElement>(null);
  const focusBox = (): void => {
    requestAnimationFrame(() => {
      dock.current?.querySelector("textarea")?.focus();
    });
  };
  const moveTo = (next: DockMode): void => {
    setDockMode(next);
    focusBox();
  };
  const open = mode !== "bar";
  const lastQuestion = view.messages.findLast(({ role }) => role === "user");
  const box = (
    <Composer
      {...composer}
      compact
      label={words.title}
      onSend={() => {
        if (mode === "bar") {
          moveTo("frame");
        }
        composer.onSend();
      }}
      placeholder={words.placeholder}
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
  const drawer = mode === "drawer";
  // One tree in every mode, so the box, and the draft in it, stays as the
  // dock opens, grows or folds away. As in the prototype's corner chat
  // (`components/chat/corner-chat.tsx`): the bar 320 pixels wide at rest and
  // 416 typed in, as round as the box in it; the frame and the drawer
  // 442 wide, the frame kept 16 pixels off every edge of the window and
  // rising out of the bar as it opens.
  let place =
    "pointer-events-none fixed inset-x-7 bottom-7 z-40 flex justify-end";
  let look =
    "chat-glow bg-background/80 pointer-events-auto w-80 max-w-full rounded-md text-sm backdrop-blur-md transition-all duration-300 ease-out focus-within:w-104 motion-reduce:transition-none";
  if (drawer) {
    place =
      "pointer-events-none fixed inset-y-2 right-2 left-2 z-40 flex justify-end";
    look =
      "bg-background pointer-events-auto flex h-full w-110.5 max-w-full flex-col border-l text-sm";
  } else if (open) {
    place = "pointer-events-none fixed inset-4 z-40 flex items-end justify-end";
    look =
      "chat-glow bg-background/80 animate-in fade-in-0 zoom-in-97 slide-in-from-bottom-4 pointer-events-auto flex h-136 max-h-full w-110.5 max-w-full origin-bottom-right flex-col overflow-hidden rounded-2xl border text-sm backdrop-blur-md duration-300 ease-out motion-reduce:animate-none";
  }
  return (
    <div className={place}>
      <section
        aria-label={open ? words.title : undefined}
        className={look}
        ref={dock}
      >
        {open ? (
          <DockHeader
            chatId={chatId}
            title={words.title}
            mode={drawer ? "drawer" : "frame"}
            onMove={moveTo}
            onNewChat={() => {
              setActiveChat(undefined, slot);
              focusBox();
            }}
          />
        ) : null}
        {open ? (
          <DockThread
            chatId={chatId}
            empty={words.empty}
            failure={failure}
            onRetry={() => {
              if (lastQuestion?.role === "user") {
                void ask(lastQuestion.text);
              }
            }}
            view={view}
          />
        ) : null}
        {open ? <DockQuestions slot={slot} /> : null}
        <div className={open ? "flex flex-none flex-col gap-1 p-3" : undefined}>
          {box}
          {noModels === undefined ? null : (
            <p
              className={
                open
                  ? "text-muted-foreground flex items-center gap-2 px-1 text-xs"
                  : "text-muted-foreground flex items-center gap-2 px-3 pb-2 text-xs"
              }
            >
              {noModels}
              {canRetry ? (
                <Button onClick={retry} size="xs" variant="link">
                  <Trans>Try again</Trans>
                </Button>
              ) : null}
            </p>
          )}
        </div>
      </section>
    </div>
  );
};

/**
 * The dock where it belongs: on every page in the frame but Chat's own,
 * which is the chat at full size. In the brain (its atlas, a region of
 * it, a note or a part's page) it is the brain's own chat, kept as the
 * person moves about the brain, as in the prototype
 * (`knowledge/brain-chat.tsx`): its own conversation, apart from the one
 * Chat shows, asked of Grasp's agent through core's chat like any other,
 * whose answers cite the notes they used (`ChatCitation`, opening them as
 * `CitedNote` does).
 *
 * The brain's open questions wait in the brain's chat, between the thread
 * and the box (`DockQuestions`), each to answer there or to have Grasp ask
 * the role that can.
 */
export const ChatDock = () => {
  const { t } = useLingui();
  const { pathname } = useLocation();
  // Read here, once for every page, not by each dock: the brain's dock and
  // the chat's take each other's place between pages, and each read them
  // again when it did.
  const { value: models, readAgain } = useFrameRead(readModels);
  if (pathname === "/") {
    return null;
  }
  if (pathname === "/brain" || pathname.startsWith("/brain/")) {
    return (
      <Dock
        key="brain"
        models={models}
        retry={readAgain}
        slot="brain"
        words={{
          title: t`Ask the brain`,
          placeholder: t`Ask anything about the brain`,
          empty: t`Ask anything about what the brain holds`,
        }}
      />
    );
  }
  return (
    <Dock
      key="chat"
      models={models}
      retry={readAgain}
      slot="chat"
      words={{
        title: t`Ask Grasp`,
        placeholder: t`Ask Grasp`,
        empty: t`Ask anything, or describe a process`,
      }}
    />
  );
};
