import { useState } from "react";

/**
 * The question asked in this view, which Grasp UI's Thread takes to the
 * top with room kept under it for its answer: from the moment it runs,
 * and still once the answer has ended, so the room stays and nothing moves
 * then, until the next question is asked or the chat is left. A chat
 * opened with no question running keeps none.
 */
export const useAnswerTo = (
  chatId: string,
  lastQuestion: string | undefined,
  running: boolean
): string | undefined => {
  const [asked, setAsked] = useState<{ chatId: string; id: string }>();
  if (
    running &&
    lastQuestion !== undefined &&
    (asked?.chatId !== chatId || asked.id !== lastQuestion)
  ) {
    setAsked({ chatId, id: lastQuestion });
  }
  if (running) {
    return lastQuestion;
  }
  return asked?.chatId === chatId && asked.id === lastQuestion
    ? asked.id
    : undefined;
};
