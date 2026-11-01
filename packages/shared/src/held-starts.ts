import type { Json } from "./json.ts";

// Starts of independent workflows a chat's agent asked for, held until
// the person it acts for confirms them in Grasp (core's held-starts.ts):
// a change an agent makes waits for its person, as its writes to outside
// systems do. Only that person sees and decides theirs.

/** A start a chat's agent asked for, waiting for its person to confirm it. */
export interface HeldStart {
  id: string;
  /** The independent workflow, its name, and the version it would start. */
  workflow: string;
  workflowName: string;
  version: number;
  /** The input it would start with, exactly as confirming it sends it. */
  input: Json;
  /** The SHA-256 of that input: confirming names it, so it is what was shown. */
  inputHash: string;
  /** The chat the agent asked from. */
  chatId: string;
  /** When it was asked for, and when it lapses unconfirmed (ISO 8601). */
  requestedAt: string;
  expiresAt: string;
}

/** What confirming a held start started: the start's receipt and its run. */
export interface ConfirmedStart {
  start: string;
  run: string | null;
}

/** The signed-in person's held starts. */
export interface HeldStartsApi {
  /** The starts waiting for them, oldest first. */
  list: () => Promise<HeldStart[]>;
  /**
   * Starts held start `id`, with exactly the input of `inputHash`, as its
   * agent acting for them: the agent's grant and their role read again as
   * it starts. Refused once it doesn't wait (`workflow.start_held_gone`).
   */
  confirm: (id: string, inputHash: string) => Promise<ConfirmedStart>;
  /** Declines held start `id`: it never starts. */
  decline: (id: string) => Promise<void>;
}
