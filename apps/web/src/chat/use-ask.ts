import { agentErrors } from "@grasp-os/shared/agent";
import {
  chatFileMaxBytes,
  chatFilesPerQuestionMax,
  chatFileTypeOf,
} from "@grasp-os/shared/chat";
import { failureText } from "@grasp-os/shared/errors";
import type { ModelEffort, ModelEfforts } from "@grasp-os/shared/models";
import {
  useNavigate,
  useRouteContext,
  useRouter,
} from "@tanstack/react-router";
import { useRef, useState } from "react";

import { useCoreAction } from "../use-core-action.ts";
import { setActiveChat } from "./active-chat.ts";
import type { ChatSlot } from "./active-chat.ts";
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

/** A new chat's title: the start of its first question. */
const titleOf = (question: string): string => {
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

/**
 * What the box to ask in needs: the text, model and effort, and asking in
 * `chatId`, or in a new chat named after the question.
 */
export const useAsk = (
  chatId: string | undefined,
  models: readonly string[],
  /** The efforts each of `models` takes (`chats.efforts()`). */
  efforts: Readonly<Record<string, ModelEfforts>> = noModelEfforts,
  /** Where a new chat opens: on the chat page, or where the person is (the dock). */
  opens: "page" | "here" = "page",
  /** The project a new chat is made in, when it is started from one. */
  projectId?: string,
  /** Which of the tab's open chats a new chat becomes. */
  slot: ChatSlot = "chat"
) => {
  const router = useRouter();
  const navigate = useNavigate();
  const { identity } = useRouteContext({ from: "/_shell" });
  const { busy, failure, run } = useCoreAction();
  const [text, setText] = useState("");
  const [files, setFiles] = useState<readonly BoxFile[]>([]);
  // Why a file the person chose stays out of the box.
  const [fileProblem, setFileProblem] = useState<string>();
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
  const shown = resolveChoice(models, efforts, choice);
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
  // same question again, from the same project or none, asks in it,
  // rather than making another.
  const unsent = useRef<{
    id: string;
    question: string;
    projectId: string | undefined;
  } | null>(null);
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
    setFiles((now) => now.filter((each) => each.id !== id));
    attached.current.delete(id);
    setFileProblem(undefined);
  };
  const ask = async (
    question: string,
    carried: readonly BoxFile[] = []
  ): Promise<void> => {
    if (sending.current) {
      return;
    }
    sending.current = true;
    let created: string | undefined;
    const sent = await run(async (session) => {
      let id =
        chatId ??
        (unsent.current?.question === question &&
        unsent.current.projectId === projectId
          ? unsent.current.id
          : undefined);
      if (id === undefined) {
        ({ id } = await session.chats.create(
          titleOf(question),
          projectId ?? null
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
      });
      return askedIn;
    });
    sending.current = false;
    if (sent === undefined) {
      // The box keeps the question and says why it wasn't sent; a new chat
      // made for it waits to be asked in again, and shows in Chat's list.
      if (created !== undefined) {
        unsent.current = { id: created, question, projectId };
        await router.invalidate();
      }
      return;
    }
    unsent.current = null;
    // Clears the box only of what was sent from it: asking again sends an
    // earlier question, and a draft the person started stays.
    setText((now) => (now === question ? "" : now));
    setFiles((now) => now.filter((each) => !carried.includes(each)));
    for (const { id } of carried) {
      attached.current.delete(id);
    }
    if (chatId === undefined) {
      setActiveChat(sent, slot);
      if (opens === "page") {
        await navigate({ to: "/", search: { chat: sent } });
      }
    }
    // Chat's list shows a new chat; from the dock, Chat reads it when it
    // opens, and the page the person is on has nothing to read again.
    if (opens === "page") {
      await router.invalidate();
    }
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
      files: files.map(({ id, file }) => ({
        id,
        name: file.name,
        bytes: file.size,
      })),
      onAttach: attach,
      onRemoveFile: removeFile,
      onSend: () => {
        setFileProblem(undefined);
        void ask(text, files);
      },
      onStop: () => {
        void stop();
      },
    },
    ask,
  };
};
