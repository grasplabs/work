import { useNavigate, useRouter } from "@tanstack/react-router";
import { useRef, useState } from "react";

import { useCoreAction } from "../use-core-action.ts";
import { setActiveChat } from "./active-chat.ts";

// Asking in a chat, from the chat page or the chat dock on any other page:
// the box's text and model, and asking in the open chat, or in a new one
// named after the question.

/** A new chat's title: the start of its first question. */
const titleOf = (question: string): string => {
  const line = question.trim().split("\n")[0] ?? "";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
};

/**
 * What the box to ask in needs: the text and model, and asking in
 * `chatId`, or in a new chat named after the question.
 */
export const useAsk = (
  chatId: string | undefined,
  models: readonly string[],
  /** Where a new chat opens: on the chat page, or where the person is (the dock). */
  opens: "page" | "here" = "page"
) => {
  const router = useRouter();
  const navigate = useNavigate();
  const { busy, failure, run } = useCoreAction();
  const [text, setText] = useState("");
  // The person's choice; until they make one, the default, once the
  // models are known.
  const [chosenModel, setChosenModel] = useState<string>();
  const model = chosenModel ?? models[0] ?? "";
  // One question at a time: a second click on Send or Try again while one
  // is on its way would ask it twice. A ref, as `busy` is only seen on the
  // next render.
  const sending = useRef(false);
  // A new chat made for a question that then failed to send: asking the
  // same question again asks in it, rather than making another.
  const unsent = useRef<{ id: string; question: string } | null>(null);
  const ask = async (question: string): Promise<void> => {
    if (sending.current) {
      return;
    }
    sending.current = true;
    let created: string | undefined;
    const sent = await run(async (session) => {
      let id =
        chatId ??
        (unsent.current?.question === question ? unsent.current.id : undefined);
      if (id === undefined) {
        ({ id } = await session.chats.create(titleOf(question)));
        created = id;
      }
      await session.chats.send(id, { text: question, model });
      return id;
    });
    sending.current = false;
    if (sent === undefined) {
      // The box keeps the question and says why it wasn't sent; a new chat
      // made for it waits to be asked in again, and shows in Chat's list.
      if (created !== undefined) {
        unsent.current = { id: created, question };
        await router.invalidate();
      }
      return;
    }
    unsent.current = null;
    // Clears the box only of what was sent from it: asking again sends an
    // earlier question, and a draft the person started stays.
    setText((now) => (now === question ? "" : now));
    if (chatId === undefined) {
      setActiveChat(sent);
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
      onModel: setChosenModel,
      busy,
      failure,
      onSend: () => {
        void ask(text);
      },
      onStop: () => {
        void stop();
      },
    },
    ask,
  };
};
