import { z } from "zod";

import { connectorNameSchema } from "./manifest.ts";
import {
  signPlanText,
  signedPlanSchema,
  verifyPlanSignature,
} from "./plan-signature.ts";
import type { SignedPlan } from "./plan-signature.ts";

// The ticket that starts one session of Grasp's agent (GRA-689, S3): the
// admin signs it, with the same key as the plan, when a build whose plan a
// person approved starts writing, and dispatches the repository's
// `connector-agent` workflow with it and the signed plan. The workflow
// does nothing before both verify (scripts/connector-session.ts).
//
// A signed plan alone says a person approved it, not that it may run now:
// it stays valid for as long as the key does, and lies on the agent's
// branch for anyone to read. The ticket adds what a run needs: this plan
// (its digest), this build's run, a nonce the session's commit carries so
// a ticket starts at most one pushed session, and an hour to start in. Its
// text starts with a header no plan document has, so neither signature
// ever passes for the other.

/** The ticket's first line: no plan document starts with it. */
export const sessionTicketHeader = "grasp-os connector session v1";

/** Longest a ticket is valid for, from when the admin signed it. */
export const sessionTicketMaxMs = 60 * 60_000;

/** How far the workflow's clock may run behind the admin's. */
export const sessionClockSkewMs = 5 * 60_000;

export const sessionTicketSchema = z.strictObject({
  /** The app whose connector the session writes: its branch's. */
  app: connectorNameSchema,
  /** The approved plan's round. */
  round: z.int().min(1),
  /** SHA-256 of the signed plan document's exact text, hex. */
  plan: z.string().regex(/^[0-9a-f]{64}$/u),
  /** Single use: the session's commit carries it, and a ticket whose nonce a commit carries starts nothing more. */
  nonce: z.string().regex(/^[0-9a-f]{32}$/u),
  /** The build's run in the admin, for the record. */
  run: z.string().min(1).max(100),
  issuedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});
export type SessionTicket = z.infer<typeof sessionTicketSchema>;

/** The text of `ticket`, as it is signed and dispatched. */
export const sessionTicketText = (ticket: SessionTicket): string =>
  `${sessionTicketHeader}\n${JSON.stringify(ticket)}\n`;

/** SHA-256 of `text`, hex. */
export const textDigest = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text)
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

/** A new nonce: 16 random bytes, hex. */
export const newSessionNonce = (): string =>
  [...crypto.getRandomValues(new Uint8Array(16))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

/** Signs the ticket text `text` with the admin's plan key (`signPlanText`). */
export const signSessionTicket = async (
  privateKey: string,
  text: string
): Promise<string> => await signPlanText(privateKey, text);

/** What a session is dispatched with: the signed plan and the signed ticket. */
export interface SessionDispatch {
  plan: string;
  planSignature: string;
  ticket: string;
  ticketSignature: string;
}

/** A dispatch both of whose signatures, and every one of whose bounds, hold. */
export interface VerifiedSession {
  ticket: SessionTicket;
  plan: SignedPlan;
}

/** `text` parsed as JSON, or undefined. */
const parsedJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** The ticket in `text`, unsigned yet: undefined when it isn't one. */
const ticketOf = (text: string): SessionTicket | undefined => {
  const [header, body, rest] = text.split("\n");
  if (header !== sessionTicketHeader || body === undefined || rest !== "") {
    return undefined;
  }
  const parsed = sessionTicketSchema.safeParse(parsedJson(body));
  return parsed.success ? parsed.data : undefined;
};

/** What's wrong with the ticket's times at `now`. */
const timeProblems = (ticket: SessionTicket, now: number): string[] => {
  const issued = Date.parse(ticket.issuedAt);
  const expires = Date.parse(ticket.expiresAt);
  const problems: string[] = [];
  if (expires - issued > sessionTicketMaxMs || expires <= issued) {
    problems.push("The session ticket is valid for longer than an hour");
  }
  if (issued > now + sessionClockSkewMs) {
    problems.push("The session ticket was issued in the future");
  }
  if (expires <= now) {
    problems.push("The session ticket has expired");
  }
  return problems;
};

/**
 * The session `dispatch` starts, verified with the admin's plan public key
 * `publicKey` at `now`: both signatures, the ticket's header and times,
 * and that the ticket names exactly the plan it came with. Otherwise
 * every reason it may not start.
 */
export const verifySessionDispatch = async (
  publicKey: string | undefined,
  dispatch: SessionDispatch,
  now: number
): Promise<VerifiedSession | { problems: string[] }> => {
  if (publicKey === undefined || publicKey.trim() === "") {
    return {
      problems: [
        "CONNECTOR_PLAN_KEY isn't set, so no session can be trusted: set the repository variable to the admin's plan signing public key",
      ],
    };
  }
  const [planSigned, ticketSigned] = await Promise.all([
    verifyPlanSignature(publicKey, dispatch.plan, dispatch.planSignature),
    verifyPlanSignature(publicKey, dispatch.ticket, dispatch.ticketSignature),
  ]);
  const problems: string[] = [];
  if (!planSigned) {
    problems.push("The plan isn't signed by the admin's plan key");
  }
  if (!ticketSigned) {
    problems.push("The session ticket isn't signed by the admin's plan key");
  }
  if (problems.length > 0) {
    return { problems };
  }
  const ticket = ticketOf(dispatch.ticket);
  const plan = signedPlanSchema.safeParse(parsedJson(dispatch.plan));
  if (ticket === undefined) {
    return { problems: ["The session ticket isn't a session ticket"] };
  }
  if (!plan.success) {
    return { problems: ["The plan isn't a build plan"] };
  }
  if (plan.data.app !== ticket.app) {
    problems.push(
      `The session ticket is for ${ticket.app}, the plan for ${plan.data.app}`
    );
  }
  if (plan.data.round !== ticket.round) {
    problems.push(
      `The session ticket is for round ${ticket.round}, the plan is round ${plan.data.round}`
    );
  }
  if ((await textDigest(dispatch.plan)) !== ticket.plan) {
    problems.push("The session ticket names another plan");
  }
  problems.push(...timeProblems(ticket, now));
  return problems.length === 0 ? { ticket, plan: plan.data } : { problems };
};
