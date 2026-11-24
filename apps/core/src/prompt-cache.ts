import { z } from "zod";

// A cache breakpoint inside the system prompt, for Anthropic's Messages
// API. pi-ai sends the system prompt as one text block with
// `cache_control` at its end, after everything that differs between
// chats (the chat's APIs, memory, skills): a prefix cached there is
// reused only within one chat. Splitting the block where the part every
// chat shares ends (`sharedPrefixEnd`), with a breakpoint of its own,
// caches that part across chats too. Anthropic reads the request as
// tools, then system, then messages: chats share that prefix as long as
// they are offered the same tools, which most chats that build in a
// deployment are. pi-ai already marks the last tool, the system prompt's
// end and the last message: with this one, four, Anthropic's most.
//
// OpenAI caches a prompt's prefix on its own, with no breakpoints: pi-ai
// sends the conversation's session as `prompt_cache_key`, which keeps its
// requests on one cache, so other chats reach that prefix only as far as
// OpenAI's routing happens to share it.

/** Where the part of the system prompt every chat shares ends: after the docs (agent-docs.ts). */
export const sharedPrefixEnd = "</docs>";

const textBlockSchema = z.looseObject({
  type: z.literal("text"),
  text: z.string(),
  cache_control: z.looseObject({ type: z.string() }).optional(),
});

const payloadSchema = z.looseObject({
  system: z.tuple([textBlockSchema]),
});

/**
 * `payload` with its one system block split after `sharedPrefixEnd`, each
 * part with the block's `cache_control`; any other payload as it is.
 */
export const withSharedPrefixCached = (payload: unknown): unknown => {
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) {
    return payload;
  }
  const [block] = parsed.data.system;
  const end = block.text.indexOf(sharedPrefixEnd);
  if (block.cache_control === undefined || end === -1) {
    return payload;
  }
  const at = end + sharedPrefixEnd.length;
  const rest = block.text.slice(at).trim();
  if (rest === "") {
    return payload;
  }
  return {
    ...parsed.data,
    system: [
      { ...block, text: block.text.slice(0, at) },
      { ...block, text: rest },
    ],
  };
};
