import type {
  MemberState,
  OrganizationPerson,
  OrganizationWork,
} from "@grasp-os/shared/onboarding-organization";
import { cn } from "@grasp-os/ui/lib/utils";
import { useLingui } from "@lingui/react/macro";

import { stateTitles } from "./organization-words.ts";

// What the organization page draws (prototype `components/admin/admin-parts.tsx`):
// someone as a dot by where they stand, a team's people as a row of dots,
// and its work as a bar split by each piece's part of the team's time.

const dotClass: Record<MemberState, string> = {
  out: "border border-dashed",
  away: "border border-dashed",
  waiting: "bg-border",
  sent: "bg-muted-foreground",
  opened: "bg-muted-foreground",
  started: "bg-foreground",
  talked: "bg-status-agreed",
};

/** Where someone stands, as a dot. */
export const StateDot = ({ state }: { state: MemberState }) => (
  <span
    aria-hidden="true"
    className={cn("size-2 flex-none rounded-full", dotClass[state])}
  />
);

/** A team's people as dots, each by where they stand, named for screen readers. */
export const PeopleDots = ({
  people,
}: {
  people: readonly OrganizationPerson[];
}) => {
  const { i18n } = useLingui();
  return (
    <ul className="flex flex-wrap gap-1">
      {people.map((person) => (
        <li
          key={person.id}
          title={`${person.name}: ${i18n._(stateTitles[person.state])}`}
        >
          <StateDot state={person.state} />
          <span className="sr-only">
            {person.name}: {i18n._(stateTitles[person.state])}
          </span>
        </li>
      ))}
    </ul>
  );
};

/** Each piece of work's place on the bar, in percent of its width. */
const partsOf = (
  works: readonly OrganizationWork[]
): { id: string; x: number; share: number; nobody: boolean }[] => {
  const total = works.reduce((sum, { share }) => sum + Math.max(share, 0), 0);
  const parts: { id: string; x: number; share: number; nobody: boolean }[] = [];
  let at = 0;
  for (const work of works) {
    const share =
      total > 0 ? (Math.max(work.share, 0) / total) * 100 : 100 / works.length;
    parts.push({ id: work.id, x: at, share, nobody: work.doers.length === 0 });
    at += share;
  }
  return parts;
};

/**
 * A team's work on one bar, each piece its part of the team's time, a
 * piece nobody does in the colour of attention. Drawn as shapes, so each
 * part is the shape's own width and needs no style.
 */
export const WorkBar = ({ works }: { works: readonly OrganizationWork[] }) => {
  const parts = partsOf(works);
  return (
    <svg
      aria-hidden="true"
      className="h-2 w-full overflow-hidden rounded-full"
      preserveAspectRatio="none"
    >
      {parts.map(({ id, x, share, nobody }) => (
        <rect
          className={cn(
            "stroke-card stroke-2",
            nobody ? "fill-status-attention" : "fill-muted-foreground"
          )}
          height="100%"
          key={id}
          width={`${share}%`}
          x={`${x}%`}
        />
      ))}
    </svg>
  );
};
