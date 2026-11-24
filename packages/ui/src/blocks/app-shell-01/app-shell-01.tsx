// App shell: the frame a product's pages stand in, composed of Sidebar, SidePanel, Sheet and
// Resizable. The product's sidebar down the start; beside it the page (the main landmark) as a card
// on the sidebar's ground, a header across its top (the sidebar's trigger, where the page is, the
// page's actions), and the page under it, which scrolls on its own so the header stays. At the end,
// one panel the person resizes by its handle, by pointer or the arrow keys.
//
//   <AppShell
//     sidebar={<SidebarContent>…</SidebarContent>}
//     breadcrumb={<BreadcrumbItem><BreadcrumbLink href="/projects">Projects</BreadcrumbLink></BreadcrumbItem>}
//     title={name}
//     onRename={setName}
//     actions={<Button size="sm">Share</Button>}
//     panel={<SidePanel aria-label="Details">…</SidePanel>}
//   >
//     <PageHeader title={name} />
//   </AppShell>
//
// On a narrow window (under lg) the sidebar is Sidebar's own sheet from the start, and the panel a
// Sheet from the end, opened by the header's panel button; a plain link followed in the sidebar's
// sheet closes it. A block: install it and edit it.
//
// It is a window's frame: as tall as the window unless `style` gives it its frame's height, and
// its two sheets are fixed to the window (the breakpoint is the window's width too). In a box of
// its own, such as a gallery's card, the box gives it a height (`style` with `height: "100%"` and
// `minHeight: 0` fills it) and is the containing block of what is fixed (`contain: layout`, or a
// transform), so the sheets open in the box.
"use client";

import * as stylex from "@stylexjs/stylex";
import { Fragment, isValidElement, useState } from "react";
import type { ReactNode } from "react";

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "../../components/breadcrumb";
import { breadcrumbVars } from "../../components/breadcrumb.stylex";
import { Button } from "../../components/button";
import { InlineEdit } from "../../components/inline-edit";
import { pageBandVars } from "../../components/page-header.stylex";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "../../components/resizable";
import { Sheet, SheetContent } from "../../components/sheet";
import { SidePanelPlacementProvider } from "../../components/side-panel";
import {
  Sidebar,
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "../../components/sidebar";
import { Icon, PanelRightIcon } from "../../lib/icons";
import { colors, font, media, size, space } from "../../lib/tokens.stylex";
import { listOf } from "../../lib/utils";
import type { LayoutStyle } from "../../lib/utils";

/** The words an AppShell says, for a screen reader: English here; pass the product's as `labels`. */
export interface AppShellLabels {
  /** The name of the page's crumbs. */
  breadcrumb: string;
  /** The name of the title's field while the page is renamed in place. */
  rename: string;
  /** The name of the page's panel's sheet on a narrow window. */
  pagePanel: string;
  /** The name of the handle between the page and the panel. */
  resize: string;
  /** The header's button that shows the panel and sets it aside. */
  togglePanel: string;
}

const LABELS: AppShellLabels = {
  breadcrumb: "Breadcrumb",
  pagePanel: "Details",
  rename: "Rename",
  resize: "Resize the panel",
  togglePanel: "Show or hide the panel",
};

/** The steps a caller wrote, one by one: lists and fragments of BreadcrumbItems opened up. */
const stepsOf = (steps: ReactNode): ReactNode[] =>
  listOf(steps).flatMap((step) =>
    isValidElement<{ children?: ReactNode }>(step) && step.type === Fragment
      ? stepsOf(step.props.children)
      : [step]
  );

/** Every prop an AppShell takes. */
export interface AppShellProps {
  /** The product's sidebar: its SidebarHeader, SidebarContent and SidebarFooter. */
  sidebar: ReactNode;
  /** The page. It scrolls under the header. */
  children: ReactNode;
  /**
   * Where the page is, at the header's start: the steps before it, as BreadcrumbItems and nothing
   * between them. The shell draws the Breadcrumb round them, the page itself (`title`) after them,
   * and every separator: a slash between each two steps.
   */
  breadcrumb?: ReactNode;
  /** The page's name: the breadcrumb's last step. */
  title?: string;
  /** Renames the page in place (InlineEdit): a press on the title, Enter or F2. Keep the name in your state. */
  onRename?: (name: string) => void;
  /** At the header's end: the page's own buttons, `sm`. */
  actions?: ReactNode;
  /** One panel at the end of the page, resizable: a SidePanel, seated unframed. A Sheet on a narrow window. */
  panel?: ReactNode;
  /**
   * Whether the panel shows, when you keep it: pass it with `onPanelOpenChange`. Unset, it shows
   * beside a wide page and waits closed on a narrow window.
   */
  panelOpen?: boolean;
  /** Runs when the header's panel button, or the panel's sheet, opens or closes the panel. */
  onPanelOpenChange?: (open: boolean) => void;
  /** Above the header, across the page: a notice for the whole product, such as a Banner. */
  banner?: ReactNode;
  /** Its words in the product's language; each one left out keeps its English. */
  labels?: Partial<AppShellLabels>;
  /**
   * Layout only: its height, in a frame of its own (`{ height: "100%", minHeight: 0 }`). It fills
   * the window's height by default.
   */
  style?: LayoutStyle;
}

// The panel's first width, and its least, in pixels: Resizable takes lengths, not variables, so
// these restate the side-panel-width token (420px) and a floor a SidePanel's sections still read at.
const PANEL_WIDTH = "420px";
const PANEL_MIN = "320px";
const PANEL_MAX = "50%";

const styles = stylex.create({
  // What the page holds, laid over the SidebarInset's box: the inset is as tall as the shell (the
  // window's height, or the frame's), never as tall as the page, so the header stays and the page
  // scrolls under it.
  // The card's own ground at every width: beside the sidebar, and filling the window on a phone.
  frame: {
    position: "absolute",
    inset: 0,
    display: "flex",
    flexDirection: "column",
    overflow: "clip",
    backgroundColor: colors.sidebarCard,
    borderRadius: "inherit",
    cornerShape: "inherit",
  },
  header: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: space["2"],
    minWidth: 0,
    height: size.appShellBar,
    paddingInline: space["3"],
    // The bar is the frame's, as the sidebar is: its path in the sidebar's neutral ink.
    [breadcrumbVars.foreground]: colors.sidebarForeground,
    [breadcrumbVars.mutedForeground]: colors.sidebarSecondaryForeground,
    [breadcrumbVars.subtleForeground]: colors.sidebarTertiaryForeground,
    // Its slash stands as far from each step as the steps' words are from a chevron's box.
    [breadcrumbVars.separatorInset]: space["1"],
    // Its foot a hairline across the card, in the card's own line, so it reads as a bar. Inside
    // the bar's row, which keeps its height. In forced colours the system's ink.
    position: "relative",
    "::after": {
      content: '""',
      position: "absolute",
      insetInline: 0,
      insetBlockEnd: 0,
      height: size.hairline,
      backgroundColor: {
        default: colors.sidebarCardBorder,
        [media.forcedColors]: "CanvasText",
      },
      pointerEvents: "none",
    },
  },
  where: {
    display: "flex",
    alignItems: "center",
    gap: space["2"],
    minWidth: 0,
    // Room at the end for the renamable name's own padding, which reaches a step past its words:
    // clipped, the keyboard's ring lost its end.
    paddingInlineEnd: space["1"],
    // A long path is cut along the bar, never across it: a link's 44px reach on a touch screen
    // stands past the words' line, and stays a finger's.
    overflowX: "clip",
  },
  actions: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: space["2"],
    marginInlineStart: "auto",
  },
  body: { flexGrow: 1, minHeight: 0 },
  // The page's room, told to a banner PageHeader (pageBandVars), which takes it back to stand flush.
  page: {
    boxSizing: "border-box",
    height: "100%",
    overflowX: "hidden",
    overflowY: "auto",
    scrollbarWidth: "none",
    paddingBlockStart: space["7"],
    paddingBlockEnd: size.appShellPageRoomBelow,
    paddingInline: size.appShellPageInline,
    [pageBandVars.top]: space["7"],
    [pageBandVars.inline]: size.appShellPageInline,
  },
  panel: { height: "100%", minHeight: 0 },
  contents: { display: "contents" },
  // The renamable name in the page's ink and weight, as BreadcrumbPage draws it.
  rename: {
    minWidth: 0,
    color: breadcrumbVars.foreground,
    fontWeight: font.weightMedium,
  },
});

/** Whether a press follows a link to its page here: not a new tab, a new window or a download. */
const followsLink = (event: globalThis.MouseEvent): boolean => {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) {
    return false;
  }
  const link =
    event.target instanceof Element ? event.target.closest("a[href]") : null;
  if (link === null || link.hasAttribute("download")) {
    return false;
  }
  const target = link.getAttribute("target") ?? "";
  return target === "" || target === "_self";
};

/** The sidebar: in its sheet on a narrow window, a link followed closes the sheet. */
const ShellSidebar = ({ children }: { children: ReactNode }) => {
  const { isMobile, setOpenMobile } = useSidebar();
  // Heard on the way up from the links inside, which are the keyboard's stops themselves (Enter on
  // a link is a click too).
  const watch = (node: HTMLDivElement) => {
    const press = (event: globalThis.MouseEvent) => {
      if (isMobile && followsLink(event)) {
        setOpenMobile(false);
      }
    };
    node.addEventListener("click", press);
    return () => {
      node.removeEventListener("click", press);
    };
  };
  return (
    <Sidebar variant="inset">
      <div ref={watch} {...stylex.props(styles.contents)}>
        {children}
      </div>
    </Sidebar>
  );
};

type ShellProps = Omit<AppShellProps, "sidebar" | "style">;

/** The page beside the sidebar: the header, then the page and its panel. */
const ShellPage = ({
  children,
  breadcrumb,
  title,
  onRename,
  actions,
  panel,
  panelOpen,
  onPanelOpenChange,
  banner,
  labels,
}: ShellProps) => {
  const words = { ...LABELS, ...labels };
  const { isMobile } = useSidebar();
  const [own, setOwn] = useState<boolean>();
  const hasPanel = panel !== undefined && panel !== null && panel !== false;
  // Unset, open beside a wide page and closed on a narrow window, where it would cover the page.
  const open = hasPanel && (panelOpen ?? own ?? !isMobile);
  const setOpen = (next: boolean) => {
    setOwn(next);
    onPanelOpenChange?.(next);
  };
  // Where the page is: the steps before it, then the page itself, renamable in place, a slash
  // between each two. The shell writes every separator, so each is the same.
  const page = title !== undefined && (
    <BreadcrumbItem>
      {/* BreadcrumbPage repeats its words in a tooltip when cut: a field is never repeated. */}
      {onRename === undefined ? (
        <BreadcrumbPage>{title}</BreadcrumbPage>
      ) : (
        <span aria-current="page" {...stylex.props(styles.rename)}>
          <InlineEdit
            aria-label={words.rename}
            value={title}
            onSubmit={onRename}
          />
        </span>
      )}
    </BreadcrumbItem>
  );
  const steps = [...stepsOf(breadcrumb), page].filter((step) => step !== false);
  const where = steps.length > 0 && (
    <Breadcrumb aria-label={words.breadcrumb}>
      <BreadcrumbList>
        {steps.map((step, at) => (
          <Fragment key={at}>
            {at > 0 && <BreadcrumbSeparator>/</BreadcrumbSeparator>}
            {step}
          </Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  );
  return (
    <SidebarInset>
      <div {...stylex.props(styles.frame)}>
        {banner}
        <header data-slot="app-shell-header" {...stylex.props(styles.header)}>
          <SidebarTrigger />
          <div {...stylex.props(styles.where)}>{where}</div>
          <div {...stylex.props(styles.actions)}>
            {actions}
            {hasPanel && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={words.togglePanel}
                aria-expanded={open}
                onClick={() => {
                  setOpen(!open);
                }}
              >
                <Icon icon={PanelRightIcon} />
              </Button>
            )}
          </div>
        </header>
        {/* One group always, the page its first panel: the panel coming and going never draws the
          page anew, so it keeps its scroll place and what was typed in it. */}
        <div {...stylex.props(styles.body)}>
          <ResizablePanelGroup>
            <ResizablePanel>
              <div data-slot="app-shell-page" {...stylex.props(styles.page)}>
                {children}
              </div>
            </ResizablePanel>
            {open && !isMobile && (
              <>
                <ResizableHandle aria-label={words.resize} />
                <ResizablePanel
                  defaultSize={PANEL_WIDTH}
                  minSize={PANEL_MIN}
                  maxSize={PANEL_MAX}
                >
                  <div
                    data-slot="app-shell-panel"
                    {...stylex.props(styles.panel)}
                  >
                    <SidePanelPlacementProvider value="beside">
                      {panel}
                    </SidePanelPlacementProvider>
                  </div>
                </ResizablePanel>
              </>
            )}
          </ResizablePanelGroup>
        </div>
        {hasPanel && isMobile && (
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetContent aria-label={words.pagePanel}>
              <SidePanelPlacementProvider value="sheet">
                {panel}
              </SidePanelPlacementProvider>
            </SheetContent>
          </Sheet>
        )}
      </div>
    </SidebarInset>
  );
};

/** The frame a product's pages stand in: the sidebar, the page with its header, one end panel. */
export const AppShell = ({ sidebar, style, ...page }: AppShellProps) => (
  <SidebarProvider style={style}>
    <ShellSidebar>{sidebar}</ShellSidebar>
    <ShellPage {...page} />
  </SidebarProvider>
);
