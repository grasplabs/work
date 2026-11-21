// Which hover card on the page is open: one at a time. When the pointer moves from one link to the
// next, the card that opens closes the one before it at once, instead of drawing over it while the
// first waits out its close delay (A3-layers-11). A store outside React, read with
// useSyncExternalStore, so every card on the page sees the same answer.
let current: string | null = null;
const listeners = new Set<() => void>();

const tell = () => {
  for (const listener of listeners) {
    listener();
  }
};

/** Watches which card is open; returns how to stop. */
export const watchOpen = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The card open now, or null. */
export const openNow = () => current;

/** On the server no card is open. */
export const openOnServer = (): string | null => null;

/** A card opened or closed: an opening card becomes the one open; a closing one lets it go. */
export const noteOpen = (id: string, open: boolean) => {
  if (open && current !== id) {
    current = id;
    tell();
  } else if (!open && current === id) {
    current = null;
    tell();
  }
};
