import type { Message } from "@earendil-works/pi-ai";
import { workspaceIdSchema } from "@grasp-os/shared/ids";
import type { ChatId } from "@grasp-os/shared/ids";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";

import { personalWorkspaceId } from "../src/chats-rpc.ts";
import { workspace } from "../src/durable-objects.ts";
import { fakeProvider, testModel } from "./model-provider.ts";
import type { Answer, ProviderReply } from "./model-provider.ts";

// A chat's agent, as the tests drive it: the Workspace object's loop, the
// code it runs in isolates of their own, the model gateway and connect, all
// real. The outside system is the model provider behind connect: a fake
// answers with scripted replies, in the provider's own wire format
// (test/model-provider.ts).

export const model = testModel;

/** The model calls `executeCode` with `code`, `times` times at once. */
export const codeStep = (code: string, times = 1): Answer => ({
  text: "",
  toolCalls: Array.from({ length: times }, () => ({
    id: `call_${crypto.randomUUID()}`,
    name: "executeCode",
    arguments: { code },
  })),
  inputTokens: 200,
  outputTokens: 40,
});

/** The model reads the full declaration of the APIs `names` (`readApi`). */
export const readApiStep = (...names: string[]): Answer => ({
  text: "",
  toolCalls: [
    {
      id: `call_${crypto.randomUUID()}`,
      name: "readApi",
      arguments: { names },
    },
  ],
  inputTokens: 200,
  outputTokens: 10,
});

/** The model answers. */
export const says = (text: string): Answer => ({
  text,
  inputTokens: 200,
  outputTokens: 20,
});

/**
 * `answer`, its stream stopped after its text's first `at` characters until
 * released: the model still answering, for as long as a test needs.
 */
export const pausedReply = (answer: Answer, at: number) => {
  const release = Promise.withResolvers<boolean>();
  const reply: Answer = { ...answer, pause: { at, until: release.promise } };
  return {
    reply,
    release: () => {
      release.resolve(true);
    },
  };
};

export type WorkspaceStub = ReturnType<typeof workspace>;

/**
 * Sets the object's model rules (`MODEL_GATEWAY`), none unless given.
 * Objects may share their env, so every test sets it; a restarted object
 * may get a new one, so it is set again.
 */
export const configureObject = async (
  stub: WorkspaceStub,
  { rules = {} }: { rules?: object } = {}
) => {
  await runInDurableObject(stub, (instance) => {
    const objectEnv: unknown = Reflect.get(instance, "env");
    if (typeof objectEnv !== "object" || objectEnv === null) {
      throw new TypeError("The Workspace object has no env");
    }
    Object.assign(objectEnv, { MODEL_GATEWAY: rules });
  });
};

/**
 * A new chat of `personId`'s in a new workspace, answered by `replies`,
 * and the agent subject its permissions are granted to.
 */
export const chatOf = async (personId: string, ...replies: ProviderReply[]) => {
  const id = workspaceIdSchema.parse(crypto.randomUUID());
  const stub = workspace(env, id);
  const chat = await stub.createChat("Questions", personId, id);
  const provider = await fakeProvider(...replies);
  await configureObject(stub);
  const ask = async (text: string) => await stub.ask(chat.id, { text, model });
  // The workspace's agent: its grants hold in all the workspace's chats.
  const agent = { type: "agent" as const, agentId: id };
  return { id, stub, chat, personId, provider, ask, agent };
};

/**
 * `personId`'s own Workspace object, the one their session's chats are in
 * (`personalWorkspaceId`), answered by `replies` in all its chats, with an
 * agent of its own: `newChat` makes each chat.
 */
export const personalChatsOf = async (
  personId: string,
  ...replies: ProviderReply[]
) => {
  const id = personalWorkspaceId(personId);
  const stub = workspace(env, id);
  const provider = await fakeProvider(...replies);
  await configureObject(stub);
  const agent = { type: "agent" as const, agentId: crypto.randomUUID() };
  const newChat = async () => {
    const chat = await stub.createChat("Questions", personId, agent.agentId);
    const ask = async (text: string) =>
      await stub.ask(chat.id, { text, model });
    return { chat, ask };
  };
  return { id, stub, provider, agent, newChat };
};

/** The chat's transcript, as the object keeps it. */
export const transcript = async (
  stub: WorkspaceStub,
  chatId: string
): Promise<Message[]> =>
  await runInDurableObject(stub, (instance) => instance.messages(chatId));

/** What the code steps of the chat returned, or threw, as the model read it. */
export const codeResults = async (stub: WorkspaceStub, chatId: string) => {
  const messages = await transcript(stub, chatId);
  return messages.flatMap((message) =>
    message.role === "toolResult" && message.toolName === "executeCode"
      ? [
          {
            isError: message.isError,
            text: message.content
              .flatMap((part) => (part.type === "text" ? [part.text] : []))
              .join(""),
          },
        ]
      : []
  );
};

/** How each code step of the chat ended, as the host recorded it. */
export const codeStatuses = async (stub: WorkspaceStub, chatId: string) => {
  const messages = await transcript(stub, chatId);
  return messages.flatMap((message) => {
    if (message.role !== "toolResult") {
      return [];
    }
    const details: unknown = message.details;
    return [
      typeof details === "object" && details !== null && "status" in details
        ? details.status
        : undefined,
    ];
  });
};

/**
 * Sets `vars` in the object's env, as `configureObject` sets its rules:
 * a shorter code run limit (`CODE_RUN_TIMEOUT_MS`), say. The env is the
 * test Worker's own, shared by every object of the file, so the test puts
 * back what was there with the restore this returns (in a `finally`), or
 * the tests after it run under its values.
 */
export const setObjectEnv = async (
  stub: WorkspaceStub,
  vars: Record<string, string>
): Promise<() => Promise<void>> => {
  const before = await runInDurableObject(stub, (instance) => {
    const objectEnv: unknown = Reflect.get(instance, "env");
    if (typeof objectEnv !== "object" || objectEnv === null) {
      throw new TypeError("The Workspace object has no env");
    }
    const kept: Record<string, { value: unknown } | undefined> = {};
    for (const key of Object.keys(vars)) {
      const value: unknown = Reflect.get(objectEnv, key);
      kept[key] = Object.hasOwn(objectEnv, key) ? { value } : undefined;
    }
    Object.assign(objectEnv, vars);
    return kept;
  });
  return async () => {
    await runInDurableObject(stub, (instance) => {
      const objectEnv: unknown = Reflect.get(instance, "env");
      if (typeof objectEnv !== "object" || objectEnv === null) {
        throw new TypeError("The Workspace object has no env");
      }
      for (const [key, was] of Object.entries(before)) {
        if (was === undefined) {
          Reflect.deleteProperty(objectEnv, key);
        } else {
          Reflect.set(objectEnv, key, was.value);
        }
      }
    });
  };
};

/** What a test's own code run records of its module. */
export const testRunOpening = {
  toolCallId: "call_test",
  sourceHash: "0".repeat(64),
  sourceChars: 0,
};

/**
 * Opens a code run of the chat outside any turn, for a test that writes
 * a draft as the chat's code would: the run every draft write is
 * admitted against.
 */
export const openTestRun = async (
  stub: WorkspaceStub,
  chatId: ChatId
): Promise<string> => await stub.openCodeRun(chatId, testRunOpening);
