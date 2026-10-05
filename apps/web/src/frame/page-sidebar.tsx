import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { Button, buttonVariants } from "@grasp-os/ui/components/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@grasp-os/ui/components/tooltip";
import { PanelLeftCloseIcon, PanelLeftOpenIcon } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { ReactElement, ReactNode } from "react";

import { keepFolded, readFolded } from "../fold.ts";

// The column beside a page's content, the same on every page that has one
// (Chat, Knowledge): 288px open, with the page's first choice in its top
// row and the button that folds it beside that; folded, a 48px rail of
// icons as wide as the site header's square for the sidebar trigger, so its
// edge continues the line beside that trigger and nothing moves when it
// folds. On a phone neither shows: the page offers its list in a sheet.
// From the prototype's components/page-sidebar.tsx.

/** From this width the window holds the app's sidebar, a page sidebar and the page side by side; narrower, a page sidebar starts folded. */
const roomyQuery = "(min-width: 1280px)";

const onRoomy = (onChange: () => void): (() => void) => {
  const query = matchMedia(roomyQuery);
  query.addEventListener("change", onChange);
  return () => {
    query.removeEventListener("change", onChange);
  };
};

const isRoomy = (): boolean => matchMedia(roomyQuery).matches;

/**
 * Whether a page's sidebar is folded, kept as the person left it in this
 * browser (a cookie, `page` naming it, e.g. "chat"). Until they choose, it
 * is open on a roomy window and folded on a narrow one.
 */
export const usePageSidebarFold = (
  page: string
): [boolean, (folded: boolean) => void] => {
  const roomy = useSyncExternalStore(onRoomy, isRoomy);
  const [choice, setChoice] = useState(() => readFolded(page));
  const setFolded = (folded: boolean): void => {
    setChoice(folded);
    void keepFolded(page, folded);
  };
  return [choice ?? !roomy, setFolded];
};

/** How long a sidebar takes to open or fold: `duration-200` in its classes. */
const foldMs = 200;

const motionReduced = (): boolean =>
  matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * The sidebar itself, named `label`: open, or folded to its rail. It stays
 * one element either way, so its width eases between the two on the app
 * sidebar's curve; what it holds keeps its own width, so it is uncovered or
 * cut off rather than squeezed. Folding, it keeps what it held open until
 * its width has shrunk, so it closes the way it opens rather than turning
 * into the rail at once and shrinking an empty column.
 */
export const PageSidebar = ({
  folded,
  label,
  children,
}: {
  folded: boolean;
  label: string;
  children: ReactNode;
}) => {
  const [was, setWas] = useState({
    folded,
    open: folded ? null : children,
  });
  // While it folds, what it held open; none once the width has shrunk, or
  // where motion is reduced.
  const [leaving, setLeaving] = useState<ReactNode>(null);
  if (folded !== was.folded || (!folded && children !== was.open)) {
    setWas({ folded, open: folded ? was.open : children });
    if (folded !== was.folded) {
      setLeaving(folded && !motionReduced() ? was.open : null);
    }
  }
  // The rail takes over once the width has shrunk. A timer rather than
  // `transitionend`, which never comes where no transition runs, as on a
  // phone, where the sidebar is hidden.
  useEffect(() => {
    const timer =
      leaving === null
        ? undefined
        : setTimeout(() => {
            setLeaving(null);
          }, foldMs);
    return () => {
      clearTimeout(timer);
    };
  }, [leaving]);
  return (
    <aside
      aria-label={label}
      className={
        folded
          ? "ease-sidebar hidden w-12 flex-none overflow-hidden border-r transition-all duration-200 motion-reduce:transition-none md:flex"
          : "ease-sidebar hidden w-72 flex-none overflow-hidden border-r transition-all duration-200 motion-reduce:transition-none md:flex"
      }
    >
      {leaving === null ? (
        <div
          className={
            folded
              ? "flex w-12 flex-none flex-col items-center gap-1 overflow-y-auto py-3"
              : "flex w-72 flex-none flex-col"
          }
        >
          {children}
        </div>
      ) : (
        <div className="flex w-72 flex-none flex-col" inert>
          {leaving}
        </div>
      )}
    </aside>
  );
};

/** A rail entry that is a link: `render` with the rail button's look. */
const RailLink = ({
  active,
  label,
  render,
  ...props
}: useRender.ComponentProps<"a"> & { active: boolean; label: string }) =>
  useRender({
    defaultTagName: "a",
    props: mergeProps<"a">(
      {
        "aria-current": active ? "page" : undefined,
        "aria-label": label,
        className: buttonVariants({
          size: "icon",
          variant: active ? "secondary" : "ghost",
        }),
      },
      props
    ),
    render,
  });

/**
 * A button named by its tooltip: the fold, and the rail's entries. With
 * `render` it is a link (a link, not a button, to assistive technology).
 */
export const RailButton = ({
  label,
  active = false,
  onClick,
  render,
  children,
}: {
  label: string;
  active?: boolean;
  onClick?: () => void;
  render?: ReactElement;
  children: ReactNode;
}) => (
  <Tooltip>
    {render === undefined ? (
      <TooltipTrigger
        render={
          <Button
            aria-current={active ? "page" : undefined}
            aria-label={label}
            onClick={onClick}
            size="icon"
            variant={active ? "secondary" : "ghost"}
          />
        }
      >
        {children}
      </TooltipTrigger>
    ) : (
      <TooltipTrigger
        render={<RailLink active={active} label={label} render={render} />}
      >
        {children}
      </TooltipTrigger>
    )}
    <TooltipContent className="max-w-64" side="right">
      {label}
    </TooltipContent>
  </Tooltip>
);

/**
 * The top row: the page's first choice or a heading, and the fold beside
 * it, where the rail's first button sits. A line sets it apart from the
 * rest, unless the rest continues it as one list (`joined`).
 */
export const PageSidebarTop = ({
  children,
  fold,
  joined = false,
}: {
  children: ReactNode;
  fold?: { label: string; onFold: () => void };
  joined?: boolean;
}) => (
  <div
    className={
      joined
        ? "flex flex-none items-center gap-1.5 px-3 pt-3"
        : "flex flex-none items-center gap-1.5 border-b p-3"
    }
  >
    <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    {fold === undefined ? null : (
      <RailButton
        label={fold.label}
        onClick={() => {
          fold.onFold();
        }}
      >
        <PanelLeftCloseIcon />
      </RailButton>
    )}
  </div>
);

/** What the open sidebar holds under its top row; it scrolls on its own. */
export const PageSidebarBody = ({
  children,
  joined = false,
}: {
  children: ReactNode;
  joined?: boolean;
}) => (
  <div
    className={
      joined
        ? "flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-3 pt-0.5 pb-3"
        : "flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-3"
    }
  >
    {children}
  </div>
);

/** The rail's first button: open the sidebar again. */
export const RailExpand = ({
  label,
  onExpand,
}: {
  label: string;
  onExpand: () => void;
}) => (
  <RailButton label={label} onClick={onExpand}>
    <PanelLeftOpenIcon />
  </RailButton>
);

/** A short line between groups in the rail. */
export const RailDivider = () => (
  <span aria-hidden="true" className="bg-border my-1.5 h-px w-6" />
);
