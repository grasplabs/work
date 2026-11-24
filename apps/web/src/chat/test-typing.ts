// Typing in the box to ask in (Damsko's PromptInput) from a test, where no
// keyboard reaches the page: the words land where the caret is, at the end
// of what is there, then the input event the box's editor reads them by,
// as a person's typing does, so what follows (a mention's list, the box's
// value) is what typing does.

/** Types `text` at the end of the box `into` (its `role="textbox"`). */
export const typeInPrompt = (into: Element, text: string): void => {
  if (!(into instanceof HTMLElement) || !into.isContentEditable) {
    throw new TypeError("Not the box to ask in");
  }
  into.focus();
  into.append(text);
  const caret = document.createRange();
  caret.selectNodeContents(into);
  caret.collapse(false);
  document.getSelection()?.removeAllRanges();
  document.getSelection()?.addRange(caret);
  into.dispatchEvent(
    new InputEvent("input", {
      bubbles: true,
      data: text,
      inputType: "insertText",
    })
  );
};
