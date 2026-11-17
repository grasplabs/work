import { attributeRuleOf, entityKinds } from "@grasp-os/brain-next/contract";
import type { EntityKind } from "@grasp-os/brain-next/contract";

import { deDocuments, deProbes } from "./de.ts";
import { enDocuments, enProbes } from "./en.ts";
import { nlDocuments, nlProbes } from "./nl.ts";

// The evaluation of extraction (GRA-1992): short documents of the kinds a
// company uploads, written for the purpose (no client's words, no real
// people or companies), in English, Dutch and German, each with the facts
// a careful person would draw from it, and statements it does NOT support
// to plant among what the checker is shown. Some documents come again: a
// newer version that changes a fact, one that says the same in other
// words, one written so a careless reading draws a wrong fact; and a
// second source that disagrees with the first. What the Brain should hold
// after each is what a later check of new memories against what the Brain
// holds (a real change, a real disagreement, the same fact restated, an
// extraction mistake) would be scored on too.

/** The set's version: change it with any document, fact or probe. */
export const extractionEvalSetVersion = "2026-11-17";

export type EvalLanguage = "en" | "nl" | "de";

/** An entity as a document names it: its kind and one name it writes. */
export interface EvalEntity {
  kind: EntityKind;
  name: string;
}

/**
 * A fact a careful person draws from a document: about an entity, filed
 * under one of its kind's attributes, with its value (as the document
 * writes it; any of several when it can fairly be written more than one
 * way; a date as YYYY-MM-DD) or, for a relation, the entity it relates to;
 * and the words it rests on, copied from the text.
 */
export interface EvalFact {
  about: EvalEntity;
  attribute: string;
  value?: string | readonly string[];
  object?: EvalEntity;
  quote: string;
}

/**
 * A statement the document does not support, planted among what the
 * checker is shown, as the read call would propose it: a value of an
 * attribute (never a relation), a statement, and words of the text that
 * don't say it, so it passes the checks in code and only the checker can
 * refuse it.
 */
export interface EvalPlant {
  about: EvalEntity;
  attribute: string;
  value: string;
  statement: string;
  quote: string;
}

export type EvalDocumentKind =
  | "policy"
  | "minutes"
  | "contract"
  | "process"
  | "email";

export interface EvalDocument {
  id: string;
  language: EvalLanguage;
  kind: EvalDocumentKind;
  /** When it was written, as an ISO date and time. */
  saidAt: string;
  text: string;
  facts: readonly EvalFact[];
  plants: readonly EvalPlant[];
}

/**
 * What a probe is: a newer version of the document that truly changes a
 * fact (`change`), says the same in other words (`restatement`), or is
 * written so a careless reading draws a wrong fact (`trap`); or another
 * source that disagrees with the document (`disagreement`).
 */
export type EvalProbeKind = "change" | "restatement" | "trap" | "disagreement";

export interface EvalProbe {
  id: string;
  kind: EvalProbeKind;
  /** The document it follows, drawn first. */
  base: string;
  /** The newer version, or the other source: its text and its facts. */
  second: Pick<EvalDocument, "saidAt" | "text" | "facts">;
  /** The facts that should stand contested afterwards: a disagreement's two. */
  contested: readonly EvalFact[];
}

export interface ExtractionEvalSet {
  version: string;
  documents: readonly EvalDocument[];
  probes: readonly EvalProbe[];
}

export const extractionEvalSet: ExtractionEvalSet = {
  version: extractionEvalSetVersion,
  documents: [...enDocuments, ...nlDocuments, ...deDocuments],
  probes: [...enProbes, ...nlProbes, ...deProbes],
};

/** Whether a probe's second text is a newer version of its base's source. */
export const isVersionProbe = ({ kind }: EvalProbe): boolean =>
  kind !== "disagreement";

/** A date as a fact's value holds one. */
const dayPattern = /^\d{4}-\d{2}-\d{2}$/u;

/** Whether `value` is a date (YYYY-MM-DD). */
export const isDay = (value: string): boolean => dayPattern.test(value);

/** The values a fact accepts. */
export const valuesOf = ({ value }: Pick<EvalFact, "value">): string[] =>
  value === undefined ? [] : [value].flat();

/** What is wrong with `fact` in `text`, if anything. */
const factProblems = (where: string, text: string, fact: EvalFact) => {
  const problems: string[] = [];
  const rule = attributeRuleOf(fact.about.kind, fact.attribute);
  if (!entityKinds.includes(fact.about.kind) || rule === undefined) {
    problems.push(`${where}: ${fact.about.kind} has no ${fact.attribute}`);
  }
  if (!text.includes(fact.quote)) {
    problems.push(`${where}: quote not in the text: ${fact.quote}`);
  }
  for (const entity of [fact.about, ...(fact.object ? [fact.object] : [])]) {
    if (!text.includes(entity.name)) {
      problems.push(`${where}: name not in the text: ${entity.name}`);
    }
  }
  const relates = rule?.relation !== undefined;
  if (relates !== (fact.object !== undefined)) {
    problems.push(
      `${where}: a relation names an entity, and nothing else does`
    );
  }
  if (
    fact.object !== undefined &&
    !(rule?.relation ?? []).includes(fact.object.kind)
  ) {
    problems.push(
      `${where}: ${fact.attribute} doesn't relate to a ${fact.object.kind}`
    );
  }
  if (!relates && valuesOf(fact).length === 0) {
    problems.push(`${where}: no value`);
  }
  return problems;
};

/**
 * What is wrong with the set: a quote or a name its text doesn't hold, an
 * attribute its kind lacks, a relation without its entity, a plant on a
 * relation, a probe of a document the set lacks, ids twice. A run checks
 * it before it asks anything.
 */
export const setProblems = ({
  documents,
  probes,
}: ExtractionEvalSet): string[] => {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const { id } of [...documents, ...probes]) {
    if (ids.has(id)) {
      problems.push(`${id}: id given twice`);
    }
    ids.add(id);
  }
  for (const document of documents) {
    for (const fact of document.facts) {
      problems.push(...factProblems(document.id, document.text, fact));
    }
    for (const plant of document.plants) {
      problems.push(
        ...factProblems(`${document.id} (plant)`, document.text, plant)
      );
    }
  }
  for (const probe of probes) {
    const base = documents.find(({ id }) => id === probe.base);
    if (base === undefined) {
      problems.push(`${probe.id}: no document ${probe.base}`);
      continue;
    }
    for (const fact of probe.second.facts) {
      problems.push(...factProblems(probe.id, probe.second.text, fact));
    }
    const both = new Set([...base.facts, ...probe.second.facts]);
    for (const fact of probe.contested) {
      if (!both.has(fact)) {
        problems.push(`${probe.id}: a contested fact neither text gives`);
      }
    }
    if ((probe.kind === "disagreement") !== probe.contested.length > 0) {
      problems.push(`${probe.id}: only a disagreement leaves facts contested`);
    }
  }
  return problems;
};
