/** Every word App card says of its own. The title, description, owner and meta are the caller's. */
export interface AppCardLabels {
  /** The more button's name, before the app's title ("More actions, Tickets"). */
  more: string;
  /** The meta line while the app is first built. */
  building: string;
  /** The meta line, and the window, when the app did not start. */
  failed: string;
  /** The window when there is no preview yet. */
  empty: string;
}

/** The English words, used for any a caller leaves out. */
export const englishLabels: AppCardLabels = {
  more: "More actions",
  building: "Being built",
  failed: "Didn't start",
  empty: "No preview yet",
};
