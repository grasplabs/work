// Connect app's words, in English, on their own: the product's words
// (frame/part-words.tsx) come with the app, the dialog itself doesn't.

/** Every word the dialog shows or says, beside the app's own (app-integration/words.ts). */
export interface ConnectAppWords {
  title: (app: string) => string;
  titleAgain: (app: string) => string;
  whoUses: string;
  forYou: string;
  forEveryone: string;
  /** Where the sign-in happens, in one line. */
  signInAt: (host: string) => string;
  cancel: string;
  signIn: (app: string) => string;
  /**
   * ConnectAppConsent's: the consent's label, the choice for every tool at once, and its Connect.
   * Optional, so a catalogue from before them still holds; left out, they are English.
   */
  consent?: string;
  allTools?: string;
  connect?: string;
}

/** ConnectAppConsent's own words in English, where a catalogue from before them leaves them out. */
export const consentWords = {
  consent: "Consent",
  allTools: "All tools",
  connect: "Connect",
};

export const connectAppWords: ConnectAppWords = {
  title: (app) => `Connect ${app}`,
  titleAgain: (app) => `Connect ${app} again`,
  whoUses: "Who uses it",
  forYou: "Just you",
  forEveryone: "Everyone",
  signInAt: (host) => `You'll sign in at ${host}.`,
  cancel: "Cancel",
  signIn: (app) => `Sign in to ${app}`,
  ...consentWords,
};

declare module "../../words/words" {
  interface GraspWordsCatalog {
    connectApp: ConnectAppWords;
  }
}
