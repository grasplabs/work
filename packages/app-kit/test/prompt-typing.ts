import type { TiptapEditorHTMLElement } from "@tiptap/core";

// Typing in a `PromptEditor` from a test, where no keyboard reaches the
// page: through the editor TipTap keeps on its element for tests, at the
// caret, as a person's typing lands, so what follows (a trigger's
// dropdown, the box's value) is what typing does.

const isEditorElement = (
  element: Element
): element is TiptapEditorHTMLElement => "editor" in element;

/** Types `text` at the caret of the prompt editor `box`. */
export const typeInPrompt = (box: Element, text: string): void => {
  if (!isEditorElement(box) || box.editor === undefined) {
    throw new TypeError("Not a prompt editor");
  }
  box.editor.chain().focus().insertContent(text).run();
};
