/**
 * What the chat agent's tests share (agent*.test.ts): chats of their own,
 * the code steps they run, and what those runs leave behind.
 */
import { applyOutput } from "@grasp-os/shared/chat";
import type { ChatOutput, ChatUpdate } from "@grasp-os/shared/chat";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";

import {
  chatOf,
  codeResults,
  codeStatuses,
  codeStep,
  says,
  transcript,
} from "./agent-chat.ts";
import type { WorkspaceStub } from "./agent-chat.ts";
import { requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import type { Idp } from "./idp.ts";
import { collectionWithNote, readCollection } from "./knowledge.ts";
import { fakeProviderFor } from "./model-provider.ts";
import type { ProviderReply } from "./model-provider.ts";
import { signedInApi, signedInWithRole } from "./sign-in.ts";

/**
 * The `agent.call` events of chat `chatId` refused for `reason`, once the
 * outboxes are drained: all of them, however many there should be.
 */
export const refusalsIn = async (chatId: string, reason: string) => {
  const events = await allEvents();
  return events
    .filter(
      ({ action, detail }) =>
        action === "agent.call" &&
        detail.chat === chatId &&
        detail.reason === reason
    )
    .map(({ detail }) => ({
      method: detail.method,
      outcome: detail.outcome,
      reason: detail.reason,
    }));
};

/** Points the object's database at `db` (objects may share their env). */
export const setObjectDb = async (stub: WorkspaceStub, db: D1Database) => {
  await runInDurableObject(stub, (instance) => {
    const objectEnv: unknown = Reflect.get(instance, "env");
    if (typeof objectEnv === "object" && objectEnv !== null) {
      Reflect.set(objectEnv, "DB", db);
    }
  });
};

/**
 * Runs `during` with every read of revocations the object makes (the
 * permissions query `revokedSince` sends) first going through `before`:
 * a wait, or a throw. The rest of its database is untouched. Set back
 * however it ends.
 */
export const withRevocationReads = async (
  stub: WorkspaceStub,
  before: () => Promise<void>,
  during: () => Promise<void>
): Promise<void> => {
  const real = env.DB;
  const slowed = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get: (target, property) => {
        const value: unknown = Reflect.get(target, property);
        if (typeof value !== "function") {
          return value;
        }
        if (property === "bind") {
          return (...args: unknown[]) => slowed(target.bind(...args));
        }
        return async (...args: unknown[]): Promise<unknown> => {
          await before();
          return await Reflect.apply(value, target, args);
        };
      },
    });
  const db = new Proxy(real, {
    get: (target, property) => {
      const value: unknown = Reflect.get(target, property);
      if (property === "prepare") {
        return (query: string) => {
          const statement = target.prepare(query);
          // Only `revokedSince`'s read: revocations since a run opened.
          return query.includes('"permissions"."revoked_at" >=')
            ? slowed(statement)
            : statement;
        };
      }
      return typeof value === "function"
        ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
        : value;
    },
  });
  await setObjectDb(stub, db);
  try {
    await during();
  } finally {
    await setObjectDb(stub, real);
  }
};

/** The chat's code run records, oldest first, as the object keeps them. */
export const runRecords = async (stub: WorkspaceStub, chatId: string) =>
  await runInDurableObject(stub, (_instance, state) =>
    state.storage.sql
      .exec<Record<string, string | number | null>>(
        "SELECT id, tool_call_id, source_hash, source_chars, agent, compatibility_date, runtime, cpu_limit, status FROM chat_code_runs WHERE chat_id = ? ORDER BY started_at",
        chatId
      )
      .toArray()
  );

/** The call ID of each code step the chat's agent asked for. */
export const toolCallIds = async (stub: WorkspaceStub, chatId: string) => {
  const messages = await transcript(stub, chatId);
  return messages.flatMap((message) =>
    message.role === "assistant"
      ? message.content.flatMap((block) =>
          block.type === "toolCall" ? [block.id] : []
        )
      : []
  );
};

/**
 * Follows a chat's running step output as the page does: every update's
 * output so far, whether it carried a step's result, and the latest.
 */
export const watchOutput = async (
  stub: WorkspaceStub,
  chatId: string,
  personId: string
) => {
  let output: ChatOutput | null = null;
  const seen: { output: ChatOutput | null; result: boolean }[] = [];
  await stub.watch(chatId, personId, null, async (update: ChatUpdate) => {
    output = applyOutput(output, update.output);
    seen.push({
      output,
      result: update.messages.some(({ role }) => role === "result"),
    });
    await Promise.resolve();
  });
  return { seen, latest: () => seen.at(-1)?.output ?? null };
};

/** New chats, and the code steps run in them, for people `idp` signs in. */
export const chatsWith = (idp: Idp) => {
  /** A new chat for a person no other test uses, answered by `replies`. */
  const newChat = async (...replies: ProviderReply[]) => {
    // A member of the organization, whom no other test uses.
    const { userId } = await signedInWithRole(idp, "user");
    return await chatOf(userId, ...replies);
  };

  /**
   * {@link newChat}, the organization having chosen `models` (the first its
   * default), which answer with `replies`.
   */
  const newChatOn = async (models: string[], ...replies: ProviderReply[]) => {
    const chat = await newChat();
    const provider = await fakeProviderFor(models, ...replies);
    return { ...chat, provider };
  };

  /** Runs `code` as the chat's only code step, and returns what it gave. */
  const runStep = async (code: string) => {
    const { stub, chat, ask } = await newChat(codeStep(code), says("Done."));
    await ask("Run it.");
    const [result] = await codeResults(stub, chat.id);
    return result;
  };

  /** Runs `code` as the chat's only code step: what it gave, and how it ended. */
  const runEnded = async (code: string) => {
    const { stub, chat, ask } = await newChat(codeStep(code), says("Done."));
    await ask("Run it.");
    const [result] = await codeResults(stub, chat.id);
    const [status] = await codeStatuses(stub, chat.id);
    return { ...result, status };
  };

  /**
   * A chat whose agent an admin granted something, running `code` once,
   * and `revoke`, which revokes it.
   */
  const grantedChat = async (code: string) => {
    const admin = await signedInApi(idp, "admin");
    const { collectionId } = await collectionWithNote(admin.api, {
      name: `Handbook ${crypto.randomUUID()}`,
      access: "everyone",
    });
    const chat = await newChat(codeStep(code), says("Done."));
    const permission = await requestGranted(
      idp,
      admin,
      readCollection(chat.agent, collectionId, "HANDBOOK")
    );
    return {
      ...chat,
      revoke: async () => {
        await admin.api.permissions.revoke(permission);
      },
    };
  };

  return { newChat, newChatOn, runStep, runEnded, grantedChat };
};
