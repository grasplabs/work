// "Last used": the way in chosen last time, kept in this browser only. Only the provider's key is
// stored ("microsoft"), nothing about the person. Storage can be missing or throw (a private
// window, a blocked site): then nothing is read, nothing is kept, and nothing breaks.

/** The key it is kept under, unless the page says another. */
export const lastUsedKey = "grasp-sign-in-last";

/** The event this tab hears when it keeps a provider itself. */
const lastUsedEvent = "grasp-sign-in-last";

/** The provider kept under `key`, or "" for none or no storage. */
export const readLastUsed = (key: string): string => {
  try {
    return window.localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
};

/** Keeps `provider` under `key`; a storage that throws keeps nothing. */
export const writeLastUsed = (key: string, provider: string) => {
  try {
    window.localStorage.setItem(key, provider);
  } catch {
    // Nothing to keep it in.
  }
  // The storage event reaches only other tabs: tell this one too.
  window.dispatchEvent(new Event(lastUsedEvent));
};

/** Calls `changed` when the kept provider may have changed, here or in another tab. */
export const watchLastUsed = (changed: () => void) => {
  window.addEventListener("storage", changed);
  window.addEventListener(lastUsedEvent, changed);
  return () => {
    window.removeEventListener("storage", changed);
    window.removeEventListener(lastUsedEvent, changed);
  };
};

/** On the server, and in the first picture, nothing is kept. */
export const noLastUsed = () => "";
