import type { Project } from "@grasp-os/shared/projects";
import { Heading } from "@grasp-os/ui/components/heading";
import { colors, size, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

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

// The shell's width, which its bar's parts give way to, narrowest last.
// Named "bar" for the container queries of what pages put in it (`@container bar`).
const BAR = "@container bar";

const styles = stylex.create({
  shell: {
    containerName: "bar",
    containerType: "inline-size",
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
  },
  thing: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
  },
  // Where it stands gives way to its actions where the bar is narrow.
  state: {
    display: { default: "inline-flex", [`${BAR} (width < 48rem)`]: "none" },
    flexShrink: 0,
    alignItems: "center",
  },
  // Named for a screen reader, which the trail shows as its last step.
  unseen: {
    position: "absolute",
    width: size.hairline,
    height: size.hairline,
    overflow: "hidden",
    clipPath: "inset(50%)",
    whiteSpace: "nowrap",
  },
  start: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
    overflowY: "auto",
    backgroundColor: colors.muted,
  },
  startMiddle: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "100%",
    paddingInline: space[6],
    paddingBlock: space[12],
  },
  startColumn: {
    display: "flex",
    flexDirection: "column",
    gap: space[6],
    width: "100%",
    maxWidth: "42rem",
    paddingBlockEnd: space[10],
  },
  question: { textAlign: "center" },
});

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
  crumbs,
  headed = false,
  state,
  actions,
}: {
  back: Crumb;
  name: string;
  /** The trail, where it goes past the item's name (a view of it): back, then the item, by default. */
  crumbs?: readonly Crumb[];
  /** Whether the page heads itself with its name: the bar's own heading then gives way. */
  headed?: boolean;
  /** Where it stands: Draft, Live and its label, or its version. */
  state?: ReactNode;
  /** Share, then the page's one lime action, in that order. */
  actions?: ReactNode;
}) => (
  <>
    {/* The page's heading, which the trail shows as its last step. */}
    {headed ? null : <h1 {...stylex.props(styles.unseen)}>{name}</h1>}
    <SiteHeader
      actions={actions}
      crumbs={crumbs ?? [back, { label: name }]}
      // Where it stands gives way to its actions where the bar is narrow.
      trailing={
        state === undefined ? undefined : (
          <span {...stylex.props(styles.state)}>{state}</span>
        )
      }
    />
  </>
);

/** The shell: its bar, then the thing itself filling the rest. */
export const ItemShell = ({
  bar,
  children,
}: {
  bar: ReactNode;
  children: ReactNode;
}) => (
  // Where it is narrow, beside the docked chat, a workflow's Run and Share
  // go to their icons first (`@max-5xl/bar`); where it stands gives way
  // after them (`@max-3xl/bar`). Its views keep their words (Grasp UI's
  // tabs never stand as icons alone), the page's main action too, and the
  // item's name gives way last.
  <div {...stylex.props(styles.shell)}>
    {bar}
    <div {...stylex.props(styles.thing)}>{children}</div>
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
  <section aria-labelledby="item-start" {...stylex.props(styles.start)}>
    <div {...stylex.props(styles.startMiddle)}>
      <div {...stylex.props(styles.startColumn)}>
        <div {...stylex.props(styles.question)}>
          <Heading id="item-start" level={2} size="lg">
            {question}
          </Heading>
        </div>
        {composer}
        {children}
      </div>
    </div>
  </section>
);
