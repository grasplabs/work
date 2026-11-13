import { STAGES } from "@grasp-os/shared/admin/onboarding-admin";
import type {
  LinkState,
  OrgKnowledge,
  PersonView,
  Stage,
  StageStatus,
} from "@grasp-os/shared/admin/onboarding-admin";
import { Avatar, AvatarFallback } from "@grasp-os/ui/components/avatar";
import { Progress } from "@grasp-os/ui/components/progress";
/**
 * Small marks the admin's pages draw what the model counts with, ported
 * from the prototype (grasplabs/prototype `components/admin/admin-parts.tsx`).
 */
import { Stat } from "@grasp-os/ui/components/stat";
import { cn } from "@grasp-os/ui/lib/utils";
import { CheckIcon } from "lucide-react";
import { Fragment } from "react";
import type { ReactNode } from "react";

const segment: Record<StageStatus, string> = {
  done: "bg-foreground",
  now: "bg-foreground/45",
  waits: "bg-status-attention",
  later: "bg-border",
};

/** The steps of an onboarding as a short bar: done, in hand, waiting on someone, not yet. */
export const StageBar = ({
  stages,
  label,
}: {
  stages: Record<Stage, StageStatus>;
  label: string;
}) => (
  <span className="flex w-28 gap-0.5">
    <span className="sr-only">{label}</span>
    {STAGES.map((stage) => (
      <span
        aria-hidden
        className={cn("h-1 flex-1 rounded-full", segment[stages[stage]])}
        key={stage}
      />
    ))}
  </span>
);

/** Where the rounding of a share of the dots may land just under a whole one. */
const dotSlack = 1e-9;

/**
 * How much Grasp knows about an organization, in dots: dark for what is
 * in, filling from the left, with a mark at the share where Grasp opens.
 * Dark up to the mark is ready.
 */
export const KnowledgeDots = ({
  knowledge,
  count,
  label,
}: {
  knowledge: Pick<OrgKnowledge, "percent" | "threshold">;
  count: number;
  label: string;
}) => {
  const filled = Math.floor((knowledge.percent / 100) * count + dotSlack);
  const gate = Math.round((knowledge.threshold / 100) * count);
  const mark = (
    <span
      aria-hidden
      className="bg-foreground mx-0.5 block h-3.5 w-px flex-none"
    />
  );
  return (
    <span className="flex items-center gap-1">
      <span className="sr-only">{label}</span>
      {Array.from({ length: count }, (_, at) => (
        <Fragment key={at}>
          {at === gate ? mark : null}
          <span
            aria-hidden
            className={cn(
              "size-1.5 flex-none rounded-full",
              at < filled ? "bg-foreground" : "bg-border"
            )}
          />
        </Fragment>
      ))}
      {/* Where Grasp opens only once every dot is filled, the mark stands after the last. */}
      {gate >= count ? mark : null}
    </span>
  );
};

/**
 * The mark of what needs someone: a small amber dot before the words,
 * which stay in the text's own colour. Amber marks a thing; a sentence
 * set in it is hard to read.
 */
export const AttentionDot = () => (
  <span
    aria-hidden
    className="bg-status-attention size-1.5 flex-none -translate-y-px rounded-full"
  />
);

/** What needs someone, in words: the amber dot, then the words in the text's colour. */
export const Attention = ({
  children,
  className,
}: {
  children: ReactNode;
  /** Where it stands in its layout. */
  className?: string;
}) => (
  <span className={cn("flex items-baseline gap-1.5", className)}>
    <AttentionDot />
    <span className="min-w-0">{children}</span>
  </span>
);

/** Something that is in place: a check and a word, in the colour of agreed. */
export const Done = ({ children }: { children: ReactNode }) => (
  <span className="text-muted-foreground flex items-center gap-1.5">
    <CheckIcon aria-hidden className="text-status-agreed size-4 flex-none" />
    {children}
  </span>
);

/**
 * One number: what it counts over it, and a line under it. The one tile
 * every page shows a figure in. Its three lines stand on the rows of the
 * grid it is in (a subgrid), so across a row of tiles the labels, the
 * numbers and the lines under them line up, however a label wraps.
 */
export const Figure = ({
  label,
  value,
  sub,
  attention = false,
  className,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  attention?: boolean;
  /** Where it stands in its grid. */
  className?: string;
}) => (
  <div
    className={cn(
      "bg-card row-span-3 grid grid-rows-subgrid gap-y-1 px-4 py-4 sm:px-5",
      className
    )}
  >
    <span className="text-muted-foreground self-end text-xs">{label}</span>
    <span className="wrap-break-word hyphens-auto">
      <Stat>{value}</Stat>
    </span>
    <span
      className={cn(
        "text-xs",
        attention ? "text-foreground" : "text-muted-foreground"
      )}
    >
      {attention && sub !== undefined ? (
        <span className="flex items-baseline gap-1.5">
          <AttentionDot />
          <span>{sub}</span>
        </span>
      ) : (
        sub
      )}
    </span>
  </div>
);

/** The first letters of a name's capitalised words, at most two: "Anna de Vries" is "AV". */
const initialsOf = (name: string): string =>
  name
    .split(" ")
    .filter(
      (part) => part !== "" && part.startsWith(part.charAt(0).toUpperCase())
    )
    .map((part) => part.charAt(0))
    .slice(0, 2)
    .join("");

/** Someone as the first letters of their name, in a circle. */
export const Initials = ({ name }: { name: string }) => (
  <Avatar size="sm">
    <AvatarFallback>
      {initialsOf(name) || name.charAt(0).toUpperCase()}
    </AvatarFallback>
  </Avatar>
);

/** How a person shows as a dot: talked, started, has not talked, or has no link yet. */
export type DotMark = "talked" | "started" | "not" | "none";

export const markOf = (state: LinkState): DotMark => {
  if (state === "completed") {
    return "talked";
  }
  if (state === "progress" || state === "incomplete") {
    return "started";
  }
  return state === "waiting" ? "none" : "not";
};

const dot: Record<DotMark, string> = {
  talked: "bg-foreground",
  started: "bg-muted-foreground/60",
  not: "bg-border",
  none: "border border-border",
};

export const Dot = ({ mark }: { mark: DotMark }) => (
  <span
    aria-hidden
    className={cn("size-2 flex-none rounded-full", dot[mark])}
  />
);

const dotOrder: readonly DotMark[] = ["talked", "started", "not", "none"];

/** A team as dots, one a person: who talked, who started, who has not, who has no link yet. */
export const PeopleDots = ({
  people,
  label,
}: {
  people: readonly PersonView[];
  label: string;
}) => (
  <span className="flex flex-wrap gap-1">
    <span className="sr-only">{label}</span>
    {people
      .toSorted(
        (a, b) =>
          dotOrder.indexOf(markOf(a.state)) - dotOrder.indexOf(markOf(b.state))
      )
      .map((each) => (
        <Dot key={each.person.id} mark={markOf(each.state)} />
      ))}
  </span>
);

/**
 * A few things counted, as rows: what each is, a bar as long as its share
 * of the most, and the number. The words take the room they need and the
 * bars start in one line; where the room is short the words are cut,
 * never the bars.
 */
export const BarList = ({
  rows,
  label,
}: {
  rows: { id: string; label: ReactNode; value: number; shown?: string }[];
  label: string;
}) => {
  const most = Math.max(1, ...rows.map((row) => row.value));
  return (
    <ul
      aria-label={label}
      className="grid grid-cols-[minmax(0,max-content)_minmax(5rem,1fr)_minmax(1.5rem,auto)] gap-x-3 gap-y-2.5"
    >
      {rows.map((row) => (
        <li
          className="col-span-3 grid grid-cols-subgrid items-center"
          key={row.id}
        >
          <span className="text-muted-foreground truncate">{row.label}</span>
          <Progress aria-hidden value={(row.value / most) * 100} />
          <span className="text-right tabular-nums">
            {row.shown ?? row.value}
          </span>
        </li>
      ))}
    </ul>
  );
};
