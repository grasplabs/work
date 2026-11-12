import type { Project } from "@grasp-os/shared/projects";
import { Button } from "@grasp-os/ui/components/button";
import { PageHeaderTitle } from "@grasp-os/ui/components/page-header";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@grasp-os/ui/components/tooltip";
import type { ReactElement, ReactNode } from "react";

import type { Session } from "../core.ts";
import { SiteHeader } from "./site-header.tsx";
import type { Crumb } from "./site-header.tsx";

// One shell for an App and a workflow alike, from the moment it is started
// to every day after: one bar, the site's own (site-header.tsx), with the
// way back to their list (or the project it was started from), the item's
// name and where it stands on the left, and on the right its views, Share
// and the page's one lime action; under it, the thing itself, with
// Grasp's chat about it docked beside (chat/chat-subject.ts). An App with
// no page yet asks one question in its main area (`ItemStart`).

/** The project an item was started from, carried along in its address (`?project=`). */
export type ItemProject = Pick<Project, "id" | "name">;

/**
 * The project `project` names, by its name, for the way back; none without
 * one, or for one the person can't read, whose way back is to the list.
 */
export const readItemProject = async (
  session: Session,
  project: string | undefined
): Promise<ItemProject | undefined> => {
  if (project === undefined) {
    return undefined;
  }
  try {
    const { id, name } = await session.projects.get(project);
    return { id, name };
  } catch {
    return undefined;
  }
};

/** The project an address names (`?project=`), if any. */
export const projectSearchOf = (search: Record<string, unknown>) =>
  typeof search.project === "string" ? search.project : undefined;

/** The way back: to the project the item was started from, or to its list. */
export const backCrumb = (
  list: { label: string; to: "/apps" | "/workflows" },
  project: ItemProject | undefined
): Crumb =>
  project === undefined
    ? list
    : {
        label: project.name,
        to: "/projects/$projectId",
        params: { projectId: project.id },
      };

/** The item's one bar: back, its name and where it stands; its views and actions. */
export const ItemBar = ({
  back,
  name,
  state,
  actions,
}: {
  back: Crumb;
  name: string;
  /** Where it stands: Draft, Live and its label, or its version. */
  state?: ReactNode;
  /** Its views, Share, then the page's one lime action, in that order. */
  actions?: ReactNode;
}) => (
  <>
    {/* The page's heading, which the trail shows as its last step. */}
    <h1 className="sr-only">{name}</h1>
    <SiteHeader
      actions={actions}
      crumbs={[back, { label: name }]}
      phoneCrumbs="last-two"
      // Where it stands gives way to its actions where the bar is narrow.
      trailing={
        state === undefined ? undefined : (
          <span className="@max-3xl/bar:hidden">{state}</span>
        )
      }
    />
  </>
);

/** A switch in the bar, as its views or Draft | Live: links, each an address of its own. */
export const ItemSwitch = ({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) => (
  <nav
    aria-label={label}
    className="bg-muted flex flex-none gap-0.5 rounded-lg p-0.5"
  >
    {children}
  </nav>
);

/**
 * One of a switch's links (`render`, a router's `<Link>`): its icon and
 * label, raised while it is where the page is. Where the bar is narrow
 * (`@max-6xl/bar`) it is its icon alone, its label its tooltip: the views
 * give way first, so the item's name and its main action keep their words.
 */
export const ItemSwitchLink = ({
  current,
  label,
  icon,
  render,
  children,
}: {
  current: boolean;
  label: string;
  icon: ReactNode;
  render: ReactElement;
  /** Anything after the label, as a count. */
  children?: ReactNode;
}) => (
  <Tooltip>
    <TooltipTrigger
      render={
        <Button
          aria-current={current ? "page" : undefined}
          nativeButton={false}
          render={render}
          size="sm"
          variant={current ? "outline" : "ghost"}
        />
      }
    >
      {icon}
      <span className="@max-6xl/bar:sr-only">{label}</span>
      {children}
    </TooltipTrigger>
    <TooltipContent>{label}</TooltipContent>
  </Tooltip>
);

/** The shell: its bar, then the thing itself filling the rest. */
export const ItemShell = ({
  bar,
  children,
}: {
  bar: ReactNode;
  children: ReactNode;
}) => (
  // Its views go to icons first where it is narrow (`@max-6xl/bar`),
  // beside the docked chat, then a workflow's Run and Share
  // (`@max-5xl/bar`); where it stands gives way after them
  // (`@max-3xl/bar`). The page's main action keeps its words, and the
  // item's name gives way last.
  <div className="@container/bar flex min-h-0 flex-1 flex-col text-sm">
    {bar}
    <div className="flex min-h-0 flex-1 flex-col">{children}</div>
  </div>
);

/**
 * The start, in the main area: one question, in the serif, with the box to
 * answer it in (`composer`) under it, and other ways to start under that.
 */
export const ItemStart = ({
  question,
  composer,
  children,
}: {
  question: ReactNode;
  composer: ReactNode;
  children?: ReactNode;
}) => (
  <section
    aria-labelledby="item-start"
    className="bg-muted flex min-h-0 flex-1 flex-col overflow-y-auto"
  >
    <div className="flex min-h-full items-center justify-center px-6 py-12">
      <div className="flex w-full max-w-2xl flex-col gap-6 pb-10">
        <PageHeaderTitle
          className="text-center"
          id="item-start"
          render={<h2>{question}</h2>}
        />
        {composer}
        {children}
      </div>
    </div>
  </section>
);
