import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@grasp-os/ui/components/card";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

// The blocks of an app's pages, as the prototype draws them
// (`components/landscape/section.tsx`).

/**
 * One block on an app page: a card with a title, an optional line under it
 * and an optional action on the right. Every tab of an app is a stack of
 * these.
 */
export const Section = ({
  id,
  title,
  description,
  action,
  children,
}: {
  id?: string;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
}) => (
  <Card className="scroll-mt-20" id={id}>
    <CardHeader>
      {/* The title and its line stay in the first column, also where what can be done has moved under them. */}
      <CardTitle className="col-start-1">{title}</CardTitle>
      {description === undefined ? null : (
        <CardDescription className="col-start-1">{description}</CardDescription>
      )}
      {/* In a narrow card what can be done goes under the title, rather than beside it and out of the card. */}
      {action === undefined ? null : (
        <CardAction className="@max-sm/card-header:col-start-1 @max-sm/card-header:row-span-1 @max-sm/card-header:row-start-auto @max-sm/card-header:justify-self-start">
          {action}
        </CardAction>
      )}
    </CardHeader>
    {children === undefined ? null : <CardContent>{children}</CardContent>}
  </Card>
);

export interface Fact {
  label: string;
  icon?: LucideIcon;
  value: ReactNode;
}

const factRow =
  "flex min-h-10 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b py-2 last:border-b-0";

/** Label and value pairs, in one or two columns, with a line between rows. */
export const Facts = ({
  facts,
  columns = 1,
}: {
  facts: readonly Fact[];
  columns?: 1 | 2;
}) => (
  // One column that is as wide as the card and no wider: left to itself a grid grows to its longest row, and the values end up outside the card.
  <dl
    className={
      columns === 2
        ? "grid grid-cols-1 gap-x-8 sm:grid-cols-2"
        : "grid grid-cols-1"
    }
  >
    {facts.map(({ label, icon: Icon, value }) => (
      <div
        className={
          columns === 2
            ? `${factRow} sm:[&:nth-last-child(2):nth-child(odd)]:border-b-0`
            : factRow
        }
        key={label}
      >
        {/* With no room for both on one line, the value goes under what it is the value of. */}
        <dt className="text-muted-foreground flex items-center gap-2">
          {Icon === undefined ? null : (
            <Icon aria-hidden="true" className="size-4" />
          )}
          {label}
        </dt>
        <dd className="ml-auto flex max-w-full min-w-0 items-center justify-end gap-2 text-right">
          {value}
        </dd>
      </div>
    ))}
  </dl>
);
