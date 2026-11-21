// One Escape does one thing (the product's row 52): a layer of the Composer's (a menu, the model
// picker) closes on Escape, and no listener of the host's on the document hears that Escape and
// closes more, such as the whole chat. The layer's own handler has run by the time this does.
import type { KeyboardEvent } from "react";

/** Keeps an Escape the layer handled from going on to the page. */
export const stopEscape = (event: KeyboardEvent<HTMLElement>) => {
  if (event.key === "Escape") {
    event.stopPropagation();
  }
};
