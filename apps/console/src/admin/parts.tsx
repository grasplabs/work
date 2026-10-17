/**
 * Small marks the admin's pages draw what the model counts with, ported
 * from the prototype (grasplabs/prototype `components/admin/admin-parts.tsx`).
 */
import { STAGES } from "@grasp-os/shared/admin/onboarding-admin";
import type {
  LinkState,
  OrgKnowledge,
  PersonView,
  Stage,
  StageStatus,
} from "@grasp-os/shared/admin/onboarding-admin";
import { Avatar, AvatarFallback } from "@grasp-os/ui/components/avatar";
import { cn } from "@grasp-os/ui/lib/utils";
import { CheckIcon } from "lucide-react";
import { Fragment } from "react";
import type { ReactNode } from "react";

/** One number and what it counts. */
export const Tile = ({ value, label }: { value: ReactNode; label: string }) => (
  <div className="bg-card flex flex-col gap-0.5 px-5 py-4">
    <span className="text-2xl leading-tight font-medium tabular-nums">
      {value}
    </span>
    <span className="text-muted-foreground">{label}</span>
  </div>
);

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
  return (
    <span className="flex items-center gap-1">
      <span className="sr-only">{label}</span>
      {Array.from({ length: count }, (_, at) => (
        <Fragment key={at}>
          {at === gate ? (
            <span
              aria-hidden
              className="bg-foreground mx-0.5 block h-3.5 w-px flex-none"
            />
          ) : null}
          <span
            aria-hidden
            className={cn(
              "size-1.5 flex-none rounded-full",
              at < filled ? "bg-foreground" : "bg-border"
            )}
          />
        </Fragment>
      ))}
    </span>
  );
};

/** Something that is in place: a check and a word, in the colour of agreed. */
export const Done = ({ children }: { children: ReactNode }) => (
  <span className="text-muted-foreground flex items-center gap-1.5">
    <CheckIcon aria-hidden className="text-status-agreed size-4 flex-none" />
    {children}
  </span>
);

/** A card of its own on a section: a title, one line on what it is for, what can be done beside them, then its rows. */
export const Panel = ({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children?: ReactNode;
}) => (
  <section className="bg-card overflow-hidden rounded-xl border">
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3 px-5 py-4">
      <div className="flex min-w-0 flex-1 basis-56 flex-col gap-0.5">
        <h2 className="font-medium">{title}</h2>
        {description === undefined ? null : (
          <p className="text-muted-foreground">{description}</p>
        )}
      </div>
      {action}
    </div>
    {children}
  </section>
);

/** One row of a panel: what it is and why on the left, where it stands on the right. */
export const PanelRow = ({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: ReactNode;
}) => (
  <div className="flex flex-col gap-3 border-t px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-8">
    <div className="flex min-w-0 flex-col gap-0.5">
      <span>{label}</span>
      {description === undefined ? null : (
        <p className="text-muted-foreground">{description}</p>
      )}
    </div>
    <div className="flex flex-none sm:w-64 sm:justify-end">{children}</div>
  </div>
);

/** So much of a whole, 0 to 1: nothing of nothing is nothing. */
const shareOf = (value: number, of: number): number =>
  of > 0 ? Math.min(Math.max(value / of, 0), 1) : 0;

/** A circle 100 around, so its dark part is the percentage itself. */
const ringRadius = 15.9155;

/** So much of a whole as a small ring, dark on grey: for a number that is a share of something. */
export const Ring = ({ value, of }: { value: number; of: number }) => {
  const share = shareOf(value, of);
  return (
    <span className="flex-none">
      <span className="sr-only">{`${Math.round(share * 100)}%`}</span>
      <svg aria-hidden className="size-5 -rotate-90" viewBox="0 0 36 36">
        <circle
          className="stroke-border"
          cx="18"
          cy="18"
          fill="none"
          r={ringRadius}
          strokeWidth="4"
        />
        {share > 0 ? (
          <circle
            className="stroke-foreground"
            cx="18"
            cy="18"
            fill="none"
            r={ringRadius}
            strokeDasharray={`${share * 100} 100`}
            strokeLinecap="round"
            strokeWidth="4"
          />
        ) : null}
      </svg>
    </span>
  );
};

/**
 * One number with what it counts, a line under it, and a ring where the
 * number is a share of something, beside the label so the number has the
 * whole tile.
 */
export const Figure = ({
  label,
  value,
  sub,
  ring,
  attention = false,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  ring?: { value: number; of: number };
  attention?: boolean;
}) => (
  <div className="bg-card grid grid-cols-[minmax(0,1fr)_auto] content-start gap-x-2 gap-y-0.5 px-4 py-4 sm:px-5">
    <span className="text-muted-foreground flex min-h-5 items-center text-xs">
      {label}
    </span>
    {ring !== undefined && ring.of > 0 ? (
      <Ring of={ring.of} value={ring.value} />
    ) : null}
    <span className="col-span-2 row-start-2 text-2xl leading-tight font-medium tabular-nums">
      {value}
    </span>
    {sub === undefined ? null : (
      <span
        className={cn(
          "col-span-2 row-start-3 text-xs",
          attention ? "text-status-attention" : "text-muted-foreground"
        )}
      >
        {sub}
      </span>
    )}
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

const dotLegend: readonly [DotMark, string][] = [
  ["talked", "Talked"],
  ["started", "Started"],
  ["not", "Has not talked"],
  ["none", "No link yet"],
];

/** What the dots mean, in the same marks. */
export const DotLegend = () => (
  <ul className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
    {dotLegend.map(([mark, label]) => (
      <li className="flex items-center gap-1.5" key={mark}>
        <Dot mark={mark} />
        {label}
      </li>
    ))}
  </ul>
);
