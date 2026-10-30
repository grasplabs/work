import { PageHeaderTitle } from "@grasp-os/ui/components/page-header";
import type { ReactNode } from "react";

// A page's body and heading, as the prototype has them
// (`components/page.tsx`).

/**
 * The page body: centred, generous whitespace. Its foot leaves room for
 * the chat box, so the last row of a page is never under it.
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
        ? "pb-chat mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 pt-7 text-sm"
        : "pb-chat mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 pt-7 text-sm"
    }
  >
    {children}
  </div>
);

/** Title, one quiet line under it, and the page's actions on the right. */
export const PageHeading = ({
  title,
  description,
  meta,
  action,
}: {
  title: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  action?: ReactNode;
}) => (
  <div className="flex flex-wrap items-end gap-3">
    {/* A width of its own, so actions beside it go to the next line rather than squeezing it. */}
    <div className="flex min-w-0 flex-1 basis-64 flex-col gap-1">
      <PageHeaderTitle>{title}</PageHeaderTitle>
      {description === undefined ? null : (
        <p className="text-muted-foreground text-sm">{description}</p>
      )}
      {meta === undefined ? null : (
        <div className="mt-1 flex flex-wrap gap-1.5">{meta}</div>
      )}
    </div>
    {action === undefined ? null : (
      <div className="ml-auto flex items-center gap-2">{action}</div>
    )}
  </div>
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
