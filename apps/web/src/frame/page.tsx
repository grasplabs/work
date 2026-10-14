import type { ReactNode } from "react";

// The body of a page as the prototype lays it out (`components/page.tsx`):
// centred, with generous whitespace, a title with one quiet line under it,
// and its actions on the right, which go under the title when there's no
// room beside it.

/** The page body: centred, `wide` for tables and boards. */
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
        ? "mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 py-7 text-sm"
        : "mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-7 text-sm"
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
      <h1 className="text-2xl font-medium tracking-tight">{title}</h1>
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

/** A section title inside a page. */
export const SectionTitle = ({ children }: { children: ReactNode }) => (
  <h2 className="text-sm font-medium">{children}</h2>
);
