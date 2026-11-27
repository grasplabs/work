import type { ChatAgent } from "@grasp-os/shared/chat";
import type { ModelEfforts } from "@grasp-os/shared/models";
import type { Subject } from "@grasp-os/shared/subject";
import { useLingui } from "@lingui/react/macro";
import { useRouteContext } from "@tanstack/react-router";
import {
  createContext,
  use,
  useEffect,
  useEffectEvent,
  useSyncExternalStore,
} from "react";
import type { ReactNode } from "react";

import type { CoreConnection } from "../core-connection.ts";
import type { Session } from "../core.ts";
import { useFrameRead } from "../frame/frame-read.ts";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { isShortcut } from "../shortcuts.ts";
import {
  setActiveChat,
  showSlot,
  useActiveChat,
  useShownName,
  useShownSlot,
} from "./active-chat.ts";
import type { ChatSlot } from "./active-chat.ts";
import { pendingAsk } from "./asked-questions.tsx";
import { answeredAfterBuild } from "./build-answered.ts";
import { useChatBuilds } from "./builds.tsx";
import { readChatNames, useChatSummary } from "./chat-details.ts";
import { closeChat, useChatLayout } from "./chat-layout.ts";
import {
  allows,
  chatPresence,
  placementOn,
  useChatPresence,
  useOpenChat,
} from "./chat-presence.ts";
import type { ChatPresence } from "./chat-presence.ts";
import { stageOf } from "./chat-stage.ts";
import {
  slotOf,
  subjectOf,
  subjectWords,
  useSubjectChat,
} from "./chat-subject.ts";
import { useFollowedChat } from "./chat-watch.ts";
import { useNoRoomBeside } from "./room-beside.ts";
import type { SourceName } from "./sources.tsx";
import { useAsk } from "./use-ask.ts";

/** Narrower than this, a phone or a narrow window: the chat stands docked, never floating. */
const narrowQuery = "(max-width: 767px)";

/**
 * App shell's narrow shell (its `width < 40rem`), a phone: docked, the chat
 * covers the whole page, so a page about a subject shows itself first.
 */
const phoneQuery = "(width < 40rem)";

/** Whether the window matches `query` now, followed as it changes; never on the server. */
const useMatches = (query: string): boolean =>
  useSyncExternalStore(
    (onChange) => {
      const list = matchMedia(query);
      list.addEventListener("change", onChange);
      return () => {
        list.removeEventListener("change", onChange);
      };
    },
    () => matchMedia(query).matches,
    () => false
  );

// Grasp's one chat, on every page: the person's open chat
// (active-chat.ts), so what is asked anywhere goes on there and shows in
// their list, as on Chat. Closed, it is an idle bar at the foot of the page
// (chat-bar.tsx); open, a panel docked beside the page or floating over it
// (chat-panel.tsx, laid out by chat-layout.ts, shown as chat-stage.ts
// says). The chat and what is typed
// in its box are held here, once, for the whole shell, so they stay as the
// chat opens, closes or moves, and as the person moves between pages.
//
// Where it may show is each page's to say (chat-presence.ts): not at all
// on Chat's start or a chat's own page (chat-page.tsx), which are where to
// ask, and the dock doesn't follow the person off them; none for Grasp staff who reach the onboarding alone: core refuses
// them chats. What it is about is each page's to say too
// (chat-subject.ts): an App's workspace has the chat that builds the App,
// a workflow's page the one that draws it, docked beside them.

/**
 * The models a question may name, and the efforts each takes, and the
 * company's agents the person may talk to, the first one first.
 */
interface Offered {
  models: string[];
  efforts: Record<string, ModelEfforts>;
  agents: ChatAgent[];
}

/**
 * The agents the person may talk to; none when core couldn't say, and a
 * new chat is then with the company's first one, as it always was.
 */
const readAgents = async (session: Session): Promise<ChatAgent[]> => {
  try {
    return await session.chats.agents();
  } catch {
    return [];
  }
};

/** The models a question may name, as core lists them, with their efforts. */
const readModels = async (
  core: CoreConnection,
  signal: AbortSignal
): Promise<Loaded<Offered>> =>
  await loadFromCore(
    core,
    async (session) => {
      const [models, efforts, agents] = await Promise.all([
        session.chats.models(),
        session.chats.efforts(),
        readAgents(session),
      ]);
      return { models, efforts, agents };
    },
    signal
  );

/** Why nothing can be asked yet: no AI provider, or the models unreadable. */
export type ModelsUnavailable =
  | { why: "provider" }
  | { why: "read"; text: string };

/**
 * Why nothing can be asked yet, if that is so: the models are what a
 * question names. None offered means no AI provider to call yet, or none
 * of its models chosen.
 */
const useModelsUnavailable = (
  models: Loaded<Offered> | undefined
): ModelsUnavailable | undefined => {
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

/** What the chat is called and says. */
interface ChatWords {
  title: string;
  placeholder: string;
}

/**
 * Where the chat may show on this page (chat-presence.ts): nowhere for
 * Grasp staff who reach the onboarding alone, whom core refuses chats;
 * docked beside a page about a subject (chat-subject.ts), as part of it,
 * whatever its route says for anyone who isn't building there; on a
 * `phone`, its bar there too, to open it by.
 */
const usePresenceHere = (phone: boolean): ChatPresence => {
  const { identity } = useRouteContext({ from: "/_shell" });
  const presence = useChatPresence();
  const about = subjectOf(useShownSlot());
  if (identity.onboardingOnly === true) {
    return chatPresence.hidden;
  }
  if (about === undefined) {
    return presence;
  }
  // On a phone the subject's page shows first, its chat a bar to open.
  return phone ? { ...chatPresence.docked, bar: true } : chatPresence.docked;
};

/**
 * What the chat says: about the page's subject, what that subject's kind
 * says (chat-subject.ts); anywhere else, Grasp's own words.
 */
const useChatWords = (): ChatWords => {
  const { t, i18n } = useLingui();
  const subject = subjectOf(useShownSlot());
  if (subject !== undefined) {
    const { title, placeholder } = subjectWords;
    return {
      title: i18n._(title),
      placeholder: i18n._(placeholder),
    };
  }
  const title = t`Ask Grasp`;
  return {
    title,
    placeholder: title,
  };
};

/**
 * What each question asked in `slot` is about: its subject (chat-subject.ts),
 * named as its page names it; none for the person's own.
 */
const useQuestionSubject = (
  slot: ChatSlot
): { about: Subject | undefined; name: string | undefined } => {
  const name = useShownName();
  const about = subjectOf(slot);
  return { about, name: about === undefined ? undefined : name };
};

const useGlobalChatValue = () => {
  const { identity } = useRouteContext({ from: "/_shell" });
  const phone = useMatches(phoneQuery);
  const presence = usePresenceHere(phone);
  const available = presence.placements.length > 0;
  // Read once for every page, not again as the person moves between them,
  // and on a chat's own page too, where the dock has no place: anywhere
  // the person may chat at all (not Grasp staff in the onboarding alone).
  const chats = identity.onboardingOnly !== true;
  const { value: models, readAgain } = useFrameRead(readModels, chats);
  const modelsUnavailable = useModelsUnavailable(models);
  const offered = models?.state === "ready" ? models.data : undefined;
  const words = useChatWords();
  // The open chat of what this page is about (chat-subject.ts), or the
  // person's own; a subject's found from core while it has none.
  const slot = useShownSlot();
  const chatId = useActiveChat(slot);
  const finding = useSubjectChat(slot, chatId);
  // What each question is about: the page's subject, on the box's bar.
  const subject = useQuestionSubject(slot);
  const { view, failure, gone } = useFollowedChat(chatId);
  const { composer, ask, box, sendNow } = useAsk(
    chatId,
    offered?.models,
    offered?.efforts,
    slot,
    {
      running: view.running,
      ...(subject.about === undefined ? {} : { subject: subject.about }),
    }
  );
  const builds = useChatBuilds(chatId, view.running, view.worked);
  const { summary, retitle } = useChatSummary(chatId, view.running);
  // Core has no such chat (deleted, or not the person's): the next question
  // starts one, and a subject's is found again.
  useEffect(() => {
    if (chatId !== undefined && gone === true) {
      setActiveChat(undefined, slot);
    }
  }, [chatId, gone, slot]);
  const layout = useChatLayout();
  const roomBeside = !useMatches(narrowQuery);
  const noRoomBeside = useNoRoomBeside();
  // About the page's subject, it stays open (chat-subject.ts), where the
  // page has it: that page is where its subject is made. On a phone, where
  // it would cover that page, the page shows first and the chat opens as
  // anywhere else, when the person asks. Elsewhere, open where it was put,
  // where this page allows it there; elsewhere it stays open, and shows
  // again on a page that does.
  const about = subjectOf(slot) !== undefined;
  // Nor where the page has no room beside it docked (room-beside.ts): it
  // would lie over the page with no way back to it.
  const keptOpen = about && !phone && !noRoomBeside;
  // A subject's page has it docked, wherever it was put elsewhere.
  const placement = about
    ? (placementOn(presence, layout.placement) ?? layout.placement)
    : layout.placement;
  const open = (keptOpen || layout.open) && allows(presence, placement);
  const stage = stageOf({
    available,
    open,
    placement,
    roomBeside,
    barHere: presence.bar,
  });
  const { value: names } = useFrameRead(readChatNames, chats);
  return {
    chatId,
    view,
    failure,
    /** Before anything is asked: a chat not made yet, or one made empty. */
    empty: chatId === undefined || (view.loaded && view.messages.length === 0),
    composer,
    /** Which draft the box shows, which starts its editor afresh. */
    box,
    ask,
    /** Has the agent take the questions queued behind its answer at once. */
    sendNow,
    /** The Apps its agent builds, read as it writes them. */
    builds,
    /** The questions the chat's agent asked last, answered in the person's next message. */
    asking: pendingAsk(view.messages, view.running),
    /** The open chat's summary: its title, once core has said it. */
    summary,
    /** Shows a new name the person gave the open chat at once. */
    retitle,
    /** Where the chat may show on this page, and whether its bar does. */
    presence,
    /** Whether the chat is on this page at all. */
    available,
    /** Whether it is open here: where it was put, if this page allows that. */
    open,
    /** Whether it stays open here, about the page's subject: no closing it. */
    keptOpen,
    /** Whether there is room beside the page to dock into: not on a phone. */
    roomBeside,
    /** Where it opens, or is. */
    placement,
    /** What of it shows now. */
    stage,
    words,
    /** The tab's slot the chat is in: a subject's (chat-subject.ts), or the person's. */
    slot,
    /** While a subject's chat is found: why core gave none, and asking again. */
    finding,
    /** What each question is about, by name. */
    subject,
    modelsUnavailable,
    /** The models a question may name, with their efforts, once read. */
    offered,
    /** Where answers came from, by ID, for their sources. */
    sourceNames:
      names?.state === "ready"
        ? names.data.sourceNames
        : new Map<string, SourceName>(),
    /** Reads the models again, where core was out of reach or refused. */
    retry:
      models !== undefined && models.state !== "ready" ? readAgain : undefined,
  };
};

export type GlobalChat = ReturnType<typeof useGlobalChatValue>;

const GlobalChatContext = createContext<GlobalChat | null>(null);

/** Grasp's one chat, as the idle bar and the panel show it. */
export const useGlobalChat = (): GlobalChat => {
  const chat = use(GlobalChatContext);
  if (chat === null) {
    throw new Error("useGlobalChat must be used within a GlobalChatProvider.");
  }
  return chat;
};

/**
 * The chat open in front of the person beside or over the page, if any;
 * none while it is closed to its bar, and never outside the chat's provider.
 */
export const useChatOpenBeside = (): string | undefined => {
  const chat = use(GlobalChatContext);
  return chat?.stage.card === true ? chat.chatId : undefined;
};

/** Whether the chat's idle bar stands over the page's foot; never outside the chat's provider. */
export const useChatBarShown = (): boolean =>
  use(GlobalChatContext)?.stage.bar ?? false;

/**
 * Where the chat stands on this page: the chat's own, about the page's
 * subject too; the page's alone outside the chat's provider (a page that
 * couldn't load).
 */
export const useShownPresence = (): ChatPresence => {
  const chat = use(GlobalChatContext);
  const presence = useChatPresence();
  return chat?.presence ?? presence;
};

/**
 * Whether the card's own button may open and close the chat here: where
 * the chat is, and doesn't stay open about the page's subject (on a phone
 * it never does); none outside the chat's provider.
 */
export const useChatToggles = (): boolean => {
  const chat = use(GlobalChatContext);
  return chat !== null && chat.available && !chat.keptOpen;
};

/**
 * Has Grasp's chat be about `subject`, called `name`, while the calling
 * page is open: that subject's chat, in its slot (chat-subject.ts); the
 * person's own again after. None for a page about something the person
 * doesn't build (no subject). Answers that chat, once its slot holds it,
 * and nothing of the chat it showed before: its ID,
 * whether its agent works on it (`running`), or checks it too (`busy`),
 * whether Grasp answered after the Build it that made it (`built`), how
 * often its agent wrote drafts (`worked`), which reads the page again,
 * and what the person calls it, its chat's title, which the plan named.
 */
export const useChatAbout = (subject: Subject | undefined, name: string) => {
  const chat = useGlobalChat();
  const slot = subject === undefined ? undefined : slotOf(subject);
  useEffect(() => {
    if (slot === undefined) {
      return () => {
        // Not about the page's subject: the person's own chat stays.
      };
    }
    showSlot(slot, name);
    return () => {
      showSlot("chat");
    };
  }, [slot, name]);
  const ours = slot !== undefined && chat.slot === slot;
  const running = ours && chat.view.running;
  return {
    chatId: ours ? chat.chatId : undefined,
    running,
    busy: running || (ours && chat.view.checking),
    built:
      ours &&
      subject !== undefined &&
      answeredAfterBuild(chat.view.messages, subject),
    worked: chat.view.worked,
    title: ours ? chat.summary?.title : undefined,
  };
};

/** The key that opens the chat, or closes it: ⌘J, or Ctrl J off a Mac. */
export const chatKey = "j";

/** Holds Grasp's one chat for the shell, and opens or closes it on ⌘J. */
export const GlobalChatProvider = ({ children }: { children: ReactNode }) => {
  const chat = useGlobalChatValue();
  const openHere = useOpenChat();
  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if (!(chat.available && isShortcut(event, chatKey))) {
      return;
    }
    event.preventDefault();
    if (!chat.open) {
      openHere();
    } else if (!chat.keptOpen) {
      closeChat();
    }
  });
  useEffect(() => {
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, []);
  return <GlobalChatContext value={chat}>{children}</GlobalChatContext>;
};
