// Sidebar's parts (release step 6), after shadcn's sidebar: a SidebarGroup holding its
// SidebarGroupLabel and its SidebarMenu, of SidebarMenuItems, each a SidebarMenuButton and, under it,
// a SidebarMenuSub of SidebarMenuSubItems and their SidebarMenuSubButtons.
//
//   <Sidebar head={<Logo />}>
//     <SidebarGroup>
//       <SidebarMenu>
//         <SidebarMenuItem>
//           <SidebarMenuButton href="/" icon={Conversation} current>Chat</SidebarMenuButton>
//         </SidebarMenuItem>
//       </SidebarMenu>
//     </SidebarGroup>
//     <SidebarGroup collapsible>
//       <SidebarGroupLabel>From your Apps</SidebarGroupLabel>
//       <SidebarMenu>…</SidebarMenu>
//     </SidebarGroup>
//   </Sidebar>
//
// The parts say what the list holds; the Sidebar draws it, as it draws its `groups`, so filtering,
// folds kept in storage, the list's keys and the current row in view work alike for both. A part
// outside a Sidebar draws nothing.
import { Fragment, isValidElement } from "react";
import type { ReactNode } from "react";

import type { SidebarGroupEntry, SidebarRow, SidebarSubRow } from "./sidebar";

/** Every prop a SidebarGroup takes: a run of rows, and how it folds. */
export interface SidebarGroupProps extends Omit<
  SidebarGroupEntry,
  "label" | "rows"
> {
  /** Its SidebarGroupLabel (none for the first, main run) and its SidebarMenu. */
  children: ReactNode;
}

/** Every prop a SidebarGroupLabel takes. */
export interface SidebarGroupLabelProps {
  /** The small label over the rows ("From your Apps"). */
  children: string;
}

/** Every prop a SidebarMenu takes. */
export interface SidebarMenuProps {
  /** Its SidebarMenuItems, in order. */
  children?: ReactNode;
}

/** Every prop a SidebarMenuItem takes. */
export interface SidebarMenuItemProps {
  /** Its SidebarMenuButton, and a SidebarMenuSub when the row has rows under it. */
  children: ReactNode;
}

/** Every prop a SidebarMenuButton takes: a row, a link to a page. */
export interface SidebarMenuButtonProps extends Omit<
  SidebarRow,
  "label" | "rows"
> {
  /** The row's name. */
  children: string;
}

/** Every prop a SidebarMenuSub takes. */
export interface SidebarMenuSubProps {
  /** Its SidebarMenuSubItems, in order. */
  children?: ReactNode;
}

/** Every prop a SidebarMenuSubItem takes. */
export interface SidebarMenuSubItemProps {
  /** Its SidebarMenuSubButton. */
  children: ReactNode;
}

/** Every prop a SidebarMenuSubButton takes: a row under a row. */
export interface SidebarMenuSubButtonProps extends Omit<
  SidebarSubRow,
  "label"
> {
  /** The row's name. */
  children: string;
}

/** A run of rows, with a label over it when it is not the main one. */
export const SidebarGroup = (_props: SidebarGroupProps) => null;
/** The label over a group's rows. */
export const SidebarGroupLabel = (_props: SidebarGroupLabelProps) => null;
/** A group's rows. */
export const SidebarMenu = (_props: SidebarMenuProps) => null;
/** One row, and the rows under it. */
export const SidebarMenuItem = (_props: SidebarMenuItemProps) => null;
/** A row: a link to a page, with its icon, its count, its menu. */
export const SidebarMenuButton = (_props: SidebarMenuButtonProps) => null;
/** The rows under a row. */
export const SidebarMenuSub = (_props: SidebarMenuSubProps) => null;
/** One row under a row. */
export const SidebarMenuSubItem = (_props: SidebarMenuSubItemProps) => null;
/** A row under a row: a link to a page. */
export const SidebarMenuSubButton = (_props: SidebarMenuSubButtonProps) => null;

/** Children as a flat list: lists (from `.map`) and fragments opened, at any depth. */
const elementsOf = (children: ReactNode): ReactNode[] => {
  if (Array.isArray(children)) {
    return children.flatMap((child: ReactNode) => elementsOf(child));
  }
  if (
    isValidElement<{ children?: ReactNode }>(children) &&
    children.type === Fragment
  ) {
    return elementsOf(children.props.children);
  }
  return [children];
};

/** Nothing to draw: what a condition leaves (`cond && <Part />`), and empty words. */
const nothing = (child: ReactNode) =>
  child === null ||
  child === undefined ||
  typeof child === "boolean" ||
  child === "";

/** The name a child goes by in a notice: its component's name, or what it is. */
const nameOf = (child: ReactNode) => {
  if (!isValidElement(child)) {
    return typeof child;
  }
  const type: unknown = child.type;
  if (typeof type === "string") {
    return `<${type}>`;
  }
  return typeof type === "function" && type.name !== ""
    ? `<${type.name}>`
    : "a component";
};

/**
 * Every child is one of these parts, or nothing. The Sidebar reads its parts by their type, so a
 * component of your own that returns a part cannot be read: in development that is an error, named,
 * never a row missing in silence. In production what cannot be read is left out.
 */
const checkHolds = (
  children: ReactNode,
  holder: string,
  parts: readonly ((props: never) => null)[]
) => {
  if (!import.meta.env?.DEV) {
    return;
  }
  for (const child of elementsOf(children)) {
    if (
      !nothing(child) &&
      !(isValidElement(child) && parts.some((part) => child.type === part))
    ) {
      throw new Error(
        `Sidebar: ${holder} holds ${nameOf(child)}, which the Sidebar cannot read. Write its parts in place (a .map, a fragment or a condition is fine); a component of your own that returns a part is not read.`
      );
    }
  }
};

/** The children of a part's type, with their props. */
const partsOf = <P,>(children: ReactNode, part: (props: P) => null): P[] =>
  elementsOf(children).flatMap((child) =>
    isValidElement<P>(child) && child.type === part ? [child.props] : []
  );

const subRowsOf = (children: ReactNode): SidebarSubRow[] =>
  partsOf(children, SidebarMenuSub)
    .flatMap((sub) => {
      checkHolds(sub.children, "a SidebarMenuSub", [SidebarMenuSubItem]);
      return partsOf(sub.children, SidebarMenuSubItem);
    })
    .flatMap((item) => {
      checkHolds(item.children, "a SidebarMenuSubItem", [SidebarMenuSubButton]);
      return partsOf(item.children, SidebarMenuSubButton);
    })
    .map(({ children: label, ...row }) => ({ ...row, label }));

const rowsOf = (children: ReactNode): SidebarRow[] =>
  partsOf(children, SidebarMenu)
    .flatMap((menu) => {
      checkHolds(menu.children, "a SidebarMenu", [SidebarMenuItem]);
      return partsOf(menu.children, SidebarMenuItem);
    })
    .flatMap((item) => {
      checkHolds(item.children, "a SidebarMenuItem", [
        SidebarMenuButton,
        SidebarMenuSub,
      ]);
      const sub = subRowsOf(item.children);
      return partsOf(item.children, SidebarMenuButton).map(
        ({ children: label, ...row }) => ({
          ...row,
          label,
          ...(sub.length > 0 ? { rows: sub } : {}),
        })
      );
    });

/** The groups the parts written in a Sidebar describe, as its `groups` would hold them. */
export const groupsOf = (children: ReactNode): SidebarGroupEntry[] => {
  checkHolds(children, "the Sidebar", [SidebarGroup]);
  return partsOf(children, SidebarGroup).map(
    ({ children: inside, ...group }) => {
      checkHolds(inside, "a SidebarGroup", [SidebarGroupLabel, SidebarMenu]);
      const label = partsOf(inside, SidebarGroupLabel)[0]?.children;
      return {
        ...group,
        ...(label === undefined ? {} : { label }),
        rows: rowsOf(inside),
      };
    }
  );
};
