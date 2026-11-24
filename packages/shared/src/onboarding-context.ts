import type { OAuthProvider } from "./connect.ts";
import type { DocumentSourceId } from "./onboarding-choices.ts";
import type { InterviewLocale } from "./onboarding.ts";

// What the kickoff (core's onboarding/kickoff.ts) told about the company
// that the admin's onboarding speaks of: which suites and places it works
// in, so those are offered first or alone, and a few words about the
// company in each language the onboarding speaks, so Stephen talks about
// its work rather than anyone's. Nothing here but what the kickoff said;
// where it said nothing, the onboarding speaks as it does for anyone.

/** One interview turn as it might go at this company: who answers, Stephen's question, their answer, and how long it takes them. */
export interface ContextExample {
  /** The team or role who answers, as a few words: "Calculation". */
  role: string;
  /** What Stephen asks, in a short sentence. */
  question: string;
  /** What they answer, in one or two short sentences. */
  answer: string;
  /** How long it takes them, as they would say it: "About an hour per bid, three a week." */
  time: string;
}

/** What Stephen says about the company, in one language. */
export interface ContextWords {
  /** What the company does, in one short sentence to its admin: "You build and renovate homes for housing associations." Empty when the kickoff didn't say. */
  business: string;
  /** The kinds of documents its work runs on, as plural nouns, at most four: "calculations", "supplier invoices". */
  documents: string[];
  /** One interview turn tied to the work the kickoff named; null when it named none. */
  example: ContextExample | null;
}

/** The most kinds of documents kept. */
export const contextDocumentsMax = 4;

/** What the onboarding knows of the company from its kickoff. */
export interface OnboardingContext {
  /** The suites the kickoff says the company works in; empty when it named none. */
  suites: OAuthProvider[];
  /** The places for documents the kickoff named; empty when it named none. */
  sources: DocumentSourceId[];
  /** Stephen's words about the company, by language; a language missing has none. */
  words: Partial<Record<InterviewLocale, ContextWords>>;
}

/** Nothing known: the onboarding speaks as it does for anyone. */
export const noContext: OnboardingContext = {
  suites: [],
  sources: [],
  words: {},
};
