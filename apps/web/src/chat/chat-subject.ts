import { subjectKinds } from "@grasp-os/shared/subject";
import type { Subject, SubjectKind } from "@grasp-os/shared/subject";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useEffect, useState } from "react";

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
// finds the person's chat for one, if it has one; what the chat says
// there is the same for both. The chat is an ordinary one, in the person's list, held in
// a slot of the tab's own (active-chat.ts), so their other chats stay as
// they were. There it stays docked open beside the page: the page is
// where its subject is made, so the chat is part of it, and never closes.
//
// Each question asked there carries the subject to core (`ChatQuestion`),
// which tells the agent, by name, what "this" and "it" mean.
//
//   useChatSubject({ kind: "app", id: app.id }, app.name);

/**
 * What the chat is called and says on a subject's page: the same for an
 * App and a workflow, whose draft its builders share until they share
 * it with their team.
 */
export const subjectWords = {
  title: msg`Ask for a change`,
  placeholder: msg`Say what should change`,
  empty: msg`Say what to change. Your team sees the changes once you share them.`,
} satisfies Record<string, MessageDescriptor>;

/** The tab's slot for `subject`'s chat. */
export const slotOf = ({ kind, id }: Subject): ChatSlot => `${kind}:${id}`;

const isKind = (kind: string): kind is SubjectKind =>
  subjectKinds.some((each) => each === kind);

/** The subject whose chat `slot` holds; none for the person's own. */
export const subjectOf = (slot: ChatSlot): Subject | undefined => {
  if (slot === "chat") {
    return undefined;
  }
  const at = slot.indexOf(":");
  const kind = slot.slice(0, at);
  return isKind(kind) ? { kind, id: slot.slice(at + 1) } : undefined;
};

/**
 * Has Grasp's chat be about `subject`, called `name`, while the calling
 * page is open: that subject's chat, in its slot; the person's own again
 * after. None for a page about it that the person doesn't build.
 */
export const useChatSubject = (
  subject: Subject | undefined,
  name: string
): void => {
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
};

/**
 * Asks core for the subject's chat while its slot (`slot`) holds none
 * (`chatId`), and keeps it there: whether it is looking, why not when core
 * couldn't say, and a way to ask again. Nothing for the person's own
 * slot, one left to start afresh, or a subject core has no chat for yet
 * (none worked on it with them): its next question starts one.
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
  // The slot whose subject core has no chat for yet.
  const [none, setNone] = useState<ChatSlot>();
  // Left to start afresh: the next question starts its chat.
  const afresh = useAfresh(slot);
  useEffect(() => {
    const subject = subjectOf(slot);
    if (subject === undefined || chatId !== undefined || afresh) {
      return () => {
        // Nothing asked.
      };
    }
    let live = true;
    const find = async (): Promise<void> => {
      const found = await loadFromCore(
        core,
        async (session) => await session.chats.forSubject(subject)
      );
      if (!live) {
        return;
      }
      if (found.state !== "ready") {
        setFailure({ slot, read: found });
      } else if (found.data === null) {
        setNone(slot);
      } else {
        setActiveChat(found.data.id, slot);
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
      chatId === undefined &&
      !afresh &&
      none !== slot &&
      shownFailure === undefined,
    failure: shownFailure,
    retry: () => {
      setFailure(undefined);
      setAttempt(attempt + 1);
    },
  };
};
