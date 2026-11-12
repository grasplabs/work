import type { ChatSubject, ChatSubjectKind } from "@grasp-os/shared/chat";
import { chatSubjectKinds } from "@grasp-os/shared/chat";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useEffect, useState } from "react";

import type { Session } from "../core.ts";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCore } from "../use-core.ts";
import { setActiveChat, showSlot, useAfresh } from "./active-chat.ts";
import type { ChatSlot } from "./active-chat.ts";

// What Grasp's one chat is about on a page (global-chat.tsx): by default
// the person's open chat, carried from page to page; on a page about one
// thing, that thing's own chat, as an App's workspace has the chat that
// builds the App and a workflow's page the chat that draws it. A page
// says so (`useChatSubject`); each kind of subject says, here, how core
// finds the person's chat for one, if it keeps one, and what the chat
// says there. The chat is an ordinary one, in the person's list, held in
// a slot of the tab's own (active-chat.ts), so their other chats stay as
// they were. There it stays docked open beside the page: the page is
// where its subject is made, so the chat is part of it, and never closes.
//
// Each question asked there carries the subject to core (`ChatQuestion`),
// which tells the agent, by name, what "this" and "it" mean.
//
//   useChatSubject({ kind: "app", id: app.id }, app.name);

/** What the chat is called and says, on a subject's page. */
export interface ChatSubjectWords {
  title: MessageDescriptor;
  placeholder: MessageDescriptor;
  empty: MessageDescriptor;
}

/** How a kind of subject has its chat. */
interface ChatSubjectKindOf {
  /**
   * The person's chat for subject `id`, as core keeps it, made the first
   * time; none for a kind core keeps no chat for, whose next question in
   * a slot holding none starts one.
   */
  chatOf?: (session: Session, id: string) => Promise<{ id: string }>;
  words: ChatSubjectWords;
}

const kinds: Record<ChatSubjectKind, ChatSubjectKindOf> = {
  app: {
    chatOf: async (session, id) => await session.chats.forApp(id),
    words: {
      title: msg`Ask for a change`,
      placeholder: msg`Say what should change`,
      empty: msg`Say what to change. Only you see the changes until you share them with your team.`,
    },
  },
  workflow: {
    words: {
      title: msg`Ask for a change`,
      placeholder: msg`Say what should change`,
      empty: msg`Say what to change. Only you see the changes, in the Flow: its runs go on as they are until a new version runs for your team.`,
    },
  },
};

/** The tab's slot for `subject`'s chat. */
export const slotOf = ({ kind, id }: ChatSubject): ChatSlot => `${kind}:${id}`;

const isKind = (kind: string): kind is ChatSubjectKind =>
  chatSubjectKinds.some((each) => each === kind);

/** The subject whose chat `slot` holds; none for the person's own. */
export const subjectOf = (slot: ChatSlot): ChatSubject | undefined => {
  if (slot === "chat") {
    return undefined;
  }
  const at = slot.indexOf(":");
  const kind = slot.slice(0, at);
  return isKind(kind) ? { kind, id: slot.slice(at + 1) } : undefined;
};

/** What the chat says about a subject of `kind`. */
export const subjectWords = (kind: ChatSubjectKind): ChatSubjectWords =>
  kinds[kind].words;

/**
 * Has Grasp's chat be about `subject`, called `name`, while the calling
 * page is open: that subject's chat, in its slot; the person's own again
 * after.
 */
export const useChatSubject = (subject: ChatSubject, name: string): void => {
  const slot = slotOf(subject);
  useEffect(() => {
    showSlot(slot, name);
    return () => {
      showSlot("chat");
    };
  }, [slot, name]);
};

/**
 * Asks core for the subject's chat while its slot (`slot`) holds none
 * (`chatId`), and keeps it there: whether it is looking, why not when core
 * gave none, and a way to ask again. Nothing for the person's own slot,
 * one left to start afresh, or a kind core keeps no chat for: its next
 * question starts one.
 */
export const useSubjectChat = (
  slot: ChatSlot,
  chatId: string | undefined
): {
  searching: boolean;
  failure: Loaded<unknown> | undefined;
  retry: () => void;
} => {
  const core = useCore();
  const [failure, setFailure] = useState<{
    slot: ChatSlot;
    read: Loaded<unknown>;
  }>();
  // Asked again (Try again) after core gave no chat.
  const [attempt, setAttempt] = useState(0);
  // Left to start afresh: the next question starts its chat.
  const afresh = useAfresh(slot);
  useEffect(() => {
    const subject = subjectOf(slot);
    const chatOf =
      subject === undefined ? undefined : kinds[subject.kind].chatOf;
    if (
      subject === undefined ||
      chatOf === undefined ||
      chatId !== undefined ||
      afresh
    ) {
      return () => {
        // Nothing asked.
      };
    }
    let live = true;
    const find = async (): Promise<void> => {
      const found = await loadFromCore(
        core,
        async (session) => await chatOf(session, subject.id)
      );
      if (!live) {
        return;
      }
      if (found.state === "ready") {
        setActiveChat(found.data.id, slot);
      } else {
        setFailure({ slot, read: found });
      }
    };
    void find();
    return () => {
      live = false;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `attempt` says when to ask again
  }, [core, slot, chatId, afresh, attempt]);
  const subject = subjectOf(slot);
  const shownFailure =
    failure !== undefined && failure.slot === slot && chatId === undefined
      ? failure.read
      : undefined;
  return {
    searching:
      subject !== undefined &&
      kinds[subject.kind].chatOf !== undefined &&
      chatId === undefined &&
      !afresh &&
      shownFailure === undefined,
    failure: shownFailure,
    retry: () => {
      setFailure(undefined);
      setAttempt(attempt + 1);
    },
  };
};
