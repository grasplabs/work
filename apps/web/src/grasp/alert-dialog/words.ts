// Alert dialog's own words, in English. The product gives them in its languages through GraspWords
// (src/words).
export const alertDialogWords = {
  /** The safe answer AlertDialogCancel gives when it is given no words of its own. */
  cancel: "Cancel",
};

export type AlertDialogWords = typeof alertDialogWords;

declare module "../words/words" {
  interface GraspWordsCatalog {
    alertDialog: AlertDialogWords;
  }
}
