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

import { CoreTimeoutError, isConnectionFailure, timeoutMs } from "../core.ts";
import type { Session } from "../core.ts";
import { useCoreAction } from "../use-core-action.ts";
import { useHoldHeartbeat } from "../use-core-reach.ts";
import { activeChat, setActiveChat } from "./active-chat.ts";
import type { ChatSlot } from "./active-chat.ts";
import type { Problem, StopNote } from "./dictation.ts";
import type { BoxMention } from "./mentions.tsx";
import { chatMentionsOf } from "./mentions.tsx";
import {
  readChoice,
  resolveChoice,
  switchModel,
  writeChoice,
} from "./model-choice.ts";
import type { ModelChoice } from "./model-choice.ts";
import { useReconnecting } from "./reconnecting.ts";

// Asking in a chat, from the chat page or the chat dock on any other page:
// the box's text, model, effort and files, and asking in the open chat, or
// in a new one named after the question. A question's files are attached to
// its chat as it is sent, one at a time, then the question names them.
// What is typed belongs to the chat it was typed in: once the box is
// another chat's, it starts empty, never sending one chat's words or files
// to the next (the chat a question here just made is the same draft's).

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
 * `asking`, where a connection that broke on the way says Grasp can't be
 * reached: a socket's own words ("Peer closed WebSocket") are nobody's to
 * read, and whether the question got there is core's to say once it is
 * back (its key, `questionKeyFor`). A file the browser couldn't read (moved
 * since it was added) says so itself.
 */
const reaching =
  <T>(asking: (session: Session) => Promise<T>) =>
  async (session: Session): Promise<T> => {
    try {
      return await asking(session);
    } catch (error) {
      throw isConnectionFailure(error) && !(error instanceof DOMException)
        ? new CoreTimeoutError(timeoutMs)
        : error;
    }
  };

/** Where each of the box's files went, by its ID in the box. */
type Attached = Map<string, { chatId: string; fileId: string }>;

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
  /** Once a question is taken, in the chat it went into. */
  onAsked?: (chatId: string) => void;
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
  /** Whether Grasp answers in the chat now: the connection is kept checked. */
  running?: boolean;
}

const noOptions: AskOptions = {};

/** A question that failed to send, and the key it went with. */
export interface Unsent {
  key: string;
  /** Its words. */
  question: string;
  /** All it was asked with ({@link askedWith}). */
  asked: string;
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
export const questionKeyFor = (unsent: Unsent | null, asked: string): string =>
  unsent?.asked === asked ? unsent.key : crypto.randomUUID();

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
  { onAsked, subject, make, agentId, running = false }: AskOptions = noOptions
) => {
  const { identity } = useRouteContext({ from: "/_shell" });
  const { busy, failure, run } = useCoreAction();
  const reconnecting = useReconnecting(busy || running);
  const holdHeartbeat = useHoldHeartbeat();
  const [text, setText] = useState("");
  // Why dictating into the text stopped on its own, kept with it: the box
  // it stopped in may have gone (dictation.ts).
  const [stopped, setStopped] = useState<Problem>();
  const stopNote: StopNote = [stopped, setStopped];
  // What the person mentioned in the box (`@`), each once: what the
  // question names exactly, beside its words, and the chips the box shows.
  const [mentions, setMentions] = useState<readonly BoxMention[]>([]);
  const [files, setFiles] = useState<readonly BoxFile[]>([]);
  // Why a file the person chose stays out of the box.
  const [fileProblem, setFileProblem] = useState<string>();
  // The chat what is typed belongs to, and the chat a question asked here
  // made: the box is that one's still once it opens.
  const [draftOf, setDraftOf] = useState(chatId);
  // The chat the box is now, for what comes back after an await.
  const boxOf = useRef(chatId);
  useEffect(() => {
    boxOf.current = chatId;
  }, [chatId]);
  const [made, setMade] = useState<string>();
  if (chatId !== draftOf) {
    setDraftOf(chatId);
    if (chatId === undefined || chatId !== made) {
      setText("");
      setMentions([]);
      setFiles([]);
      setFileProblem(undefined);
      setStopped(undefined);
    }
  }
  // The box's files core already took, by chat: asking again in the same
  // chat names them rather than attaching them twice.
  const attached = useRef<Attached>(new Map());
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
  // A question that failed to send: asked again, it goes with the same
  // key, so a chat made for it, or the question itself, is never made
  // twice (`questionKeyFor`).
  const unsent = useRef<Unsent | null>(null);
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
    const known = attached.current.get(id);
    attached.current.delete(id);
    setFileProblem(undefined);
    if (known !== undefined) {
      void run(async (session) => {
        await session.chats.removeFile(known.chatId, known.fileId);
      });
    }
  };
  /** Asks `question`: true once core took it, false when it was not sent. */
  const ask = async (
    question: string,
    carried: readonly BoxFile[] = [],
    mentioned: readonly BoxMention[] = []
  ): Promise<boolean> => {
    if (sending.current) {
      return false;
    }
    sending.current = true;
    const named = chatMentionsOf(mentioned);
    // A new chat starts with the agent picked, else the first one the
    // question mentions: the first agent, paused, never stops it.
    const startWith = agentId ?? named.find(({ kind }) => kind === "agent")?.id;
    const asked = askedWith({
      question,
      chatId,
      agentId: startWith,
      model,
      effort,
      files: carried.map(({ id }) => id),
      mentions: named,
      subject,
    });
    const key = questionKeyFor(unsent.current, asked);
    const asking = async (session: Session): Promise<string> => {
      let id = chatId;
      if (id === undefined) {
        ({ id } = await session.chats.create(
          titleOf(question),
          startWith,
          make,
          key
        ));
      }
      const askedIn = id;
      const fileIds = await attachAll(
        session,
        askedIn,
        carried,
        attached.current,
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
    const sent = await run(reaching(asking));
    sending.current = false;
    if (sent === undefined) {
      // The box keeps the question and says why it wasn't sent.
      unsent.current = { key, question, asked };
      return false;
    }
    unsent.current = null;
    // Clears the box only of what was sent from it: asking again sends an
    // earlier question, and a draft the person started stays.
    setText((now) => (now === question ? "" : now));
    if (mentioned.length > 0) {
      setMentions([]);
    }
    setFiles((now) => now.filter((each) => !carried.includes(each)));
    for (const { id } of carried) {
      attached.current.delete(id);
    }
    setMade(sent);
    // The chat it made is the open one, unless another was opened while it
    // was on its way: an answer that late selects nothing.
    if (chatId === undefined && activeChat(slot) === undefined) {
      setActiveChat(sent, slot);
    }
    onAsked?.(sent);
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
    setText((now) =>
      [...dropped, now].filter((each) => each.trim() !== "").join("\n\n")
    );
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
        setText(typed);
        // Changed since it failed to send: whatever is sent next is a new
        // question, even in the same words.
        if (unsent.current !== null && typed !== unsent.current.question) {
          unsent.current = null;
        }
      },
      stopNote,
      mentions,
      onMentions: setMentions,
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
      busy,
      failure: fileProblem ?? failure,
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
        void ask(text, files, mentions);
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
    sendNow,
  };
};
