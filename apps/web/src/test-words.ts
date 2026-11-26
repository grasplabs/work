// What a control says to people in a DOM test: its words, less the ones it
// hides from them (`aria-hidden`), such as a Button's words for the states
// it is not in, which it keeps in place so its width never changes.

/** `element`'s words as people get them. */
export const wordsOf = (element: Element): string => {
  const copy = element.cloneNode(true);
  if (!(copy instanceof Element)) {
    return "";
  }
  for (const hidden of copy.querySelectorAll("[aria-hidden='true']")) {
    hidden.remove();
  }
  return copy.textContent.trim();
};
