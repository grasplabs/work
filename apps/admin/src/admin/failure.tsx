/**
 * What the admin shows in place of a part of a page that failed: a plain
 * line and a way to try again, never the router's own error page. Every
 * route takes `RouteFailure` (src/router.tsx), so a section that fails
 * shows it where the section would be, under its organization's column
 * and the admin's sidebar, which keep working; only a frame that can't
 * be read at all shows `FrameFailure` in its place.
 */
import { Button, buttonVariants } from "@grasp-os/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import { Link, useRouter } from "@tanstack/react-router";
import type { ErrorComponentProps } from "@tanstack/react-router";

/**
 * Reads the page again and shows it anew: its loaders run again, and
 * what failed while rendering is rendered again.
 */
const useTryAgain = (reset: () => void): (() => void) => {
  const router = useRouter();
  return () => {
    reset();
    void router.invalidate();
  };
};

/** A part of a page that failed, said plainly where it would be. */
export const RouteFailure = ({ reset }: ErrorComponentProps) => {
  const tryAgain = useTryAgain(reset);
  return (
    <Empty role="alert">
      <EmptyHeader>
        <EmptyTitle>This couldn’t be shown</EmptyTitle>
        <EmptyDescription>
          Reading it failed just now. The rest of the admin still works.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button onClick={tryAgain} size="sm" variant="outline">
          Try again
        </Button>
      </EmptyContent>
    </Empty>
  );
};

/** The admin's frame itself couldn't be read: said plainly, with a way back. */
export const FrameFailure = ({ reset }: ErrorComponentProps) => {
  const tryAgain = useTryAgain(reset);
  return (
    <main className="flex min-h-svh p-6">
      <Empty role="alert">
        <EmptyHeader>
          <EmptyTitle>The admin couldn’t be read</EmptyTitle>
          <EmptyDescription>
            Reading it failed just now. Try again in a moment.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="flex-row justify-center">
          <Button onClick={tryAgain} size="sm">
            Try again
          </Button>
          {/* A link that looks like a button: it is announced as the link it is. */}
          <Link
            className={buttonVariants({ size: "sm", variant: "outline" })}
            to="/"
          >
            Back to the admin
          </Link>
        </EmptyContent>
      </Empty>
    </main>
  );
};
