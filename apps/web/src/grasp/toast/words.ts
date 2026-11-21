// Toaster's own words, in English. The product gives them in its languages through GraspWords
// (src/words); a caller's text props still win until the breaking release's step 5.
export const toasterWords = {
  /** The region's name, for a screen reader. */
  name: "Notifications",
  /** What a toast's action says when its work failed. The toast stays. */
  failed: "Could not finish",
  /** What a screen reader hears once an action has been working for a second. */
  pending: "Still working",
  /** The name of the close button on a toast that stays. */
  close: "Close",
};

export type ToasterWords = typeof toasterWords;

declare module "../words/words" {
  interface GraspWordsCatalog {
    toaster: ToasterWords;
  }
}

/** What it tells a developer: English, for them, and not in the catalogue. */
export const toasterNotices = {
  twice: (where: string[]) =>
    `Toaster: ${String(where.length)} Toasters draw the same toasts (${where.join("; ")}), so each toast shows ${String(where.length)} times and is said ${String(where.length)} times. Keep one <Toaster /> per page, at its root, outside every layer.`,
};
