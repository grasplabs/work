// An app's state from its accounts', and whether it needs someone: the one rule the tile, the panel,
// the page's header and a page's summary share.
import type { App, AppState } from "./model";

/**
 * An app's state from its accounts' states: `works` when every one works; when none works, the
 * first that ran out (`sign-in` before `reconnect`); otherwise `needs-you`. Undefined with none.
 */
export const rollUp = (states: readonly AppState[]): AppState | undefined => {
  if (states.length === 0) {
    return undefined;
  }
  if (states.every((state) => state === "works")) {
    return "works";
  }
  if (states.includes("works") || states.includes("needs-you")) {
    return "needs-you";
  }
  return states.includes("sign-in") ? "sign-in" : "reconnect";
};

/** Whether an app needs someone: one of its accounts ran out or must be connected again. */
export const needsYou = (app: App) =>
  app.connection !== undefined && app.connection.state !== "works";
