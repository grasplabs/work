import type { ChatCode, ChatPartial } from "@grasp-os/shared/chat";

import type { SignFigure } from "./sign-figures.ts";

// What Grasp's sign in the chat shows, and the figure it takes for it
// (grasplabs/prototype `lib/sign.ts`). The sign stands under the newest
// answer only while Grasp works on it; the thread says which work that is.

/** What Grasp is doing, as its sign in the chat shows it. */
export type SignState =
  | "reading"
  | "thinking"
  | "writing"
  | "working"
  | "error";

/** What Grasp does while it works on a question: all but failing. */
export type WorkState = Exclude<SignState, "error">;

/**
 * What Grasp is doing on a question it works on now. `partial` is the
 * answer being written, once it shows words or code; `replies` the answers
 * to the question stored so far, oldest first; `ran` whether a code step
 * has its result. Code being written or run is work; an answer that shows
 * no words yet is thought; words are writing. Before any of that, Grasp
 * reads the workspace; between its answers, it thinks, or works while the
 * code of the last one runs.
 */
export const signOf = ({
  partial,
  replies,
  ran,
}: {
  partial: ChatPartial | null;
  replies: readonly { code: readonly ChatCode[] }[];
  ran: (callId: string) => boolean;
}): WorkState => {
  const latest = partial ?? replies.at(-1);
  if (latest === undefined) {
    return "reading";
  }
  const last = latest.code.at(-1);
  if (last !== undefined && !ran(last.callId)) {
    return "working";
  }
  return partial === null || partial.text.trim() === ""
    ? "thinking"
    : "writing";
};

/**
 * The figure the sign takes for what Grasp is doing. As soon as it sets to
 * work it is the brain: reading the workspace and thinking. It is lines of
 * text while it reads a document, a pen while it writes, a workflow while
 * it runs code, and an exclamation mark when it failed.
 */
export const figureFor = (
  state: SignState,
  { document = false }: { document?: boolean } = {}
): SignFigure => {
  switch (state) {
    case "reading": {
      return document ? "lines" : "brain";
    }
    case "thinking": {
      return "brain";
    }
    case "writing": {
      return "pen";
    }
    case "working": {
      return "flow";
    }
    case "error": {
      return "alert";
    }
    default: {
      return state satisfies never;
    }
  }
};
