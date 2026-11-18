import { agentErrors } from "@grasp-os/shared/agent";
import {
  chatFileMaxBytes,
  chatFilesPerQuestionMax,
  chatFileTypeOf,
} from "@grasp-os/shared/chat";
import type { ChatMake, ChatSubject } from "@grasp-os/shared/chat";
import { failureText } from "@grasp-os/shared/errors";
import type { ModelEffort, ModelEfforts } from "@grasp-os/shared/models";
import { useLingui } from "@lingui/react/macro";
import { useRouteContext } from "@tanstack/react-router";
import { useRef, useState } from "react";

import { useCoreReach } from "../frame/page-failed.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { setActiveChat } from "./active-chat.ts";
import type { ChatSlot } from "./active-chat.ts";
import { chatMentionsOf } from "./mentions.tsx";
import type { Mentionable } from "./mentions.tsx";
import {
  readChoice,
  resolveChoice,
  switchModel,
  writeChoice,
} from "./model-choice.ts";
import type { ModelChoice } from "./model-choice.ts";

// Asking in a chat, from the chat page or the chat dock on any other page:
// the box's text, model, effort and files, and asking in the open chat, or
// in a new one named after the question. A question's files are attached to
// its chat as it is sent, one at a time, then the question names them.

/**
 * How long a question may go without core confirming it, in ms. Core
 * confirms one in about 50ms here; this leaves room for a slow network or
 * a cold start before the box says the question wasn't heard.
 */
export const sendDeadlineMs = 10_000;
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

/** No model takes an effort, as before core says which do. */
const noModelEfforts: Readonly<Record<string, ModelEfforts>> = {};

/** Where a question goes when there is no chat yet, and what follows it. */
export interface AskOptions {
  /** Once a question is taken, in the chat it went into. */
  onAsked?: (chatId: string) => void;
  /**
   * What each question is about: the page it is asked on (chat-subject.ts).
   */
  subject?: ChatSubject;
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
}

const noOptions: AskOptions = {};

/** A new chat made for a question that then failed to send. */
export interface UnsentChat {
  id: string;
  question: string;
  /** The agent it was made with; none named: the company's first. */
  agentId: string | undefined;
}

/**
 * The chat asking `question` again goes into: the one made for it when
 * it failed to send, while the same agent is still picked; else none, and
 * a new chat is made with the agent picked now.
 */
export const unsentChatFor = (
  unsent: UnsentChat | null,
  question: string,
  agentId?: string
): string | undefined =>
  unsent?.question === question && unsent.agentId === agentId
    ? unsent.id
    : undefined;

/** What the box says under it about the question: waiting, late, or why it didn't go. */
const questionNote = ({
  waiting,
  late,
  problem,
  words,
}: {
  waiting: boolean;
  late: boolean;
  problem: string | undefined;
  words: { waiting: string; late: string };
}): string | undefined => {
  if (waiting) {
    return words.waiting;
  }
  return late ? words.late : problem;
};

/** Whether `error` is a refusal core named with a code, rather than a dropped connection's own. */
const codedByCore = (error: unknown): boolean =>
  error instanceof Error && "code" in error && typeof error.code === "string";

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
  { onAsked, subject, make, agentId }: AskOptions = noOptions
) => {
  const { identity } = useRouteContext({ from: "/_shell" });
  const { t } = useLingui();
  const { busy, failure, run } = useCoreAction();
  const [text, setText] = useState("");
  // What the person mentioned in the box (`@`), each once: what the
  // question names exactly, beside its words, and the chips the box shows.
  const [mentions, setMentions] = useState<readonly Mentionable[]>([]);
  const [files, setFiles] = useState<readonly BoxFile[]>([]);
  // Why a file the person chose stays out of the box.
  const [fileProblem, setFileProblem] = useState<string>();
  // The last question didn't go: the box says so under it, the words kept.
  const [sendFailed, setSendFailed] = useState(false);
  // Core hasn't confirmed the question on its way within the deadline.
  const [late, setLate] = useState(false);
  // A question on its way, from the press until core confirms it or it
  // fails: while core is out of reach, the box says it waits.
  const [pending, setPending] = useState(false);
  const reach = useCoreReach();
  const waiting = pending && reach !== undefined && reach !== "reachable";
  // Why the last question didn't go: core's own words for a refusal it
  // names; ours for anything else (a dropped connection's raw text).
  const [unsentWhy, setUnsentWhy] = useState<string>();
  // The box's files core already took, by chat: asking again in the same
  // chat names them rather than attaching them twice.
  const attached = useRef(
    new Map<string, { chatId: string; fileId: string }>()
  );
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
  // A new chat made for a question that then failed to send: asking the
  // same question again asks in it, rather than making another.
  // Only for the agent it was made with: picking another one before
  // asking again makes a new chat, with that agent.
  const unsent = useRef<UnsentChat | null>(null);
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
  const ask = async (
    question: string,
    carried: readonly BoxFile[] = [],
    mentioned: readonly Mentionable[] = []
  ): Promise<boolean> => {
    // Already on its way: this press is the same question, not a failure.
    // Once core is late to confirm it, it stays the one on its way: a
    // second would ask it twice, as a send carries no key core could tell
    // a repeat by.
    if (sending.current) {
      return !late;
    }
    sending.current = true;
    setPending(true);
    setLate(false);
    setUnsentWhy(undefined);
    const named = chatMentionsOf(mentioned);
    let created: string | undefined;
    const call = run(
      async (session) => {
        let id = chatId ?? unsentChatFor(unsent.current, question, agentId);
        if (id === undefined) {
          ({ id } = await session.chats.create(
            titleOf(question),
            agentId,
            make
          ));
          created = id;
        }
        const askedIn = id;
        const fileIds: string[] = [];
        for (const { id: boxId, file } of carried) {
          const known = attached.current.get(boxId);
          if (known?.chatId === askedIn) {
            fileIds.push(known.fileId);
            continue;
          }
          // oxlint-disable-next-line no-await-in-loop -- one at a time, in the order they were added
          const bytes = new Uint8Array(await file.arrayBuffer());
          // oxlint-disable-next-line no-await-in-loop -- one at a time, in the order they were added
          const { id: fileId } = await session.chats.attachFile(askedIn, {
            name: file.name,
            bytes,
          });
          attached.current.set(boxId, { chatId: askedIn, fileId });
          fileIds.push(fileId);
        }
        await session.chats.send(askedIn, {
          text: question,
          model,
          ...(effort === undefined ? {} : { effort }),
          ...(fileIds.length === 0 ? {} : { files: fileIds }),
          ...(subject === undefined ? {} : { subject }),
          ...(named.length === 0 ? {} : { mentions: named }),
        });
        return askedIn;
      },
      (reason, error) => {
        setUnsentWhy(
          codedByCore(error)
            ? reason
            : t`Grasp couldn't be reached, so your question wasn't sent. It's kept here: send it again.`
        );
      }
    );
    const settled = async (): Promise<boolean> => {
      const sent = await call;
      sending.current = false;
      setPending(false);
      setLate(false);
      if (sent === undefined) {
        // The box keeps the question and says why it wasn't sent; a new chat
        // made for it waits to be asked in again.
        if (created !== undefined) {
          unsent.current = { id: created, question, agentId };
        }
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
      if (chatId === undefined) {
        setActiveChat(sent, slot);
      }
      onAsked?.(sent);
      return true;
    };
    const outcome = settled();
    // Core confirms a question in well under a second; past the deadline the
    // box says it wasn't heard, the words kept. What core says later still
    // counts: a question it took clears the box as any sent one.
    const deadline = Promise.withResolvers<"late">();
    const timer = window.setTimeout(() => {
      deadline.resolve("late");
    }, sendDeadlineMs);
    const first = await Promise.race([outcome, deadline.promise]);
    window.clearTimeout(timer);
    if (first !== "late") {
      return first;
    }
    setLate(true);
    void (async () => {
      if (await outcome) {
        setSendFailed(false);
      }
    })();
    return false;
  };
  const stop = async (): Promise<void> => {
    if (chatId !== undefined) {
      await run(async (session) => await session.chats.cancel(chatId));
    }
  };
  return {
    composer: {
      text,
      onText: setText,
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
      // Not before core has said which models there are: a question
      // would name none, and core refuses it.
      busy: busy || models === undefined,
      failure: questionNote({
        waiting,
        late,
        problem: unsentWhy ?? failure,
        words: {
          waiting: t`Waiting to send. Grasp is out of reach for now; your question goes once it's back.`,
          late: t`Grasp hasn't confirmed your question yet. It's kept here, and goes once Grasp answers.`,
        },
      }),
      fileProblem,
      files: files.map(({ id, file }) => ({
        id,
        name: file.name,
        bytes: file.size,
      })),
      onAttach: attach,
      onRemoveFile: removeFile,
      // When the question didn't go, the box says so under it (`failure`,
      // why), keeps the text, and Send tries again.
      onSend: async (): Promise<void> => {
        setFileProblem(undefined);
        setSendFailed(!(await ask(text, files, mentions)));
      },
      sendFailed,
      onSendFailedChange: setSendFailed,
      onStop: () => {
        void stop();
      },
    },
    ask,
  };
};
