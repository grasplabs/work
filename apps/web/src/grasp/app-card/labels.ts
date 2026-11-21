/** Every word App card says of its own. The title, description, owner and meta are the caller's. */
export interface AppCardLabels {
  /** The more button's name, before the app's title ("More actions, Tickets"). */
  more: string;
  /** The meta line while the app is first built. */
  building: string;
  /** The window's line when the app did not start. */
  failed: string;
  /** The window when there is no preview yet. */
  empty: string;
  /** The New app card's words: its title and its press. */
  newApp: string;
}

export { englishLabels } from "./words";
