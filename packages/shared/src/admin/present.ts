/**
 * Whether a piece of text is there: given, and not empty. The prototype asked it with `if (text)`;
 * Grasp OS spells it out.
 */
export const present = (text: string | null | undefined): text is string =>
  text !== undefined && text !== null && text !== "";
