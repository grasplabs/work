import { failureText } from "@grasp-os/shared/errors";
import type { ModelEfforts } from "@grasp-os/shared/models";
import { Button, buttonVariants } from "@grasp-os/ui/components/button";
import { Spinner } from "@grasp-os/ui/components/spinner";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  Link,
  useLocation,
  useMatch,
  useNavigate,
  useRouteContext,
  useRouter,
} from "@tanstack/react-router";
import {
  ChevronDownIcon,
  Maximize2Icon,
  MessagesSquareIcon,
  Minimize2Icon,
  SquarePenIcon,
} from "lucide-react";
import { lazy, Suspense, useId, useRef, useState } from "react";
import type { ReactNode } from "react";

import type { CoreConnection } from "../core-connection.ts";
import type { Session } from "../core.ts";
import { buildsApp } from "../engines/app-role.ts";
import { ErrorText } from "../error-text.tsx";
import { ConnectAiProvider } from "../frame/connect-ai-provider.tsx";
import { useFrameRead } from "../frame/frame-read.ts";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCore } from "../use-core.ts";
import { appSlot, setActiveChat, useActiveChat } from "./active-chat.ts";
import type { ChatSlot } from "./active-chat.ts";
import { BrainQuestions } from "./brain-questions.tsx";
import { useFollowedChat } from "./chat-watch.ts";
import { Composer } from "./composer.tsx";
import { OpenChat, useDockWidth, useUnfoldOnPointer } from "./dock-frame.tsx";
import { setDockMode, useDockDrawerWidth, useDockMode } from "./dock-mode.ts";
import type { DockMode } from "./dock-mode.ts";
import { DrawerEdge } from "./drawer-edge.tsx";
import { HeldWrites } from "./held-writes.tsx";
import { useAsk } from "./use-ask.ts";
import type { AskOptions } from "./use-ask.ts";

// The conversation, with its Markdown and code highlighting, loads once a
// chat is open: most pages show the dock folded or empty.
const ChatThread = lazy(async () => {
  const { ChatThread: thread } = await import("./thread.tsx");
  return { default: thread };
});

// Grasp's chat on every page but Chat's own, bottom right, as in the
// prototype (`components/chat/global-chat.tsx`, `knowledge/brain-chat.tsx`):
// the person's open chat, so what is asked anywhere goes on there and shows
// in its list, and a new chat here is a new one there. A slim bar to ask in;
// sending, or a click into it with a chat behind it, opens a frame around
// it with the conversation, which grows into a drawer down the right side
// (its edge dragged to make it wider or narrower) and back, or folds away
// to the bar. Folded or open, it is a white card with the brand's soft
// shadow; its surfaces share one rounding and its controls another, and
// what is in it keeps 20 pixels from every edge. The thread and the box are the chat's own (thread.tsx,
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
  signal: AbortSignal
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

/**
 * Why nothing can be asked yet, if that is so: the models are what a
 * question names. None offered means no AI provider to call yet, or none
 * of its models chosen: `provider`, said as a state with the way out.
 */
const useNoModels = (
  models: Loaded<Offered> | undefined
): { why: "provider" } | { why: "read"; text: string } | undefined => {
  const { t } = useLingui();
  if (models === undefined || models.state === "ready") {
    return models?.state === "ready" && models.data.models.length === 0
      ? { why: "provider" }
      : undefined;
  }
  if (models.state === "offline") {
    return {
      why: "read",
      text: t`Grasp can't be reached right now. Try again in a moment.`,
    };
  }
  return models.state === "refused"
    ? { why: "read", text: models.message }
    : undefined;
};

/**
 * Why nothing can be asked yet, under the box: the way to connect an AI
 * provider, or why the models couldn't be read, with the way to read them
 * again.
 */
const NoModels = ({
  noModels,
  open,
  onRetry,
}: {
  noModels: NonNullable<ReturnType<typeof useNoModels>>;
  open: boolean;
  onRetry: (() => void) | undefined;
}) => {
  if (noModels.why === "provider") {
    return (
      <div className={open ? undefined : "px-3 pb-3"}>
        <ConnectAiProvider size="xs" />
      </div>
    );
  }
  return (
    <p
      className={
        open
          ? "text-muted-foreground flex items-center gap-2 px-1 text-xs"
          : "text-muted-foreground flex items-center gap-2 px-3 pb-2 text-xs"
      }
    >
      {noModels.text}
      {onRetry === undefined ? null : (
        <Button onClick={onRetry} size="xs" variant="link">
          <Trans>Try again</Trans>
        </Button>
      )}
    </p>
  );
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
  newChatAlways = false,
}: {
  title: string;
  chatId: string | undefined;
  mode: "frame" | "drawer";
  onMove: (next: DockMode) => void;
  onNewChat: () => void;
  /** New chat goes elsewhere (New app), so it is there before any chat is. */
  newChatAlways?: boolean;
}) => {
  const { t } = useLingui();
  return (
    <header
      className={
        mode === "drawer"
          ? "flex h-(--header-height) flex-none items-center gap-0.5 border-b pr-2.5 pl-5"
          : "flex h-13 flex-none items-center gap-0.5 border-b pr-2.5 pl-5"
      }
    >
      <h2 className="flex-1 font-medium">{title}</h2>
      {chatId === undefined && newChatAlways ? (
        <HeaderButton label={t`New chat`} onClick={onNewChat}>
          <SquarePenIcon />
        </HeaderButton>
      ) : null}
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
  const { t } = useLingui();
  // Before anything is asked: a chat not made yet, or one made empty (an
  // App's, opened before its first question).
  if (chatId === undefined || (view.loaded && view.messages.length === 0)) {
    return <p className="text-muted-foreground flex-1 p-5">{empty}</p>;
  }
  return (
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
    </Suspense>
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

// One tree in every mode, so the box, and the draft in it, stays as the
// dock opens, grows or folds away. As in the prototype's corner chat
// (`components/chat/corner-chat.tsx`): the bar 320 pixels wide at rest and
// 416 typed in, 36 pixels off the window's corner (its `right-7 bottom-7`
// inside a layer 8 pixels in); the frame 442 wide,
// kept 16 pixels off every edge of the window and rising out of the bar
// as it opens; the drawer as wide as its edge was dragged. Each is a
// white card on `shadow-lifted`, with no glow, blur or ring round it.
const dockLook = (mode: DockMode): { place: string; look: string } => {
  let place =
    "pointer-events-none fixed inset-x-9 bottom-9 z-40 flex justify-end";
  let look =
    "bg-card shadow-lifted pointer-events-auto w-80 max-w-full rounded-xl text-sm transition-[width] duration-300 focus-within:w-104 motion-reduce:transition-none";
  if (mode === "drawer") {
    place =
      "pointer-events-none fixed inset-y-2 right-2 left-2 z-40 flex justify-end";
    look =
      "bg-card pointer-events-auto relative flex h-full w-(--dock-width) max-w-full flex-col border-l text-sm";
  } else if (mode === "frame") {
    place = "pointer-events-none fixed inset-4 z-40 flex items-end justify-end";
    look =
      "bg-card shadow-lifted animate-in fade-in-0 zoom-in-97 slide-in-from-bottom-4 pointer-events-auto flex h-136 max-h-full w-(--dock-width) max-w-full origin-bottom-right flex-col overflow-hidden rounded-xl text-sm duration-300 motion-reduce:animate-none";
  }
  return { place, look };
};

/** The chat of App `app` the person changes it in, made the first time. */
const appChatOf = async (session: Session, app: string): Promise<string> => {
  const chat = await session.chats.forApp(app);
  return chat.id;
};

/**
 * What the dock's slot does that differs by whose chat it is. Grasp's or
 * the brain's: New chat starts afresh here. An App's own (`app`): its chat
 * is the person's for the App (`chats.forApp`), made once they first ask
 * in it or open it; what they say moves on to the App's versions in Chat,
 * with the chat open; and New chat goes to New app.
 */
const useSlotWays = (
  app: string | undefined,
  slot: ChatSlot,
  focusBox: () => void
) => {
  const navigate = useNavigate();
  const core = useCore();
  const [failure, setFailure] = useState<string>();
  const options: AskOptions | undefined =
    app === undefined
      ? undefined
      : {
          chatFor: async (session) => await appChatOf(session, app),
          onAsked: (chatId) => {
            void navigate({ to: "/", search: { chat: chatId, panel: true } });
          },
        };
  /** Finds the App's chat, to open it before anything is asked. */
  const openApp = async (forApp: string): Promise<void> => {
    setFailure(undefined);
    try {
      const chatId = await core.withSession(
        async (session) => await appChatOf(session, forApp)
      );
      setActiveChat(chatId, slot);
    } catch (error) {
      setFailure(failureText(error));
    }
  };
  return {
    options,
    failure,
    /** Whether the dock opens before any chat is, and New chat is there. */
    always: app !== undefined,
    /** Whether the bar offers to open the dock, holding `chatId`. */
    opens: (chatId: string | undefined): boolean =>
      chatId !== undefined || app !== undefined,
    /**
     * The dock moved to `next`, holding `chatId`: an App's chat opened
     * before anything is asked in it shows what was said in it before.
     */
    onMoved: (next: DockMode, chatId: string | undefined): void => {
      if (next !== "bar" && chatId === undefined && app !== undefined) {
        void openApp(app);
      }
    },
    handleNewChat: (): void => {
      if (app === undefined) {
        setActiveChat(undefined, slot);
        focusBox();
      } else {
        void navigate({ to: "/apps/new" });
      }
    },
  };
};

/**
 * The dock itself: on every page in the frame but Chat's, carrying on the
 * tab's open chat of `slot` (active-chat.ts); on an App's page for whoever
 * changes it, the App's own (`app`).
 */
const Dock = ({
  slot,
  words,
  app,
  models,
  retry,
}: {
  slot: ChatSlot;
  words: DockWords;
  app?: string;
  /** The models a question may name; none while they are read. */
  models: Loaded<Offered> | undefined;
  /** Reads the models again, as after core was out of reach. */
  retry: () => void;
}) => {
  const chatId = useActiveChat(slot);
  const { view, failure } = useFollowedChat(chatId);
  const noModels = useNoModels(models);
  // Core out of reach or refusing may pass: the read can be asked for again.
  const canRetry = models !== undefined && models.state !== "ready";
  const offered = models?.state === "ready" ? models.data : undefined;
  // The box stays as the dock moves, but the button that moved it may go:
  // the focus goes back to the box, so the cursor stays in it as the frame
  // opens, grows or folds away.
  const dock = useRef<HTMLElement>(null);
  const focusBox = (): void => {
    requestAnimationFrame(() => {
      dock.current?.querySelector("textarea")?.focus();
    });
  };
  const ways = useSlotWays(app, slot, focusBox);
  const { composer, ask } = useAsk(
    chatId,
    offered?.models ?? [],
    offered?.efforts,
    "here",
    undefined,
    slot,
    ways.options
  );
  const mode = useDockMode();
  const drawerWidth = useDockDrawerWidth();
  // While the drawer's edge is dragged, nothing eases.
  const [dragging, setDragging] = useState(false);
  const moveTo = (next: DockMode): void => {
    setDockMode(next);
    focusBox();
    ways.onMoved(next, chatId);
  };
  // A click into the folded box, with a conversation behind it, opens the
  // chat on it, even with the cursor already in the box. Tabbing into the
  // box is to type in it; the keyboard's way in is the box's own button
  // (OpenChat), which the box's description names.
  const open = mode !== "bar";
  const unfolds = !open && ways.opens(chatId);
  useUnfoldOnPointer(dock, unfolds, () => {
    moveTo("frame");
  });
  const showWidth = useDockWidth(dock, mode === "drawer");
  const dockId = useId();
  const hintId = useId();
  const lastQuestion = view.messages.findLast(({ role }) => role === "user");
  const box = (
    <Composer
      {...composer}
      compact
      describedBy={unfolds ? hintId : undefined}
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
      {unfolds ? (
        <OpenChat
          controls={dockId}
          hint={hintId}
          onOpen={() => {
            moveTo("frame");
          }}
        />
      ) : null}
    </Composer>
  );
  const drawer = mode === "drawer";
  const { place, look } = dockLook(mode);
  return (
    <div className={place}>
      <section
        aria-label={open ? words.title : undefined}
        className={look}
        id={dockId}
        ref={dock}
      >
        {drawer ? (
          <DrawerEdge
            dragging={dragging}
            onClose={() => {
              moveTo("frame");
            }}
            onDragging={setDragging}
            onPreview={showWidth}
            width={drawerWidth}
          />
        ) : null}
        {open ? (
          <DockHeader
            chatId={chatId}
            title={words.title}
            mode={drawer ? "drawer" : "frame"}
            onMove={moveTo}
            newChatAlways={ways.always}
            onNewChat={ways.handleNewChat}
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
        <div
          className={
            open ? "flex flex-none flex-col gap-1 px-5 pt-2 pb-5" : undefined
          }
        >
          {box}
          <ErrorText>{ways.failure}</ErrorText>
          {noModels === undefined ? null : (
            <NoModels
              noModels={noModels}
              onRetry={canRetry ? retry : undefined}
              open={open}
            />
          )}
        </div>
      </section>
    </div>
  );
};

/**
 * The dock where it belongs: on every page in the frame but Chat's own,
 * which is the chat at full size, and a project's, whose box starts a
 * chat in the project. In the brain (its atlas, a region of
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
  const { identity } = useRouteContext({ from: "/_shell" });
  const appPage = useMatch({ from: "/_shell/apps/$app", shouldThrow: false });
  const loaded = appPage?.loaderData;
  const app = loaded?.state === "ready" ? loaded.data.app : undefined;
  // Read here, once for every page, not by each dock: the brain's dock, each
  // App's and the chat's take each other's place between pages, and each
  // read them again when it did. Chat is the chat at full size, and a
  // project's page has its own box, which starts a chat in the project:
  // neither shows a dock, nor reads its models.
  const shown = !(pathname === "/" || pathname.startsWith("/projects/"));
  const { value: models, readAgain } = useFrameRead(readModels, shown);
  if (!shown) {
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
  // An App's page has the App's own chat here, for whoever changes it;
  // anyone else asks Grasp as anywhere.
  if (
    app !== undefined &&
    buildsApp(app, identity) &&
    app.status !== "archived"
  ) {
    const { id, name } = app;
    return (
      <Dock
        app={id}
        key={`app:${id}`}
        models={models}
        retry={readAgain}
        slot={appSlot(id)}
        words={{
          title: name,
          placeholder: t`Say what should change`,
          empty: t`Say what should change in ${name}. Every change is a new version of it.`,
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
