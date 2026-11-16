// An instruction file's text as a chat's prompt holds it (agent.ts): its
// markup escaped, so it can neither close the block it stands in nor fake
// an escape. Its size limit counts this form too (brain-next.ts
// `addInstructionFile`), so what reaches the prompt is bounded by the limit
// whatever the text holds.

/** Characters an instruction file's text never holds in a prompt as written. */
const markup = /[&<>]/gu;

const entities: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
};

/** `text` as a chat's prompt holds it. */
export const promptTextOf = (text: string): string =>
  text.replaceAll(markup, (character) => entities[character] ?? character);
