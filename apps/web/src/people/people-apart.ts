import { useLingui } from "@lingui/react/macro";

// Telling apart people of the same name, wherever people are listed by
// name. Someone whose name another person on the page shares is told
// apart by their email where the page has it, which only an admin's does,
// else by the end of their ID. Core tells anyone but an admin no more of
// a person than their name and ID (app-members.ts `shareCandidates`,
// workflow-share-candidates.ts): their address, role and teams aren't
// theirs to read. The ID is already what a share names, so its end says
// nothing new, and it is the same for that person in every list and over
// time, unlike a count ("Eva (2)") that shifts as people come and go.

/** Someone listed by name. */
export interface Named {
  id: string;
  name: string;
  /** Only in an admin's lists. */
  email?: string;
}

/** How many of the end of an ID tell a namesake apart. */
const idEndLength = 6;

/** A name as namesakes are compared: apart from case and outer spaces. */
const nameKey = (name: string): string => name.trim().toLocaleLowerCase();

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
 */
export const usePeopleApart = (among: readonly Named[]): PeopleApart => {
  const { t } = useLingui();
  const seen = new Set<string>();
  const shared = new Set<string>();
  for (const { name } of among) {
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
    return person.email ?? t`ID …${end}`;
  };
  return {
    hint,
    named: (person) => {
      const { name } = person;
      const apart = hint(person);
      return apart === undefined ? name : t`${name} (${apart})`;
    },
  };
};
