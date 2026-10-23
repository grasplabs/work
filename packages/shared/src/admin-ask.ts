import { z } from "zod";

import { defineErrorFamily } from "./errors.ts";
import { identifierMaxLength } from "./identifier.ts";

// Ask Grasp (GRA-657): the admin's own chat over every organization. Its
// model calls go through Grasp's own core and its model gateway, never
// from the admin or the browser (GRA-637, answer 3): the admin asks
// that core, signed with the key both derive from its auth secret for this
// purpose alone, as it asks for the admin snapshot (`admin-snapshot.ts`),
// and names the staff member Cloudflare Access let in, whom core's audit
// log records as the asker. The model reads the admin's document (every
// organization in numbers, `adminDocument`) and the conversation so far,
// and nothing else: no tools, and never what anyone said in an interview,
// which the document doesn't hold.

/** Where the admin asks Grasp's own core. Behind the router-secret check. */
export const adminAskPath = "/platform/admin/ask";

/** The purpose the request's signing key is derived for (`hkdfHmacKey`). */
export const adminAskPurpose = "grasp-os admin ask key";

/** How far from core's clock a request may have been sent. */
export const adminAskMaxSkewMs = 5 * 60 * 1000;

/** A conversation longer than this starts over: the document goes with every question. */
export const adminAskMaxTurns = 40;

/** The most characters one turn may have. */
export const adminAskMaxTurnChars = 8000;

/** The most characters the admin's document may have: a few hundred organizations. */
export const adminAskMaxDocumentChars = 600_000;

/** The most bytes a request's body may have: the document, the turns, and room for JSON. */
export const adminAskMaxBytes =
  4 * (adminAskMaxDocumentChars + adminAskMaxTurns * adminAskMaxTurnChars) +
  4096;

const turnSchema = z.strictObject({
  role: z.enum(["user", "assistant"]),
  text: z.string().trim().min(1).max(adminAskMaxTurnChars),
});
export type AdminAskTurn = z.output<typeof turnSchema>;

/**
 * What the admin sends: when, so a request caught on its way can't be
 * sent later; the staff member asking, for the audit log; the admin's
 * document; and the conversation, taking turns, starting and ending with
 * a question.
 */
export const adminAskRequestSchema = z.strictObject({
  sentAt: z.iso.datetime(),
  staff: z.strictObject({
    email: z.email().max(identifierMaxLength).toLowerCase(),
  }),
  document: z.string().trim().min(1).max(adminAskMaxDocumentChars),
  turns: z
    .array(turnSchema)
    .min(1)
    .max(adminAskMaxTurns)
    .refine(
      (turns) =>
        turns.every(
          ({ role }, index) => role === (index % 2 === 0 ? "user" : "assistant")
        ) && turns.at(-1)?.role === "user",
      "The conversation takes turns, starting and ending with a question"
    ),
});
export type AdminAskRequest = z.input<typeof adminAskRequestSchema>;

/** What core answers: the model's answer, and whether it stopped at its limit. */
export const adminAskAnswerSchema = z.object({
  text: z.string(),
  truncated: z.boolean(),
});
export type AdminAskAnswer = z.output<typeof adminAskAnswerSchema>;

/** Why Grasp's core didn't answer, as the admin says it. */
export const adminAskErrors = defineErrorFamily({
  "admin_ask.no_model":
    "Grasp's own platform has no model it may send every company's numbers to.",
  "admin_ask.not_answered": "The model didn't answer. Ask again in a moment.",
});

/**
 * The conversation as a chat holds it, made into turns core takes: only
 * what has words, and of two in a row from the same side only the later
 * one, so a question that got no answer (it failed, or was stopped) isn't
 * sent again beside the next. As the prototype's `turnsOf`.
 */
export const turnsOf = (
  said: readonly { role: string; text: string }[]
): AdminAskTurn[] => {
  const turns: AdminAskTurn[] = [];
  for (const { role, text } of said) {
    if ((role !== "user" && role !== "assistant") || text.trim() === "") {
      continue;
    }
    if (turns.at(-1)?.role === role) {
      turns.pop();
    }
    if (turns.length === 0 && role === "assistant") {
      continue;
    }
    turns.push({ role, text });
  }
  return turns;
};
