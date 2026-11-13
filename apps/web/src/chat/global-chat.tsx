import type { ChatAgent } from "@grasp-os/shared/chat";
import type { ModelEfforts } from "@grasp-os/shared/models";
import type { Subject } from "@grasp-os/shared/subject";
import { useIsMobile } from "@grasp-os/ui/hooks/use-mobile";
import { useLingui } from "@lingui/react/macro";
import { useLocation, useRouteContext } from "@tanstack/react-router";
import { createContext, use, useEffect, useEffectEvent, useRef } from "react";
import type { ReactNode } from "react";

import type { CoreConnection } from "../core-connection.ts";
import type { Session } from "../core.ts";
import { useFrameRead } from "../frame/frame-read.ts";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { isShortcut } from "../shortcuts.ts";
import {
  setActiveChat,
  useActiveChat,
  useShownName,
  useShownSlot,
} from "./active-chat.ts";
import type { ChatSlot } from "./active-chat.ts";
import { pendingAsk } from "./asked-questions.tsx";
import { answeredAfterBuild } from "./build-answered.ts";
import { useChatBuilds } from "./builds.tsx";
import { readChatNames, useChatSummary } from "./chat-details.ts";
import { closeChat, exitFullscreen, useChatLayout } from "./chat-layout.ts";
import {
  allows,
  chatPresence,
  placementOn,
  useChatPresence,
  useOpenChat,
} from "./chat-presence.ts";
import type { ChatPresence } from "./chat-presence.ts";
import { stageOf, useChatStage } from "./chat-stage.ts";
import {
  slotOf,
  subjectOf,
  subjectWords,
  useSubjectChat,
} from "./chat-subject.ts";
import { useFollowedChat } from "./chat-watch.ts";
import type { SourceName } from "./sources.tsx";
import { useAsk } from "./use-ask.ts";

// Grasp's one chat, on every page: the person's open chat
// (active-chat.ts), so what is asked anywhere goes on there and shows in
// their list, as on Chat. Closed, it is an idle bar at the foot of the page
// (chat-bar.tsx); open, a panel docked beside the page or floating over it
// (chat-panel.tsx, laid out by chat-layout.ts, shown step by step by
// chat-stage.ts). The chat and what is typed
// in its box are held here, once, for the whole shell, so they stay as the
// chat opens, closes or moves, and as the person moves between pages.
//
// Where it may show is each page's to say (chat-presence.ts): on Chat's
// own page only full screen, with no idle bar, as the page is where to
// ask; none for Grasp staff who reach the onboarding alone: core refuses
// them chats. What it is about is each page's to say too
// (chat-subject.ts): an App's workspace has the chat that builds the App,
// a workflow's page the one that draws it, docked beside them.

/**
 * The models a question may name, and the efforts each takes, and the
 * company's agents the person may talk to, the first one first.
 */
export interface Offered {
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
export interface ChatWords {
  title: string;
  placeholder: string;
  empty: string;
}

/**
 * Where the chat may show on this page (chat-presence.ts): nowhere for
 * Grasp staff who reach the onboarding alone, whom core refuses chats;
 * docked beside a page about a subject (chat-subject.ts), as part of it,
 * whatever its route says for anyone who isn't building there.
 */
const usePresenceHere = (): ChatPresence => {
  const { identity } = useRouteContext({ from: "/_shell" });
  const presence = useChatPresence();
  const about = subjectOf(useShownSlot());
  if (identity.onboardingOnly === true) {
    return chatPresence.hidden;
  }
  return about === undefined ? presence : chatPresence.docked;
};

/**
 * What the chat says: about the page's subject, what that subject's kind
 * says (chat-subject.ts); anywhere else, Grasp's own words.
 */
const useChatWords = (): ChatWords => {
  const { t, i18n } = useLingui();
  const subject = subjectOf(useShownSlot());
  if (subject !== undefined) {
    const { title, placeholder, empty } = subjectWords;
    return {
      title: i18n._(title),
      placeholder: i18n._(placeholder),
      empty: i18n._(empty),
    };
  }
  const title = t`Ask Grasp`;
  return {
    title,
    placeholder: title,
    empty: t`Ask anything, or describe a process`,
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
  const presence = usePresenceHere();
  const available = presence.placements.length > 0;
  // Read once for every page, not again as the person moves between them.
  const { value: models, readAgain } = useFrameRead(readModels, available);
  const modelsUnavailable = useModelsUnavailable(models);
  const offered = models?.state === "ready" ? models.data : undefined;
  const words = useChatWords();
  // The open chat of what this page is about (chat-subject.ts), or the
  // person's own; a subject's found from core while it has none.
  const slot = useShownSlot();
  const chatId = useActiveChat(slot);
  const finding = useSubjectChat(slot, chatId);
  const { view, failure, gone } = useFollowedChat(chatId);
  // Core has no such chat (deleted, or not the person's): the next question
  // starts one, and a subject's is found again.
  useEffect(() => {
    if (chatId !== undefined && gone === true) {
      setActiveChat(undefined, slot);
    }
  }, [chatId, gone, slot]);
  // What each question is about: the page's subject, on the box's bar.
  const subject = useQuestionSubject(slot);
  const { composer, ask } = useAsk(
    chatId,
    offered?.models,
    offered?.efforts,
    slot,
    subject.about === undefined ? undefined : { subject: subject.about }
  );
  const builds = useChatBuilds(chatId, view.running, view.worked);
  // Before anything is asked: a chat not made yet, or one made empty.
  const empty =
    chatId === undefined || (view.loaded && view.messages.length === 0);
  // The questions the chat's agent asked last, answered in the person's
  // next message.
  const asking = pendingAsk(view.messages, view.running);
  const layout = useChatLayout();
  const roomBeside = !useIsMobile();
  // About the page's subject, it stays open (chat-subject.ts), where the
  // page has it: that page is where its subject is made. Elsewhere, open
  // where it was put, where this page allows it there; elsewhere it stays
  // open, and shows again on a page that does.
  const keptOpen = subjectOf(slot) !== undefined;
  const placement = keptOpen
    ? (placementOn(presence, layout.placement) ?? layout.placement)
    : layout.placement;
  const open = (keptOpen || layout.open) && allows(presence, placement);
  const { stage, delays, settled } = useChatStage(
    stageOf({
      available,
      open,
      placement,
      roomBeside,
      barHere: presence.bar,
    })
  );
  const { value: names } = useFrameRead(readChatNames, available);
  const { summary, retitle } = useChatSummary(chatId, view.running);
  return {
    /** Where the chat may show on this page, and whether its bar does. */
    presence,
    /** Whether the chat is on this page at all. */
    available,
    /** Whether it is open here: where it was put, if this page allows that. */
    open,
    /** Whether it stays open here, about the page's subject: no closing it. */
    keptOpen,
    /** Where it opens, or is. */
    placement,
    /** What of it shows now, on its way to the layout. */
    stage,
    /** Which parts move a beat after the other, in this step. */
    delays,
    /** For each part that shows it, once it has finished moving. */
    settled,
    words,
    /** The tab's slot the chat is in: a subject's (chat-subject.ts), or the person's. */
    slot,
    chatId,
    /** While a subject's chat is found: why core gave none, and asking again. */
    finding,
    /** What each question is about, by name. */
    subject,
    view,
    /** The Apps its agent builds, read as it writes them. */
    builds,
    failure,
    empty,
    composer,
    ask,
    modelsUnavailable,
    /** The models a question may name, with their efforts, once read. */
    offered,
    /** The open chat's summary: its title, once core has said it. */
    summary,
    /** Shows a new name the person gave the open chat at once. */
    retitle,
    /** Where answers came from, by ID, for their sources. */
    sourceNames:
      names?.state === "ready"
        ? names.data.sourceNames
        : new Map<string, SourceName>(),
    /** Reads the models again, where core was out of reach or refused. */
    retry:
      models !== undefined && models.state !== "ready" ? readAgain : undefined,
    /** The questions the chat's agent asked last, in the box's place. */
    asking,
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
 * Grasp's chat about `subject` on its page, once its slot holds it
 * (chat-subject.ts), and nothing of the chat it showed before (none for no
 * subject: a page about something the person doesn't build): its ID,
 * whether its agent works on it (`running`), or checks it too (`busy`),
 * whether Grasp answered after the Build it that made it (`built`), how
 * often its agent wrote drafts (`worked`), which reads the page again,
 * and what the person calls it, its chat's title, which the plan named.
 */
export const useChatAbout = (subject: Subject | undefined) => {
  const chat = useGlobalChat();
  const ours = subject !== undefined && chat.slot === slotOf(subject);
  const running = ours && chat.view.running;
  return {
    chatId: ours ? chat.chatId : undefined,
    running,
    busy: running || (ours && chat.view.checking),
    built: ours && answeredAfterBuild(chat.view.messages, subject),
    worked: chat.view.worked,
    title: ours ? chat.summary?.title : undefined,
  };
};

/** The key that opens the chat, or closes it: ⌘J, or Ctrl J off a Mac. */
export const chatKey = "j";

/**
 * Holds Grasp's one chat for the shell, opens or closes it on ⌘J, and takes
 * it back beside the page from full screen as the person goes to another.
 */
export const GlobalChatProvider = ({ children }: { children: ReactNode }) => {
  const chat = useGlobalChatValue();
  const openHere = useOpenChat();
  const { pathname } = useLocation();
  const shownPath = useRef(pathname);
  useEffect(() => {
    if (pathname !== shownPath.current) {
      shownPath.current = pathname;
      exitFullscreen();
    }
  }, [pathname]);
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
