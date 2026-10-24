import { auditDetailValueSchema } from "@grasp-os/shared/audit";
import type { ChatToolEvent } from "@grasp-os/shared/chat";
import { identifierSchema } from "@grasp-os/shared/ids";
import { z } from "zod";

// A call of a chat's code as the chat shows it (`ChatToolEvent`): what the
// APIs of agent-apis.ts hand the Workspace object as each call ends
// (`recordToolCall` in agent-scope.ts), and what it keeps of one. The same
// words as the call's audit event: its method, its target, identifiers and
// counts, how it ended. Never what the call read or was given.

/** Most entries a call's summary keeps. */
export const toolSummaryEntriesMax = 16;

/** Longest reason a call's event keeps: an error code. */
export const toolReasonMaxChars = 128;

/** A method, as the APIs name them: `workflows.runs`, `connections.call`. */
const methodSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*$/u)
  .max(64);

/** One call as an API hands it over, before the chat keeps it. */
export const toolCallSchema = z.object({
  method: methodSchema,
  target: z.object({ type: identifierSchema, id: identifierSchema }).nullable(),
  summary: z
    .record(z.string().max(64), auditDetailValueSchema)
    .refine((summary) => Object.keys(summary).length <= toolSummaryEntriesMax),
  outcome: z.enum(["ok", "pending", "refused", "failed"]),
  reason: z.string().max(toolReasonMaxChars).nullable(),
});
export type ToolCall = z.infer<typeof toolCallSchema>;

/** A kept call, as its row holds it. */
export const toolEventOf = ({
  id,
  callId,
  event,
  createdAt,
}: {
  id: number;
  callId: string;
  event: string;
  createdAt: Date;
}): ChatToolEvent | undefined => {
  let stored: unknown;
  try {
    stored = JSON.parse(event);
  } catch {
    return undefined;
  }
  const call = toolCallSchema.safeParse(stored);
  return call.success
    ? { id, callId, ...call.data, at: createdAt.toISOString() }
    : undefined;
};
