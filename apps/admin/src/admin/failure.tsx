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
import { Button } from "@grasp-os/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import { Skeleton } from "@grasp-os/ui/components/skeleton";
import { Icon, RefreshCwIcon } from "@grasp-os/ui/lib/icons";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { Link, useMatch, useRouter } from "@tanstack/react-router";
import type { ErrorComponentProps } from "@tanstack/react-router";

import { AdminHeader } from "./page.tsx";
import type { Crumb } from "./page.tsx";

const styles = stylex.create({
  // The frame couldn't be read: the window, with the page's room round it.
  frameless: {
    display: "flex",
    boxSizing: "border-box",
    minHeight: "100svh",
    padding: space["6"],
  },
  // A state that is the whole page fills it, its words in the middle.
  whole: { flexGrow: 1 },
  buttons: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: space["2"],
  },
  // The pages' usual layout while they load: a heading and its line, then
  // a few lines of content.
  loading: {
    display: "flex",
    flexDirection: "column",
    gap: space["6"],
    padding: space["6"],
  },
  lines: { display: "flex", flexDirection: "column", gap: space["2"] },
  title: { width: "12rem", height: space["8"] },
  lead: { width: "18rem", maxWidth: "100%" },
  short: { width: "66%" },
});

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
      <Icon icon={RefreshCwIcon} />
      Try again
    </Button>
  );
};

/**
 * The way back from a page that isn't there or didn't load: a link that
 * looks like a button, announced as the link it is.
 */
const Back = ({ label, to }: { label: string; to: BackTo }) => (
  <Button asChild variant="outline">
    <Link to={to}>{label}</Link>
  </Button>
);

/** Where a page that isn't there leads back to. */
type BackTo = "/";

/**
 * The level of a failure's title, as the workspace's `ErrorState` has it:
 * `h1` where it stands for the whole page, `h2` under a section's own
 * heading (an organization's, whose page keeps its title and column).
 */
type FailureHeading = 1 | 2;

/** What failed, said plainly, with a way to try again. */
export const FailureState = ({
  reset,
  heading = 2,
}: {
  reset: () => void;
  heading?: FailureHeading;
}) => (
  <Empty
    size={heading === 1 ? "lg" : "default"}
    style={heading === 1 ? styles.whole : undefined}
    variant="destructive"
  >
    <EmptyHeader>
      <EmptyMedia variant="icon" />
      <EmptyTitle level={heading}>This couldn’t be shown</EmptyTitle>
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
      <FailureState heading={1} reset={reset} />
    </>
  );
};

/** The admin's frame itself couldn't be read: said plainly, with a way back. */
export const FrameFailure = ({ reset }: ErrorComponentProps) => (
  <main {...stylex.props(styles.frameless)}>
    <Empty size="lg" style={styles.whole} variant="destructive">
      <EmptyHeader>
        <EmptyMedia variant="icon" />
        <EmptyTitle level={1}>The admin couldn’t be read</EmptyTitle>
        <EmptyDescription>
          Reading it failed just now. Try again in a moment.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <div {...stylex.props(styles.buttons)}>
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
    <Empty size="lg" style={styles.whole}>
      <EmptyHeader>
        <EmptyMedia illustration="lost" />
        <EmptyTitle level={1}>{title}</EmptyTitle>
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
      {...stylex.props(styles.loading)}
    >
      <div {...stylex.props(styles.lines)}>
        <Skeleton style={styles.title} variant="rectangular" />
        <Skeleton style={styles.lead} />
      </div>
      <div {...stylex.props(styles.lines)}>
        <Skeleton />
        <Skeleton />
        <Skeleton />
        <Skeleton style={styles.short} />
      </div>
    </output>
  </>
);
