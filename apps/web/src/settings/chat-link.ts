// A chat link the person opened (`/chat-link#<secret>`), kept for the tab
// (session storage) until they confirm or turn it down in Settings ›
// Security: so it outlasts the sign-in it may need first, and is never in
// the address bar, the history or a request. Opening it links nothing.

const key = "grasp.chat-link";

/** The secret of the link the person opened in this tab, if any. */
export const pendingChatLink = (): string | undefined => {
  try {
    return sessionStorage.getItem(key) ?? undefined;
  } catch {
    // A private window may refuse storage: nothing waits.
    return undefined;
  }
};

/** Keeps `secret` for Settings › Security to offer; an empty one keeps nothing. */
export const keepChatLink = (secret: string): void => {
  if (secret === "") {
    return;
  }
  try {
    sessionStorage.setItem(key, secret);
  } catch {
    // See `pendingChatLink`: the link offers nothing in this window.
  }
};

/** Forgets the link: confirmed, turned down, or linking nothing. */
export const forgetChatLink = (): void => {
  try {
    sessionStorage.removeItem(key);
  } catch {
    // Nothing was kept.
  }
};
