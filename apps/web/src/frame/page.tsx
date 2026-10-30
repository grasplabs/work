import {
  PageHeader,
  PageHeaderActions,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderMeta,
  PageHeaderTitle,
} from "@grasp-os/ui/components/page-header";
import type { ReactNode } from "react";

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
 * Every page's heading, the one way to head a page: its title, one quiet
 * line under it (at most two lines with `clamp`, for a description someone
 * wrote), small marks such as a status (`meta`), and the page's actions on
 * the right. Built of the kit's `PageHeader` parts alone.
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
  clamp?: boolean;
  meta?: ReactNode;
  action?: ReactNode;
}) => (
  <PageHeader>
    <PageHeaderContent>
      <PageHeaderTitle>{title}</PageHeaderTitle>
      {description === undefined ? null : (
        <PageHeaderDescription lines={clamp ? "two" : "all"}>
          {description}
        </PageHeaderDescription>
      )}
      {meta === undefined ? null : <PageHeaderMeta>{meta}</PageHeaderMeta>}
    </PageHeaderContent>
    {action === undefined ? null : (
      <PageHeaderActions>{action}</PageHeaderActions>
    )}
  </PageHeader>
);

/** A section title inside a page. */
export const SectionTitle = ({ children }: { children: ReactNode }) => (
  <h2 className="text-sm font-medium">{children}</h2>
);
