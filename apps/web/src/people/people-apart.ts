import { i18n } from "@lingui/core";
import type { I18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";

// Telling apart people of the same name, wherever people are listed by
// name: someone whose name another person on the page shares is told
// apart by the end of their ID. Core tells anyone but an admin no more of
// a person than their name and ID (app-members.ts `shareCandidates`,
// workflow-share-candidates.ts): their address, role and teams aren't
// theirs to read. The ID is already what a share names, so its end says
// nothing new, and it is the same for that person in every list, for
// admins too, and over time, unlike a count ("Eva (2)") that shifts as
// people come and go, or an email only some pages have.

/** Someone listed by name. */
export interface Named {
  id: string;
  name: string;
}

/** How many of the end of an ID tell a namesake apart. */
const idEndLength = 6;

/** Characters a page shows nothing of: zero-width spaces, joiners. */
const invisible = /\p{Cf}/gu;

/** A run of spaces, which a page shows as one. */
const spaces = /\s+/gu;

/**
 * A name as namesakes are compared: as a page shows it, apart from how
 * its letters are encoded, invisible characters, runs of spaces and case.
 */
const nameKey = (name: string): string =>
  name
    .normalize("NFKC")
    .replace(invisible, "")
    .replace(spaces, " ")
    .trim()
    .toLocaleLowerCase();

/** What tells people of the same name apart (`usePeopleApart`). */
export interface PeopleApart {
  /** What tells `person` apart; undefined when their name is theirs alone. */
  hint: (person: Named) => string | undefined;
  /** `person`'s name, and what tells them apart when they need it. */
  named: (person: Named) => string;
}

/**
 * Telling apart, among `among`, those of the same name. `among` is
 * everyone the page shows or offers, not only who is left to pick, so
 * someone is told apart from a namesake who already has a role too.
 * Outside a component, in `language`; a component uses `usePeopleApart`.
 */
export const peopleApart = (
  among: readonly Named[],
  language: I18n = i18n
): PeopleApart => {
  const seen = new Set<string>();
  const shared = new Set<string>();
  // Each person once, though lists the page merges both hold them.
  const people = new Map(among.map((each) => [each.id, each.name] as const));
  for (const name of people.values()) {
    const key = nameKey(name);
    if (seen.has(key)) {
      shared.add(key);
    }
    seen.add(key);
  }
  const hint = (person: Named): string | undefined => {
    if (!shared.has(nameKey(person.name))) {
      return undefined;
    }
    const end = person.id.slice(-idEndLength);
    return language._(msg`ID …${end}`);
  };
  return {
    hint,
    named: (person) => {
      const { name } = person;
      const apart = hint(person);
      return apart === undefined ? name : language._(msg`${name} (${apart})`);
    },
  };
};

/** `peopleApart` in a component, said again when its language changes. */
export const usePeopleApart = (among: readonly Named[]): PeopleApart => {
  const { i18n: language } = useLingui();
  return peopleApart(among, language);
};
