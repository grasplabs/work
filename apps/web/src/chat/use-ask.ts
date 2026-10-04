import { useNavigate, useRouter } from "@tanstack/react-router";
import { useState } from "react";

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
  const ask = async (question: string): Promise<void> => {
    let created: string | undefined;
    const sent = await run(async (session) => {
      let id = chatId;
      if (id === undefined) {
        ({ id } = await session.chats.create(titleOf(question)));
        created = id;
      }
      await session.chats.send(id, { text: question, model });
      return id;
    });
    if (sent === undefined) {
      // A new chat the question didn't go into is in the list, to ask again.
      if (created !== undefined) {
        await router.invalidate();
      }
      return;
    }
    // Clears the box only of what was sent from it: asking again sends an
    // earlier question, and a draft the person started stays.
    setText((now) => (now === question ? "" : now));
    if (chatId === undefined) {
      setActiveChat(sent);
      if (opens === "page") {
        await navigate({ to: "/", search: { chat: sent } });
      }
    }
    await router.invalidate();
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
