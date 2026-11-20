/** Why someone is on the sign-in page again, each said in one line over the buttons. */
export interface SignInNoticeWords {
  /** Plain: the session ended. */
  ended: string;
  /** Plain: the product is not open to everyone yet. */
  soon: string;
  /** Plain: there is no connection. */
  offline: string;
  /** A refusal: the account is not in the organisation. */
  notMember: string;
  /** A refusal: a guest account. */
  guest: string;
  /** A refusal: the provider took too long. */
  timedOut: string;
  /** A refusal: no access to the organisation. */
  noAccess: string;
  /** A refusal: Grasp cannot be reached. */
  unreachable: string;
}

/** Every word the sign-in page shows or says of its own. */
export interface SignInWords {
  /** The name beside Grasp's mark at the top start. */
  brand: string;
  /** The page's one title. */
  title: string;
  /** A way in, from the provider's name ("Continue with Microsoft"). */
  way: (provider: string) => string;
  /** Said to a screen reader while the page leaves for the provider ("Opening Microsoft"). */
  leaving: (provider: string) => string;
  /** Said once the provider has opened. */
  opened: string;
  /** Said when the provider did not open. */
  notOpened: string;
  /** The tag on the way used last time in this browser. */
  lastUsed: string;
  /** Grasp staff's own way in. */
  staff: string;
  /** The staff page's title. */
  staffTitle: string;
  /** The guest page's title. */
  guestTitle: string;
  /** The quiet link at the top end. */
  back: string;
  /** The line at the foot, before its link. */
  foot: string;
  /** The foot line's link. */
  footAction: string;
  /** The lines that say why someone is back. */
  notices: SignInNoticeWords;
}

export const signInWords: SignInWords = {
  brand: "Grasp",
  title: "Log in",
  way: (provider) => `Continue with ${provider}`,
  leaving: (provider) => `Opening ${provider}`,
  opened: "Opened",
  notOpened: "Did not open",
  lastUsed: "Last used",
  staff: "Continue with Grasp staff",
  staffTitle: "Grasp staff",
  guestTitle: "Talk to Grasp",
  back: "Back to Grasp",
  foot: "New to Grasp?",
  footAction: "Talk to us",
  notices: {
    ended: "Your session ended. Log in to carry on.",
    soon: "Grasp opens for everyone soon. If you have an interview link, it is in your email.",
    offline: "You're offline. Log in when you're back online.",
    notMember: "That account isn't part of your organisation.",
    guest: "Guest accounts can't log in.",
    timedOut: "Sign-in timed out. Try again.",
    noAccess: "You don't have access to this organisation. Ask an admin.",
    unreachable: "Grasp can't be reached right now. Try again in a minute.",
  },
};

declare module "../words/words" {
  interface GraspWordsCatalog {
    signIn: SignInWords;
  }
}
