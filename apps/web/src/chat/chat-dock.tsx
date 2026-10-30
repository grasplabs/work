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
  Maximize2Icon,
  MessagesSquareIcon,
  Minimize2Icon,
  SquarePenIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject, ReactNode } from "react";

import type { CoreConnection } from "../core-connection.ts";
import { ErrorText } from "../error-text.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCore } from "../use-core.ts";
import { setActiveChat, useActiveChat } from "./active-chat.ts";
import type { ChatSlot } from "./active-chat.ts";
import { BrainQuestions } from "./brain-questions.tsx";
import { useFollowedChat } from "./chat-watch.ts";
import { Composer } from "./composer.tsx";
import {
  dockDrawer,
  dockDrawerWidth,
  setDockDrawerWidth,
  setDockMode,
  settledDrawerWidth,
  useDockDrawerWidth,
  useDockMode,
  widestDockDrawer,
} from "./dock-mode.ts";
import type { DockMode } from "./dock-mode.ts";
import { DrawerEdge } from "./drawer-edge.tsx";
import { HeldWrites } from "./held-writes.tsx";
import { ChatThread } from "./thread.tsx";
import { useAsk } from "./use-ask.ts";

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

/**
 * The models a question may name, read once the dock is shown and again
 * on `retry`, as after core was out of reach.
 */
const useModels = (): {
  models: Loaded<Offered> | undefined;
  retry: () => void;
} => {
  const core = useCore();
  const [models, setModels] = useState<Loaded<Offered>>();
  useEffect(() => {
    const left = new AbortController();
    const read = async (): Promise<void> => {
      const loaded = await readModels(core, left.signal);
      if (!left.signal.aborted) {
        setModels(loaded);
      }
    };
    void read();
    return () => {
      left.abort();
    };
  }, [core]);
  return {
    models,
    retry: () => {
      setModels(undefined);
      void (async () => {
        setModels(await readModels(core));
      })();
    },
  };
};

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
          ? "flex h-(--header-height) flex-none items-center gap-0.5 border-b pr-2.5 pl-5"
          : "flex h-13 flex-none items-center gap-0.5 border-b pr-2.5 pl-5"
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
    return <p className="text-muted-foreground flex-1 p-5">{empty}</p>;
  }
  return (
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
 * How wide the frame or the drawer is, as a variable the dock's class
 * reads (no inline style): the frame always as the drawer is at first, the
 * drawer as its edge was dragged. A window made narrower takes the drawer
 * in with it. Returns what the edge sets the width with while it is
 * dragged.
 */
const useDockWidth = (
  dock: RefObject<HTMLElement | null>,
  drawer: boolean
): ((width: number) => void) => {
  const drawerWidth = useDockDrawerWidth();
  const width = drawer ? drawerWidth : dockDrawer.normal;
  useLayoutEffect(() => {
    dock.current?.style.setProperty("--dock-width", `${width}px`);
  }, [dock, width]);
  useEffect(() => {
    const fit = (): void => {
      setDockDrawerWidth(
        settledDrawerWidth(dockDrawerWidth(), widestDockDrawer(innerWidth))
      );
    };
    fit();
    addEventListener("resize", fit);
    return () => {
      removeEventListener("resize", fit);
    };
  }, []);
  return (next) => {
    dock.current?.style.setProperty("--dock-width", `${next}px`);
  };
};

/**
 * The dock itself: on every page in the frame but Chat's, carrying on the
 * tab's open chat of `slot` (active-chat.ts).
 */
const Dock = ({ slot, words }: { slot: ChatSlot; words: DockWords }) => {
  const chatId = useActiveChat(slot);
  const { view, failure } = useFollowedChat(chatId);
  const { models, retry } = useModels();
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
  const drawerWidth = useDockDrawerWidth();
  // While the drawer's edge is dragged, nothing eases.
  const [dragging, setDragging] = useState(false);
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
  // A click into the folded box, with a conversation behind it, opens the
  // chat on it: the box is the way in, with no arrow of its own. A click
  // counts even with the cursor already in the box. Only a pointer opens
  // it: tabbing into the box is to type in it, and sending opens the chat.
  const open = mode !== "bar";
  const unfolds = !open && chatId !== undefined;
  useEffect(() => {
    const element = dock.current;
    const unfold = (event: Event): void => {
      if (event.target instanceof HTMLTextAreaElement) {
        setDockMode("frame");
      }
    };
    if (unfolds) {
      element?.addEventListener("pointerdown", unfold);
    }
    return () => {
      element?.removeEventListener("pointerdown", unfold);
    };
  }, [unfolds]);
  const showWidth = useDockWidth(dock, mode === "drawer");
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
    />
  );
  const drawer = mode === "drawer";
  // One tree in every mode, so the box, and the draft in it, stays as the
  // dock opens, grows or folds away. As in the prototype's corner chat
  // (`components/chat/corner-chat.tsx`): the bar 320 pixels wide at rest and
  // 416 typed in, 28 pixels off the window's corner; the frame 442 wide,
  // kept 16 pixels off every edge of the window and rising out of the bar
  // as it opens; the drawer as wide as its edge was dragged. Each is a
  // white card on `shadow-lifted`, with no glow, blur or ring round it.
  let place =
    "pointer-events-none fixed inset-x-7 bottom-7 z-40 flex justify-end";
  let look =
    "bg-card shadow-lifted pointer-events-auto w-80 max-w-full rounded-xl text-sm transition-[width] duration-300 focus-within:w-104 motion-reduce:transition-none";
  if (drawer) {
    place =
      "pointer-events-none fixed inset-y-2 right-2 left-2 z-40 flex justify-end";
    look =
      "bg-card pointer-events-auto relative flex h-full w-(--dock-width) max-w-full flex-col border-l text-sm";
  } else if (open) {
    place = "pointer-events-none fixed inset-4 z-40 flex items-end justify-end";
    look =
      "bg-card shadow-lifted animate-in fade-in-0 zoom-in-97 slide-in-from-bottom-4 pointer-events-auto flex h-136 max-h-full w-(--dock-width) max-w-full origin-bottom-right flex-col overflow-hidden rounded-xl text-sm duration-300 motion-reduce:animate-none";
  }
  return (
    <div className={place}>
      <section
        aria-label={open ? words.title : undefined}
        className={look}
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
        <div
          className={
            open ? "flex flex-none flex-col gap-1 px-5 pt-2 pb-5" : undefined
          }
        >
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
  if (pathname === "/") {
    return null;
  }
  if (pathname === "/brain" || pathname.startsWith("/brain/")) {
    return (
      <Dock
        key="brain"
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
      slot="chat"
      words={{
        title: t`Ask Grasp`,
        placeholder: t`Ask Grasp`,
        empty: t`Ask anything, or describe a process`,
      }}
    />
  );
};
