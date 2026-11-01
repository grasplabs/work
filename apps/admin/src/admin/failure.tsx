/**
 * How every admin page fails, finds nothing and loads, the same as the
 * workspace's (apps/web/src/frame/page-states.tsx): an empty state with
 * its icon that says what happened, a way to try again or a way back,
 * and skeletons while a slow read comes. Never the router's own pages.
 * Every route takes `RouteFailure` (src/router.tsx), so a section that
 * fails shows it where the section would be, under its organization's
 * column and the admin's sidebar, which keep working; only a frame that
 * can't be read at all shows `FrameFailure` in its place.
 */
import { Button, buttonVariants } from "@grasp-os/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import { Skeleton } from "@grasp-os/ui/components/skeleton";
import { Link, useMatch, useRouter } from "@tanstack/react-router";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { RotateCcwIcon, SearchXIcon, TriangleAlertIcon } from "lucide-react";

import { AdminHeader } from "./page.tsx";
import type { Crumb } from "./page.tsx";

/**
 * Reads the page again and shows it anew: its loaders run again, and
 * what failed while rendering is rendered again.
 */
const TryAgain = ({ reset }: { reset: () => void }) => {
  const router = useRouter();
  return (
    <Button
      onClick={() => {
        reset();
        void router.invalidate();
      }}
    >
      <RotateCcwIcon data-icon="inline-start" />
      Try again
    </Button>
  );
};

/**
 * The way back from a page that isn't there or didn't load: a link that
 * looks like a button, announced as the link it is.
 */
const Back = ({ label, to }: { label: string; to: BackTo }) => (
  <Link className={buttonVariants({ variant: "outline" })} to={to}>
    {label}
  </Link>
);

/** Where a page that isn't there leads back to. */
type BackTo = "/" | "/platform/rollouts";

/**
 * The level of a failure's title, as the workspace's `ErrorState` has it:
 * `h1` where it stands for the whole page, `h2` under a section's own
 * heading (an organization's, whose page keeps its title and column).
 */
type FailureHeading = "h1" | "h2";

/** What failed, said plainly, with a way to try again. */
export const FailureState = ({
  reset,
  heading: Heading = "h2",
}: {
  reset: () => void;
  heading?: FailureHeading;
}) => (
  <Empty role="alert">
    <EmptyHeader>
      <EmptyMedia variant="icon">
        <TriangleAlertIcon />
      </EmptyMedia>
      <EmptyTitle>
        <Heading>This couldn’t be shown</Heading>
      </EmptyTitle>
      <EmptyDescription>
        Reading it failed just now. The rest of the admin still works.
      </EmptyDescription>
    </EmptyHeader>
    <EmptyContent>
      <TryAgain reset={reset} />
    </EmptyContent>
  </Empty>
);

/** Where an organization's sections are: under its own page, which stays. */
const sectionRoutes = "/organizations/$clientId/";

/**
 * A route that failed, said plainly where it would be: in an
 * organization's section, under its page's title and column; any other,
 * a whole page, so under the bar with the sidebar's trigger, as its `h1`.
 */
export const RouteFailure = ({ reset }: ErrorComponentProps) => {
  const failed: string = useMatch({ strict: false }).routeId ?? "";
  if (failed.startsWith(sectionRoutes)) {
    return <FailureState reset={reset} />;
  }
  return (
    <>
      <AdminHeader page="This page didn’t load" />
      <FailureState heading="h1" reset={reset} />
    </>
  );
};

/** The admin's frame itself couldn't be read: said plainly, with a way back. */
export const FrameFailure = ({ reset }: ErrorComponentProps) => (
  <main className="flex min-h-svh p-6">
    <Empty role="alert">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <TriangleAlertIcon />
        </EmptyMedia>
        <EmptyTitle>
          <h1>The admin couldn’t be read</h1>
        </EmptyTitle>
        <EmptyDescription>
          Reading it failed just now. Try again in a moment.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <div className="flex flex-wrap justify-center gap-2">
          <TryAgain reset={reset} />
          <Back label="Back to the admin" to="/" />
        </div>
      </EmptyContent>
    </Empty>
  </main>
);

/**
 * What isn't there, under the bar with the pages above it (`parents`):
 * `title` says what wasn't found, and `back` leads to where it would be.
 */
export const NotFoundPage = ({
  title,
  description,
  parents,
  back,
}: {
  title: string;
  description: string;
  parents?: readonly Crumb[];
  back: { label: string; to: BackTo };
}) => (
  <>
    <AdminHeader page="Not found" parents={parents} />
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <SearchXIcon />
        </EmptyMedia>
        <EmptyTitle>
          <h1>{title}</h1>
        </EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Back label={back.label} to={back.to} />
      </EmptyContent>
    </Empty>
  </>
);

/** A page there isn't, in the admin's frame. */
export const NotFound = () => (
  <NotFoundPage
    back={{ label: "Back to the admin", to: "/" }}
    description="There's no such page. The address may be wrong, or the page was moved or removed."
    title="This page is not here"
  />
);

/**
 * What a page shows while a slow read comes: the bar, and the pages'
 * usual layout (a heading, a line under it, then its content) as
 * skeletons, announced once as loading.
 */
export const PageLoading = () => (
  <>
    <AdminHeader page={undefined} />
    <output
      aria-busy="true"
      aria-label="Loading…"
      className="flex flex-col gap-6 p-6"
    >
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <div className="flex w-full flex-col gap-2">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    </output>
  </>
);
