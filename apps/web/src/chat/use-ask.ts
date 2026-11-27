import { agentErrors } from "@grasp-os/shared/agent";
import {
  chatFileMaxBytes,
  chatFilesPerQuestionMax,
  chatFileTypeOf,
} from "@grasp-os/shared/chat";
import type { ChatMake } from "@grasp-os/shared/chat";
import { failureText } from "@grasp-os/shared/errors";
import type { ModelEffort, ModelEfforts } from "@grasp-os/shared/models";
import type { Subject } from "@grasp-os/shared/subject";
import { useRouteContext } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import type { CoreConnection } from "../core-connection.ts";
import { CoreTimeoutError, isConnectionFailure, timeoutMs } from "../core.ts";
import type { Session } from "../core.ts";
import { useCoreAction } from "../use-core-action.ts";
import { useHoldAlive, useHoldHeartbeat } from "../use-core-reach.ts";
import { useCore } from "../use-core.ts";
import { activeChat, setActiveChat } from "./active-chat.ts";
import type { ChatSlot } from "./active-chat.ts";
import { useFollowedChat } from "./chat-watch.ts";
import type { Problem, StopNote } from "./dictation.ts";
import { emptyDraft, moveNewDraft, useDraft } from "./drafts.ts";
import type { BoxMention } from "./mentions.tsx";
import { chatMentionsOf } from "./mentions.tsx";
import {
  readChoice,
  resolveChoice,
  switchModel,
  writeChoice,
} from "./model-choice.ts";
import type { ModelChoice } from "./model-choice.ts";
import {
  clearPending,
  keepMade,
  pendingAt,
  pendingKey,
  setPending,
  taken,
  takesBack,
  useBoxOwner,
  usePending,
} from "./pending-question.ts";
import type { PendingQuestion } from "./pending-question.ts";
import { useReconnecting } from "./reconnecting.ts";

// Asking in a chat, from the chat page or the chat dock on any other page:
// the box's text, model, effort and files, and asking in the open chat, or
// in a new one named after the question. A question's files are attached to
// its chat as it is sent, one at a time, then the question names them.
// What is typed belongs to the chat it was typed in, kept as its draft
// (drafts.ts): once the box is another chat's, it holds that chat's draft,
// never sending one chat's words or files to the next (the chat a
// question here just made takes what was typed meanwhile).

/** A new chat's title: the start of its first question. */
export const titleOf = (question: string): string => {
  const line = question.trim().split("\n")[0] ?? "";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
};

/** A file in the box, waiting for its question, by an ID of the page's own. */
interface BoxFile {
  id: string;
  file: File;
}

/** Why core wouldn't take `file`, as core says it, before it is sent at all. */
const problemOf = (file: File): string | undefined => {
  if (chatFileTypeOf(file.name) === undefined) {
    return failureText(agentErrors.create("agent.file_unsupported"));
  }
  if (file.size > chatFileMaxBytes) {
    return failureText(agentErrors.create("agent.file_too_large"));
  }
  return undefined;
};

/**
 * Where each of the page's box files went, by its ID in the box: a send
 * that failed after core took one names it again in the same chat, from
 * whichever box asks again.
 */
const attachedFiles = new Map<string, { chatId: string; fileId: string }>();

/** Whether `error` is the connection breaking, not core's answer nor the browser's. */
const broke = (error: unknown): boolean =>
  isConnectionFailure(error) && !(error instanceof DOMException);

/**
 * `asking`, asked once more on the next connection when the one it went
 * on broke, or was let go of as dead (`CoreConnection.keepAlive`), which
 * may have been wrong: with the same key, core takes it once either way,
 * so a reconnect costs the person nothing. Broken again, it says Grasp
 * can't be reached: a socket's own words ("Peer closed WebSocket") are
 * nobody's to read. A file the browser couldn't read (moved since it was
 * added) says so itself.
 */
const reaching =
  <T>(
    core: Pick<CoreConnection, "withSession">,
    asking: (session: Session) => Promise<T>
  ) =>
  async (session: Session): Promise<T> => {
    try {
      return await asking(session);
    } catch (error) {
      if (!broke(error)) {
        throw error;
      }
    }
    try {
      return await core.withSession(asking);
    } catch (error) {
      throw broke(error) ? new CoreTimeoutError(timeoutMs) : error;
    }
  };

/** Where each of the box's files went, by its ID in the box. */
type Attached = typeof attachedFiles;

/**
 * Attaches the box's files `carried` to `chatId`, one at a time in the
 * order they were added, and answers their IDs there; one core took for
 * that chat already (a send that failed after it) is named again, not
 * sent twice. Each file is one large message, which a ping waits behind:
 * the heartbeat holds off while they go (`hold`), or a slow upload would
 * read as a dead connection.
 */
const attachAll = async (
  session: Session,
  chatId: string,
  carried: readonly BoxFile[],
  attached: Attached,
  hold: () => () => void
): Promise<string[]> => {
  const fileIds: string[] = [];
  const letGo = carried.length > 0 ? hold() : undefined;
  try {
    for (const { id: boxId, file } of carried) {
      const known = attached.get(boxId);
      if (known?.chatId === chatId) {
        fileIds.push(known.fileId);
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- one at a time, in the order they were added
      const bytes = new Uint8Array(await file.arrayBuffer());
      // oxlint-disable-next-line no-await-in-loop -- one at a time, in the order they were added
      const { id: fileId } = await session.chats.attachFile(chatId, {
        name: file.name,
        bytes,
      });
      attached.set(boxId, { chatId, fileId });
      fileIds.push(fileId);
    }
  } finally {
    letGo?.();
  }
  return fileIds;
};

/** No model takes an effort, as before core says which do. */
const noModelEfforts: Readonly<Record<string, ModelEfforts>> = {};

/** Where a question goes when there is no chat yet, and what follows it. */
export interface AskOptions {
  /**
   * Once the chat a question goes into is there, made for it or not, as
   * the question goes on its way: its page may open at once, and shows it.
   */
  onChat?: (chatId: string) => void;
  /**
   * What each question is about: the page it is asked on (chat-subject.ts).
   */
  subject?: Subject;
  /**
   * What "Make something" started the new chat to make (`ChatMake`),
   * which the chat keeps: the first question makes the chat with it.
   */
  make?: ChatMake;
  /**
   * The agent a new chat named after the question is with, one of
   * `chats.agents()`; the company's first one by default.
   */
  agentId?: string;
  /**
   * Whose draft a box with no chat yet keeps (drafts.ts): the slot's
   * next chat's unless given, as a start with a purpose of its own has
   * (Make something, an agent's Chat, an opportunity's brief), so what it
   * fills in never takes the place of the person's own.
   */
  draft?: string;
}

const noOptions: AskOptions = {};

/** A question that failed to send, and the key it went with. */
export interface Unsent {
  key: string;
  /** Its words. */
  question: string;
  /**
   * All it was asked with ({@link askedWith}); none for one this box took
   * back from another (Chat's start, gone once it opened the chat): then
   * its words alone say it is the same question.
   */
  asked: string | undefined;
}

/**
 * All a question is asked with, as one text: its words, the chat (or the
 * agent a new one is made with), the model and effort, its files, what it
 * mentions, and what it is about. Two asks with the same are the same
 * question.
 */
export const askedWith = (asked: {
  question: string;
  chatId: string | undefined;
  agentId: string | undefined;
  model: string | undefined;
  effort: string | undefined;
  files: readonly string[];
  mentions: readonly unknown[];
  subject: unknown;
}): string => JSON.stringify(asked);

/**
 * The key a question goes with (`ChatQuestion.key`): the one it failed to
 * send with when it is asked again with all the same (`asked`), so core
 * takes it once however often it is asked again, and answers the chat a
 * first try made, which may have reached core with only its answer lost on
 * the way; else a new one. Anything changed (another file, model, agent,
 * chat) makes it a new question, which core takes as one.
 */
export const questionKeyFor = (
  unsent: Unsent | null,
  question: string,
  asked: string
): string =>
  unsent !== null &&
  (unsent.asked === undefined
    ? unsent.question === question
    : unsent.asked === asked)
    ? unsent.key
    : crypto.randomUUID();

/**
 * What the box to ask in needs: the text, model and effort, and asking in
 * `chatId`, or in a new chat named after the question.
 */
export const useAsk = (
  chatId: string | undefined,
  /** The models a question may name, once core has said which. */
  models: readonly string[] | undefined,
  /** The efforts each of `models` takes (`chats.efforts()`). */
  efforts: Readonly<Record<string, ModelEfforts>> = noModelEfforts,
  /** Which of the tab's open chats a new chat becomes. */
  slot: ChatSlot = "chat",
  { onChat, subject, make, agentId, draft: drafting }: AskOptions = noOptions
) => {
  const { identity } = useRouteContext({ from: "/_shell" });
  const core = useCore();
  const { busy, failure, run } = useCoreAction();
  const holdHeartbeat = useHoldHeartbeat();
  const holdAlive = useHoldAlive();
  const draftScope = drafting ?? slot;
  const [draft, changeDraft] = useDraft(identity.userId, chatId, draftScope);
  const { text, mentions } = draft;
  // Why dictating into the text stopped on its own, kept with it: the box
  // it stopped in may have gone (dictation.ts).
  const [stopped, setStopped] = useState<Problem>();
  const stopNote: StopNote = [stopped, setStopped];
  // What the person mentioned in the box (`@`), each once, is the draft's
  // too: what the question names exactly, beside its words, and the chips
  // the box shows.
  const [files, setFiles] = useState<readonly BoxFile[]>([]);
  // Why a file the person chose stays out of the box.
  const [fileProblem, setFileProblem] = useState<string>();
  // Why the question the box took back didn't go, until the next is sent.
  const [returnedWhy, setReturnedWhy] = useState<string>();
  // The chat what is typed belongs to, and the chat a question asked here
  // made: the box is that one's still once it opens.
  const [draftOf, setDraftOf] = useState(chatId);
  // The chat the box is now, for what comes back after an await.
  const boxOf = useRef(chatId);
  useEffect(() => {
    boxOf.current = chatId;
  }, [chatId]);
  const [made, setMade] = useState<string>();
  // Which box the draft is in: another once the box shows another chat's
  // draft, the same when a question made the chat it shows from its own.
  const [box, setBox] = useState(0);
  if (chatId !== draftOf) {
    setDraftOf(chatId);
    if (chatId === undefined || chatId !== made) {
      setBox(box + 1);
      setFiles([]);
      setFileProblem(undefined);
      setStopped(undefined);
      setReturnedWhy(undefined);
    }
  }
  // A question that failed to send: asked again, it goes with the same
  // key, so a chat made for it, or the question itself, is never made
  // twice (`questionKeyFor`).
  const unsent = useRef<Unsent | null>(null);
  // The question on its way here (pending-question.ts), and the box's own
  // ID, which only it takes back.
  const owner = useBoxOwner();
  const pendingHere = pendingKey(chatId, slot);
  const here = usePending(pendingHere);
  const { messages, loaded, queued, running } = useFollowedChat(chatId).view;
  const reconnecting = useReconnecting(busy || running);
  // A question from the box that failed to send comes back into it, which
  // says why: the box that sent it, or, once that one is gone (Chat's
  // start, after it opened the chat's page), the one that shows its chat.
  // Before what was typed since, never in place of it.
  const [takenBack, setTakenBack] = useState<PendingQuestion>();
  if (takesBack(here, owner) && here !== takenBack) {
    setTakenBack(here);
    setReturnedWhy(here.state.failed);
    // At most as many as a question carries, its own first: any over that
    // stay out, and the box says so.
    const back = [...here.files, ...files];
    setFiles(back.slice(0, chatFilesPerQuestionMax));
    if (back.length > chatFilesPerQuestionMax) {
      setFileProblem(failureText(agentErrors.create("agent.too_many_files")));
    }
  }
  // Taken back, or core's copy in the thread: it is no longer on its way.
  // Taken back, its key is this box's to send it again with, so core
  // takes it once even if the first try reached it.
  useEffect(() => {
    if (here === undefined) {
      return;
    }
    if (takesBack(here, owner)) {
      unsent.current = { key: here.key, question: here.text, asked: undefined };
      // Its words and what they mention, into the draft.
      changeDraft((now) => ({
        text: now.text === "" ? here.text : `${here.text}\n\n${now.text}`,
        mentions: [
          ...here.mentions,
          ...now.mentions.filter(
            (each) =>
              !here.mentions.some(
                ({ kind, id }) => kind === each.kind && id === each.id
              )
          ),
        ],
      }));
      clearPending(pendingHere, here);
    } else if (here.state === "sent" && taken(here, messages, queued)) {
      clearPending(pendingHere, here);
    }
  }, [here, owner, messages, queued, pendingHere, changeDraft]);
  // Another box's question on its way into this chat (Chat's start, which
  // opened it): this one waits for it, so the two never pass each other.
  const otherOnItsWay = here?.state === "sending" && here.owner !== owner;
  // The box's files core already took, by chat: asking again in the same
  // chat names them rather than attaching them twice.
  const attached = attachedFiles;
  // The person's last choice in this browser, against what core offers
  // now: until they make one, the default model at its default effort.
  const [choice, setChoice] = useState<ModelChoice>(() =>
    readChoice(identity.userId)
  );
  const shown = resolveChoice(models ?? [], efforts, choice);
  const { model, effort, levels } = shown;
  const choose = (chosen: ModelChoice): void => {
    setChoice(chosen);
    writeChoice(identity.userId, chosen);
  };
  // One question at a time: a second click on Send or Try again while one
  // is on its way would ask it twice. A ref, as `busy` is only seen on the
  // next render.
  const sending = useRef(false);
  const attach = (chosen: readonly File[]): void => {
    const problems = chosen.flatMap((file) => problemOf(file) ?? []);
    const added = chosen
      .filter((file) => problemOf(file) === undefined)
      .map((file) => ({ id: crypto.randomUUID(), file }));
    const room = chatFilesPerQuestionMax - files.length;
    setFiles([...files, ...added.slice(0, Math.max(0, room))]);
    setFileProblem(
      added.length > room
        ? failureText(agentErrors.create("agent.too_many_files"))
        : problems[0]
    );
  };
  const removeFile = (id: string): void => {
    // Not while the question is on its way: its files are being attached
    // and named, so one taken out now would still be sent.
    if (sending.current) {
      return;
    }
    setFiles((now) => now.filter((each) => each.id !== id));
    // Core took it already (a send that failed after it): removed there
    // too, so it holds none of the chat's places for files.
    const known = attached.get(id);
    attached.delete(id);
    setFileProblem(undefined);
    if (known !== undefined) {
      void run(async (session) => {
        await session.chats.removeFile(known.chatId, known.fileId);
      });
    }
  };
  /**
   * Asks `question`: true once core took it, false when it was not sent.
   * From the box (`fromBox`), a question that fails goes back into it.
   */
  const ask = async (
    question: string,
    carried: readonly BoxFile[] = [],
    mentioned: readonly BoxMention[] = [],
    fromBox = false
  ): Promise<boolean> => {
    if (sending.current || otherOnItsWay) {
      return false;
    }
    sending.current = true;
    setReturnedWhy(undefined);
    const named = chatMentionsOf(mentioned);
    // A new chat starts with the agent picked, else the first one the
    // question mentions: the first agent, paused, never stops it.
    const startWith = agentId ?? named.find(({ kind }) => kind === "agent")?.id;
    // The same question goes with the same key (`questionKeyFor`).
    const askedAs = askedWith({
      question,
      chatId,
      agentId: startWith,
      model,
      effort,
      files: carried.map(({ id }) => id),
      mentions: named,
      subject,
    });
    const key = questionKeyFor(unsent.current, question, askedAs);
    // The thread shows the question at once, and the box lets go of it.
    const asked: PendingQuestion = {
      text: question,
      mentions: mentioned,
      files: carried,
      after:
        chatId === undefined || loaded ? (messages.at(-1)?.id ?? 0) : undefined,
      at: new Date().toISOString(),
      queues: running,
      key,
      owner,
      fromBox,
      state: "sending",
    };
    let pendingIn = pendingKey(chatId, slot);
    setPending(pendingIn, asked);
    if (fromBox) {
      // Clears the box only of what was sent from it: asking again sends
      // an earlier question, and a draft the person started stays.
      changeDraft((now) => (now.text === question ? emptyDraft : now));
      setFiles((now) => now.filter((each) => !carried.includes(each)));
    }
    const asking = async (session: Session): Promise<string> => {
      let id = chatId;
      if (id === undefined) {
        const chat = await session.chats.create(
          titleOf(question),
          startWith,
          make,
          key
        );
        // Its page, if it opens at once, opens with what core said.
        if (onChat !== undefined) {
          keepMade(chat);
        }
        ({ id } = chat);
      }
      // The chat is there (asked again on a new connection, already so):
      // the question shows in it as it goes on, and it is the open one,
      // unless another was opened meanwhile.
      if (chatId === undefined && pendingIn !== id) {
        clearPending(pendingIn, asked);
        pendingIn = id;
        setPending(pendingIn, asked);
        // The box is the chat's still once it opens.
        setMade(id);
        // It takes what was typed for the next chat while it went.
        moveNewDraft(identity.userId, draftScope, id);
        if (activeChat(slot) === undefined) {
          setActiveChat(id, slot);
        }
        onChat?.(id);
      }
      const askedIn = id;
      const fileIds = await attachAll(
        session,
        askedIn,
        carried,
        attached,
        holdHeartbeat
      );
      await session.chats.send(askedIn, {
        text: question,
        model,
        ...(effort === undefined ? {} : { effort }),
        ...(fileIds.length === 0 ? {} : { files: fileIds }),
        ...(subject === undefined ? {} : { subject }),
        ...(named.length === 0 ? {} : { mentions: named }),
        key,
      });
      return askedIn;
    };
    // Why it failed, kept with the question for whichever box takes it back.
    let why: string | undefined;
    // Checked for as long as it is on its way, whatever box shows it then:
    // Chat's start goes as the chat's page opens.
    const letGo = holdAlive();
    const sent = await run(
      reaching(core, asking),
      fromBox
        ? (reason) => {
            why = reason;
          }
        : undefined
    );
    letGo();
    sending.current = false;
    if (sent === undefined) {
      // From the box, the question leaves the thread and goes back into a
      // box, which says why it wasn't sent; asked for the person, it only
      // leaves the thread, and this box says why. A new chat made for it
      // goes with the same key when asked again.
      if (why === undefined) {
        clearPending(pendingIn, asked);
      } else {
        setPending(pendingIn, { ...asked, state: { failed: why } });
      }
      unsent.current = { key, question, asked: askedAs };
      return false;
    }
    unsent.current = null;
    for (const { id } of carried) {
      attached.delete(id);
    }
    // Taken: drawn until core's copy is in the thread.
    if (pendingAt(pendingIn) === asked) {
      setPending(pendingIn, { ...asked, state: "sent" });
    }
    return true;
  };
  // A stop drops what was queued behind the answer (core's `cancel` says
  // which): it comes back into the box, the oldest first and before what
  // is typed there, as Codex hands queued messages back on an interrupt,
  // to send again or let go. Only while the box is still that chat's.
  const stop = async (id: string): Promise<void> => {
    const ended = await run(async (session) => await session.chats.cancel(id));
    if (
      ended === undefined ||
      ended === false ||
      ended.dropped.length === 0 ||
      boxOf.current !== id
    ) {
      return;
    }
    const { dropped } = ended;
    changeDraft((now) => ({
      ...now,
      text: [...dropped, now.text]
        .filter((each) => each.trim() !== "")
        .join("\n\n"),
    }));
  };
  /** Has the agent take the questions queued behind its answer at once. */
  const sendNow = async (id: string): Promise<void> => {
    await run(async (session) => {
      await session.chats.sendNow(id);
    });
  };
  return {
    composer: {
      text,
      onText: (typed: string) => {
        changeDraft((now) => ({ ...now, text: typed }));
        // Changed since it failed to send: whatever is sent next is a new
        // question, even in the same words.
        if (unsent.current !== null && typed !== unsent.current.question) {
          unsent.current = null;
        }
      },
      stopNote,
      mentions,
      onMentions: (named: readonly BoxMention[]) => {
        changeDraft((now) => ({ ...now, mentions: named }));
      },
      models,
      model,
      onModel: (chosen: string) => {
        choose(switchModel(efforts, shown, chosen));
      },
      efforts: levels,
      effort,
      onEffort: (chosen: ModelEffort) => {
        choose({ model, effort: chosen });
      },
      busy: busy || otherOnItsWay,
      failure: fileProblem ?? failure ?? returnedWhy,
      reconnecting,
      files: files.map(({ id, file }) => ({
        id,
        name: file.name,
        bytes: file.size,
      })),
      onAttach: attach,
      onRemoveFile: removeFile,
      onSend: () => {
        setFileProblem(undefined);
        void ask(text, files, mentions, true);
      },
      // Only in a chat: before there is one, nothing is answered to stop.
      ...(chatId === undefined
        ? {}
        : {
            onStop: () => {
              void stop(chatId);
            },
          }),
    },
    ask,
    /**
     * Changes when the box shows another chat's draft, not when a question
     * made the chat it shows: the box's editor starts afresh with it.
     */
    box,
    sendNow,
  };
};
