import { Avatar, AvatarFallback } from "../grasp/avatar/index.ts";
import type { CommandEntry } from "../grasp/command/index.ts";

// The people a picker offers, as entries of the library's list, and how
// what was typed finds them. Who may be picked is core's to decide; the
// list is whoever the page offers.

/** Someone who can be picked. */
export interface Pickable {
  id: string;
  name: string;
  email?: string;
  /** A guest, from outside the company: marked so where they are offered. */
  guest?: true;
}

/**
 * A list's filter: what was typed, found as typed in an option's words
 * (its `keywords`, else its value), never letter by letter: "Eva" never
 * finds "Wouter van den Berg".
 */
export const matchTyped = (
  value: string,
  search: string,
  keywords?: string[]
): number =>
  (keywords === undefined || keywords.length === 0 ? value : keywords.join(" "))
    .toLowerCase()
    .includes(search.trim().toLowerCase())
    ? 1
    : 0;

/** Someone's portrait: their initials. */
const PersonAvatar = ({ name }: { name: string }) => (
  <Avatar decorative name={name} size="xs">
    <AvatarFallback />
  </Avatar>
);

/**
 * One person in the library's list of people to pick from: their portrait
 * and name,
 * found by their name, their email or what tells them apart from a
 * namesake (`usePeopleApart`), which stands under it. Their ID keeps two
 * people of the same name apart.
 */
export const personEntry = (
  person: Pickable,
  hint: string | undefined,
  value = `person:${person.id}`
): CommandEntry => ({
  value,
  label: person.name,
  media: <PersonAvatar name={person.name} />,
  keywords: [person.email ?? "", hint ?? ""],
  ...(hint === undefined ? {} : { description: hint }),
});

/** The entries whose words hold what was typed, as `matchTyped` finds them. */
export const entriesTyped = (
  entries: readonly CommandEntry[],
  query: string
): CommandEntry[] =>
  entries.filter(
    (entry) =>
      matchTyped(entry.label, query, [entry.label, ...(entry.keywords ?? [])]) >
      0
  );
