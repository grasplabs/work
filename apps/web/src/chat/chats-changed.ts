// A word that the person's chats changed in a way the list shows (an
// answer ended, so a chat no longer works), for whoever lists them (the
// sidebar's chats, chat/sidebar-chats.tsx) to read them again. Said by the
// open chat as its answer ends (global-chat.tsx).

const changed = "grasp-chats-changed";

/** Says the chats changed. */
export const tellChatsChanged = (): void => {
  document.dispatchEvent(new Event(changed));
};

/** Calls `onChange` when the chats changed. Returns how to stop. */
export const onChatsChanged = (onChange: () => void): (() => void) => {
  document.addEventListener(changed, onChange);
  return () => {
    document.removeEventListener(changed, onChange);
  };
};
