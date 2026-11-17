import { agentErrors } from "@grasp-os/shared/agent";
import type { ChatUpdate } from "@grasp-os/shared/chat";
import { describe, expect, it } from "vite-plus/test";

import { CoreConnection } from "../core-connection.ts";
import { loadChat } from "./chat-watch.ts";

// A chat's page waits for its chat before it shows (routes/_shell.chats.$chatId.tsx),
// over the tab's real connection to a stand-in core: the thread is there
// whole as the page appears, a chat that isn't the person's is not found,
// and whoever shows the chat next follows on from the same watch.

const question: ChatUpdate = {
  messages: [
    {
      id: 1,
      role: "user",
      text: "What's due this week?",
      at: "2026-11-17T09:00:00.000Z",
    },
  ],
  partial: null,
  running: true,
  stopped: null,
  held: 0,
  worked: 0,
};

/** A stand-in core that streams `question` for the person's chat, and has no other. */
const tabWithChat = (mine: string) => {
  const watched: string[] = [];
  const core = new CoreConnection({
    onSessionEnded: () => {
      // Nobody signs out here.
    },
    connect: () => {
      const session = {
        whoami: async () => await Promise.resolve({ userId: "one" }),
        chats: {
          watch: async (
            chatId: string,
            _after: number | null,
            onUpdate: (update: ChatUpdate) => void
          ) => {
            watched.push(chatId);
            if (chatId !== mine) {
              throw agentErrors.create("agent.chat_not_found");
            }
            setTimeout(() => {
              onUpdate(question);
            }, 0);
            return await Promise.resolve({
              release: async () => {
                // Nothing to let go of.
              },
              [Symbol.dispose]: () => {
                // Nothing to let go of.
              },
            });
          },
        },
      };
      const stub = {
        authenticate: async () => await Promise.resolve(session),
        onRpcBroken: () => {
          // The connection holds.
        },
        [Symbol.dispose]: () => {
          // Nothing to let go of.
        },
      };
      // SAFETY: a stand-in for the parts of core's API the chat's page reads.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      return stub as never;
    },
    watchPage: () => {
      // The page never comes back here.
    },
  });
  return { core, watched };
};

describe("loading a chat before its page shows", () => {
  it("has the question and the running answer, and the page follows on from the same watch", async () => {
    const { core, watched } = tabWithChat("chat-1");

    const loaded = await loadChat(core, "chat-1");
    const again = await loadChat(core, "chat-1");

    expect({
      texts: loaded.view.messages.map(({ text }) => text),
      running: loaded.view.running,
      gone: loaded.gone,
      sameAfter: again.view.messages.length,
      watches: watched.length,
    }).toStrictEqual({
      texts: ["What's due this week?"],
      running: true,
      gone: undefined,
      sameAfter: 1,
      watches: 1,
    });
  });

  it("finds no chat that is someone else's, or none at all", async () => {
    const { core } = tabWithChat("chat-2");

    const theirs = await loadChat(core, "someone-elses");

    expect(theirs.gone).toBeTruthy();
  });
});
