import { Card } from "@grasp-os/ui/components/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
} from "@grasp-os/ui/components/empty";
import type { ReactNode } from "react";

import { PageHeader } from "../grasp/page-header/index.ts";

// A page's body and heading, as the prototype has them
// (`components/page.tsx`).

/**
 * The page body: centred, generous whitespace. Its foot leaves room for
 * the chat box, so the last row of a page is never under it. Its text is
 * the body's 16px, as the prototype's page: a smaller part says so itself.
 */
export const Page = ({
  children,
  wide = false,
}: {
  children: ReactNode;
  wide?: boolean;
}) => (
  <div
    className={
      wide
        ? "pb-chat mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 pt-7"
        : "pb-chat mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 pt-7"
    }
  >
    {children}
  </div>
);

/**
 * Every page's heading, the one way to head a page: Grasp UI's PageHeader
 * (grasp/page-header), with the page's title, one quiet line under it, and
 * the page's actions at the end of the title row; `clamp` keeps a description someone wrote to two lines.
 */
export const PageHeading = ({
  title,
  description,
  clamp = false,
  meta,
  action,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** At most two lines of `description`, for a description someone wrote. */
  clamp?: boolean;
  /** Beside the title: a mark that says where its subject stands, such as a status. */
  meta?: ReactNode;
  action?: ReactNode;
}) => (
  <PageHeader
    title={title}
    {...(description === undefined ? {} : { description })}
    descriptionLines={clamp ? 2 : "all"}
    {...(meta === undefined ? {} : { aside: meta })}
    {...(action === undefined ? {} : { actions: action })}
  />
);

/** A list with nothing in it: one quiet line in a card, where the list would be. */
export const EmptyCard = ({ children }: { children: ReactNode }) => (
  <Card>
    <Empty size="xs">
      <EmptyHeader>
        <EmptyDescription>{children}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  </Card>
);

/**
 * A section title inside a page; with `count`, how many it holds beside
 * it, small and quiet, as the prototype's Integrations lists have it.
 */
export const SectionTitle = ({
  children,
  count,
  id,
}: {
  children: ReactNode;
  count?: string;
  id?: string;
}) =>
  count === undefined ? (
    <h2 className="text-sm font-medium" id={id}>
      {children}
    </h2>
  ) : (
    <h2 className="flex items-baseline gap-2 text-sm font-medium" id={id}>
      {children}
      <span className="text-muted-foreground text-xs font-normal tabular-nums">
        {count}
      </span>
    </h2>
  );
