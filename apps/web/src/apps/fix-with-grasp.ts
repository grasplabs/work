import type { DraftProblem } from "@grasp-os/shared/drafts";

// Fix with Grasp, wherever the App's workspace offers it (the Publish
// panel, a preview that didn't start): what was found goes to the App's
// chat as a question, which its agent answers by fixing the draft.

/**
 * The question asked of the App's chat: `intro`, then each of `problems`
 * on a line of its own, where it is first when it is somewhere.
 */
export const fixQuestion = (
  intro: string,
  problems: readonly DraftProblem[]
): string =>
  [
    intro,
    ...problems.map(({ at, line, message }) => {
      const where = [at, line].filter((part) => part !== null).join(":");
      return where === "" ? `- ${message}` : `- ${where}: ${message}`;
    }),
  ].join("\n");
