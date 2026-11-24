import type { ChatAsked } from "@grasp-os/shared/chat";

// The person's answers to the agent's questions, as the thread shows them
// (thread.tsx): their message is the answers as text (`answersText` in
// asked-questions.tsx, so it reads right wherever else it is read), each
// "n. Question — Answer" on a line of its own; the thread shows it as the
// questions and their answers, compact. A message that isn't exactly that
// shows as written.

/** One question, and what the person answered to it. */
export interface Answered {
  question: string;
  answer: string;
}

/**
 * The questions `asked` asked and their answers, as `text` gives them; none
 * when `text` isn't the answers to every one of them, in order.
 */
export const answeredOf = (
  asked: ChatAsked,
  text: string
): Answered[] | undefined => {
  const lines = text.split("\n");
  if (asked.questions.length < 2 || lines.length !== asked.questions.length) {
    return undefined;
  }
  const pairs: Answered[] = [];
  for (const [index, { question }] of asked.questions.entries()) {
    const head = `${index + 1}. ${question} — `;
    const line = lines[index] ?? "";
    if (!line.startsWith(head)) {
      return undefined;
    }
    pairs.push({ question, answer: line.slice(head.length) });
  }
  return pairs;
};
