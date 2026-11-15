import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { z } from "zod";

import { drainObjectOutbox } from "../src/audit-outbox.ts";
import { transcript } from "./agent-chat.ts";
import type { WorkspaceStub } from "./agent-chat.ts";
import { runRecords } from "./agent-code-runs.ts";
import { allEvents } from "./audit-events.ts";
import type { SentRequest } from "./model-provider.ts";

// What a chat's turn did with its code step, for a test that found the
// step's output missing from what reached the model. Read after the turn,
// and only then, so it changes nothing of a turn that went as it should.

/** A block of a request's message, as Anthropic's Messages API takes it. */
const blockSchema = z.looseObject({
  type: z.string(),
  id: z.string().optional(),
  name: z.string().optional(),
  tool_use_id: z.string().optional(),
  is_error: z.boolean().optional(),
  content: z.unknown().optional(),
});

const requestSchema = z.looseObject({
  system: z.unknown().optional(),
  messages: z.array(
    z.looseObject({ content: z.union([z.string(), z.array(blockSchema)]) })
  ),
});

/**
 * How much of a request's instructions tells which of core's calls made
 * it (a chat's turn, a recall's analysis, a request's sorting, the
 * Brain's upkeep): their opening words, which are core's own.
 */
const openingChars = 80;

const textBlocksSchema = z.array(
  z.looseObject({ type: z.string(), text: z.string().optional() })
);

/** A tool result's text: given whole, or as blocks. */
const textOf = (content: unknown): string => {
  if (typeof content === "string") {
    return content;
  }
  const blocks = textBlocksSchema.safeParse(content);
  return blocks.success
    ? blocks.data.map(({ type, text }) => text ?? `[${type}]`).join("")
    : "";
};

/**
 * What `body` asked: its instructions' opening, which says which call
 * made it, and what it carried where each code step's output goes, the
 * result of each `executeCode` call it holds as the model was sent it, or
 * `null` for a call it sent no result of.
 */
const requestShape = (body: unknown) => {
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return { opening: "not a Messages request" };
  }
  const blocks = parsed.data.messages.flatMap(({ content }) =>
    typeof content === "string" ? [] : content
  );
  return {
    opening: textOf(parsed.data.system).slice(0, openingChars),
    codeResults: blocks
      .filter(({ type, name }) => type === "tool_use" && name === "executeCode")
      .map(({ id }) => {
        const result = blocks.find(
          ({ type, tool_use_id: call }) => type === "tool_result" && call === id
        );
        return result === undefined
          ? null
          : {
              isError: result.is_error ?? false,
              text: textOf(result.content),
            };
      }),
  };
};

/**
 * What `personId`'s turn did with its code step, for a failure to show.
 * Their chat the turn made (one not in `chatsBefore`); each of the turn's
 * model `requests`, whether its caller went away, which call made it and
 * what it carried where each code step's result goes; each answer the chat kept, by what it
 * called and why it stopped, to set against the requests; how each of its
 * runs ended, as its record and its step keep it; and the
 * action of every audit event since `since` (ms), the Workspace's outbox
 * drained first. `redact` takes out of all of it what the test may not
 * print.
 */
export const codeStepTrace = async (
  stub: WorkspaceStub,
  personId: string,
  {
    chatsBefore,
    requests,
    since,
    redact,
  }: {
    chatsBefore: ReadonlySet<string>;
    requests: readonly SentRequest[];
    since: number;
    redact: (text: string) => string;
  }
): Promise<unknown> => {
  const listed = await stub.chats(personId);
  const made = listed.filter(({ id }) => !chatsBefore.has(id));
  await runInDurableObject(
    stub,
    async (_instance, state) =>
      await drainObjectOutbox(env, state.storage.sql, 0)
  );
  const events = await allEvents();
  const audit = events
    .filter(({ at }) => Date.parse(at) >= since)
    .map(({ action }) => action);
  const chats = await Promise.all(
    made.map(async ({ id }) => {
      const messages = await transcript(stub, id);
      const records = await runRecords(stub, id);
      return {
        // The turn's own recall is kept as an answer too, with no request.
        answers: messages.flatMap((message) =>
          message.role === "assistant"
            ? [
                {
                  calls: message.content.flatMap((block) =>
                    block.type === "toolCall" ? [block.name] : []
                  ),
                  stopReason: message.stopReason,
                },
              ]
            : []
        ),
        runs: records.map(({ status }) => status),
        steps: messages.flatMap((message) =>
          message.role === "toolResult" && message.toolName === "executeCode"
            ? [{ isError: message.isError, details: message.details ?? null }]
            : []
        ),
      };
    })
  );
  const trace = {
    requests: requests.map(({ body, signal }) => ({
      callerGone: signal.aborted,
      ...requestShape(body),
    })),
    chats,
    audit,
  };
  const redacted: unknown = JSON.parse(redact(JSON.stringify(trace)));
  return redacted;
};
