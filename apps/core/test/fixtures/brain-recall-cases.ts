/**
 * Experiment E02's cases (GRA-304): questions in English and Dutch over
 * the E01 company (brain-corpus.ts), asked of recall itself rather than of
 * an agent, to compare Knowledge's full-text search with hybrid recall,
 * with and without reranking.
 *
 * None is an E01 task: each is worded afresh, so a policy tuned on E01's
 * dev split meets it unseen. Each names the phrase its evidence holds
 * (`marker`), which an arm finds when one of its results quotes it; the
 * arms are scored by where they rank that result. Each case has two
 * inputs: the question as a person words it, and the keywords an agent's
 * tool call would search for (as E01's `fullText` arm searches); every
 * policy is asked both, and compared only with the same input, so a
 * comparison is of policies, not of inputs. Cases a persona may not read
 * the answer to expect nothing, and fail the gate if any arm quotes it.
 *
 * Pinned: a change to a case, or to the corpus under it, is a new
 * {@link brainRecallCasesVersion}, so runs of different versions are never
 * compared.
 */
import type {
  BrainLanguage,
  BrainPersona,
  BrainWindow,
} from "./brain-corpus.ts";

/** Bumped with any change to the cases or to the corpus they ask about. */
export const brainRecallCasesVersion = "2026-10-29.1";

/**
 * What a case tests: an identifier or date the exact lane must keep
 * (`exact`), the words of its source (`keyword`), other words than its
 * source's (`paraphrase`), a question in another language than its source
 * (`crossLanguage`), or a reader who may not read the answer
 * (`unauthorized`).
 */
export const brainRecallKinds = [
  "exact",
  "keyword",
  "paraphrase",
  "crossLanguage",
  "unauthorized",
] as const;
export type BrainRecallKind = (typeof brainRecallKinds)[number];

export interface BrainRecallCase {
  id: string;
  kind: BrainRecallKind;
  language: BrainLanguage;
  persona: BrainPersona;
  /**
   * The corpus as of this window: a `t1` case is asked after its updates,
   * as soon as each is saved, to measure how long until recall finds them.
   */
  window: Extract<BrainWindow, "t0" | "t1">;
  /** The question as a person words it. */
  question: string;
  /**
   * What an agent's tool call would search for instead: a few of the
   * question's own words, so a paraphrase stays one.
   */
  keywords: string;
  /** The phrase the answer's evidence holds; none when it may not be read. */
  marker?: string;
  /** What an outdated or unreadable answer would quote instead. */
  forbidden?: readonly string[];
}

export const brainRecallCases: readonly BrainRecallCase[] = [
  {
    id: "e02-en-order-due",
    kind: "exact",
    language: "en",
    persona: "ana",
    window: "t0",
    question: "When are the trucks on PO-2026-00417 due?",
    keywords: "PO-2026-00417",
    marker: "due on 2026-12-15",
  },
  {
    id: "e02-en-expense-form",
    kind: "exact",
    language: "en",
    persona: "bram",
    window: "t0",
    question: "What is form EXP-FORM-12 used for?",
    keywords: "EXP-FORM-12",
    marker: "using form EXP-FORM-12",
  },
  {
    id: "e02-en-incident-code",
    kind: "exact",
    language: "en",
    persona: "ana",
    window: "t0",
    question: "What does incident INC-7 stand for?",
    keywords: "INC-7",
    marker: "temperature excursion",
  },
  {
    id: "e02-en-supplier-hours",
    kind: "keyword",
    language: "en",
    persona: "bram",
    window: "t0",
    question: "At what times does Kranich GmbH deliver?",
    keywords: "Kranich deliver",
    marker: "between 06:00 and 09:00",
  },
  {
    id: "e02-en-dispatch-alerts",
    kind: "paraphrase",
    language: "en",
    persona: "bram",
    window: "t0",
    question: "Where do warnings about the dispatch servers end up?",
    keywords: "dispatch servers warnings",
    marker: "on-call channel ops-oncall",
  },
  {
    id: "e02-en-claim-signoff",
    kind: "paraphrase",
    language: "en",
    persona: "ana",
    window: "t0",
    question: "Who has to sign off a large expense claim?",
    keywords: "expense claim sign off",
    marker: "cost-centre lead",
  },
  {
    id: "e02-en-route-weekday",
    kind: "keyword",
    language: "en",
    persona: "ana",
    window: "t0",
    question: "On which weekday does route plan RP-2026-44 leave?",
    keywords: "RP-2026-44",
    marker: "departs on Tuesdays",
  },
  {
    id: "e02-en-fuel-budget",
    kind: "keyword",
    language: "en",
    persona: "bram",
    window: "t0",
    question: "How large is the fuel budget for Q4?",
    keywords: "Q4 fuel budget",
    marker: "EUR 412,000",
  },
  {
    id: "e02-en-forklift-checks",
    kind: "crossLanguage",
    language: "en",
    persona: "bram",
    window: "t0",
    question: "How often is each forklift inspected?",
    keywords: "forklift inspected",
    marker: "alle 90 Tage",
  },
  {
    id: "e02-en-route-not-allowed",
    kind: "unauthorized",
    language: "en",
    persona: "bram",
    window: "t0",
    question: "When does route plan RP-2026-44 depart?",
    keywords: "RP-2026-44",
    forbidden: ["05:30 from Tilburg", "CANARY-PLN-7Q4K"],
  },
  {
    id: "e02-en-lease-owner",
    kind: "exact",
    language: "en",
    persona: "ana",
    window: "t0",
    question: "Who owns contract CR-2024-118?",
    keywords: "CR-2024-118",
    marker: "Owner from 2026-03-01: Tomas Okafor",
  },
  {
    id: "e02-nl-commute-rate",
    kind: "keyword",
    language: "nl",
    persona: "ana",
    window: "t0",
    question: "Hoeveel vergoeding krijg ik per kilometer woon-werkverkeer?",
    keywords: "woon-werkverkeer kilometer",
    marker: "23 cent per kilometer",
  },
  {
    id: "e02-nl-business-trip",
    kind: "paraphrase",
    language: "nl",
    persona: "bram",
    window: "t0",
    question: "Hoe lang heb ik om een dienstreis te declareren?",
    keywords: "dienstreis declareren",
    marker: "binnen dertig dagen",
  },
  {
    id: "e02-nl-ticket-code",
    kind: "exact",
    language: "nl",
    persona: "ana",
    window: "t0",
    question: "Waarvoor gebruik ik ticketcode FAC-311?",
    keywords: "FAC-311",
    marker: "meld gladheid via ticketcode FAC-311",
  },
  {
    id: "e02-nl-broken-pallets",
    kind: "paraphrase",
    language: "nl",
    persona: "bram",
    window: "t0",
    question: "Waar laat ik pallets die stuk zijn?",
    keywords: "pallets stuk",
    marker: "container C-12",
  },
  {
    id: "e02-nl-parking-fee",
    kind: "keyword",
    language: "nl",
    persona: "ana",
    window: "t0",
    question: "Wat kost parkeren op terrein P2 per dag?",
    keywords: "terrein P2 parkeren",
    marker: "3 euro per dag",
  },
  {
    id: "e02-nl-night-roster",
    kind: "keyword",
    language: "nl",
    persona: "ana",
    window: "t0",
    question: "Hoeveel chauffeurs staan op het nachtrooster van week 47?",
    keywords: "nachtrooster week 47",
    marker: "9 chauffeurs",
  },
  {
    id: "e02-nl-german-tolls",
    kind: "keyword",
    language: "nl",
    persona: "bram",
    window: "t0",
    question: "Hoeveel waren de tolkosten in Duitsland in september?",
    keywords: "tolkosten Duitsland",
    marker: "18.240 euro",
  },
  {
    id: "e02-nl-tolls-not-allowed",
    kind: "unauthorized",
    language: "nl",
    persona: "ana",
    window: "t0",
    question: "Wat waren de tolkosten in Duitsland in september?",
    keywords: "tolkosten Duitsland",
    forbidden: ["18.240", "CANARY-FIN-3L7Z"],
  },
  {
    id: "e02-nl-commute-rate-updated",
    kind: "keyword",
    language: "nl",
    persona: "ana",
    window: "t1",
    question: "Hoeveel vergoeding krijg ik per kilometer woon-werkverkeer?",
    keywords: "woon-werkverkeer kilometer",
    marker: "25 cent per kilometer",
    forbidden: ["23 cent per kilometer"],
  },
  {
    id: "e02-en-lease-owner-updated",
    kind: "exact",
    language: "en",
    persona: "ana",
    window: "t1",
    question: "Who owns contract CR-2024-118?",
    keywords: "CR-2024-118",
    marker: "Owner from 2026-10-01: Marta Ruiz",
  },
];
