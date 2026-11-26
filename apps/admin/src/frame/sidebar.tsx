import {
  CollapsibleContent,
  CollapsibleTrigger,
} from "@grasp-os/ui/components/collapsible";
import {
  Sidebar,
  SidebarCollapsible,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarLevel,
  SidebarLevels,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "@grasp-os/ui/components/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@grasp-os/ui/components/tooltip";
import {
  ChevronRightIcon,
  Icon,
  SearchIcon,
  XIcon,
} from "@grasp-os/ui/lib/icons";
import type { IconData } from "@grasp-os/ui/lib/icons";
import { visuallyHidden } from "@grasp-os/ui/lib/styles";
import {
  colors,
  duration,
  font,
  media,
  size,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import { iconVars } from "@grasp-os/ui/lib/vars.stylex";
import * as stylex from "@stylexjs/stylex";
import { useId, useState } from "react";
import type { ReactElement, ReactNode } from "react";

import { LevelHead, SidebarSwitch, SwitchPanel } from "./sidebar-switch.tsx";
import type { RenderLink, SidebarTab } from "./sidebar-switch.tsx";

// The admin's sidebar, composed as Grasp Work's (apps/web/src/frame/
// sidebar.tsx) from Damsko's Sidebar parts, holding only what the admin
// uses: the rows as data, in groups. At its top Grasp's mark, the search
// and the fold; under it the switch of the main list's views (Home,
// Inbox); then the rows, or an organization's level with Back and its
// name, which slides in over the main list and back; at its foot the
// staff member. Until Damsko's AppShell holds this (the registry gap
// "AppShell: what the product's frame adds"), the product and the admin
// each compose it.

export type { LinkLook, RenderLink, SidebarTab } from "./sidebar-switch.tsx";

/** One row: a link to a page, its icon, and what stands at its end. */
export interface SidebarRow {
  id?: string;
  label: string;
  icon?: IconData;
  /** The link itself (`(look) => <Link {...look} to="/platform" />`): it takes the row's look and its words. */
  render: RenderLink;
  current?: boolean;
  /** How many things wait there: a small pill at the row's end. None at 0. */
  count?: number;
  /** What a screen reader hears of the count. */
  countLabel?: string;
  /**
   * A mark at the row's end in place of its count, leading elsewhere (an
   * organization not read now, to its Setup): its icon, and what it says,
   * in its tooltip and to a screen reader.
   */
  mark?: { icon: IconData; label: string; render: RenderLink };
  /** Its name in the regular weight: a thing in a list of them, not a place. */
  quiet?: boolean;
}

/** A run of rows, under a small label or none. */
export interface SidebarGroupEntry {
  /** What its fold is kept under. @default its label */
  id?: string;
  label?: string;
  rows: readonly SidebarRow[];
  /** Its own content in place of the rows (skeletons while they come). */
  content?: ReactElement;
  /** Its label folds the rows away and opens them again. */
  collapsible?: boolean;
  /** A number beside its label. */
  count?: number;
  /** A landmark of its own, so it can be jumped to ("Organizations"). */
  landmark?: string;
}

/** A place with a navigation of its own (an organization), a level of the sidebar while one of its pages is open. */
export interface SidebarSection {
  id: string;
  title: string;
  icon?: IconData;
  /** Where Back leads, as a link, and its words. */
  back: { label: string; render: RenderLink };
  /** The place's own first page, as a link: its name opens it. */
  home: RenderLink;
  homeCurrent?: boolean;
  groups: readonly SidebarGroupEntry[];
}

const styles = stylex.create({
  // The mark at the start, the search and the fold at the end, in one row
  // the icon buttons' height; the fold's glyph ends where the rows' ink does.
  head: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: size.sidebarRowGap,
    minHeight: size.sidebarIconButton,
  },
  // In the phone's sheet the head stands space-1 under the sheet's top, as
  // the product's does: Damsko's SidebarHeader keeps 16px less the sheet's
  // inset there, which puts it 6px lower; that room taken back.
  headInSheet: {
    marginBlockStart: `calc(${space["1"]} - (${space["4"]} - ${size.sheetPadding}))`,
  },
  mark: {
    [iconVars.size]: size.appShellMark,
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    height: size.sidebarIconButton,
    paddingInlineStart: size.sidebarRowInline,
    color: colors.sidebarForeground,
  },
  tools: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    marginInlineStart: "auto",
    marginInlineEnd: `calc(${size.sidebarRowInline} - (${size.sidebarIconButton} - ${size.sidebarIcon}) / 2)`,
  },
  // A group label as tall as its words and their room.
  label: { height: "auto" },
  labelWords: {
    flexGrow: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  labelCount: { flexShrink: 0, fontVariantNumeric: "tabular-nums" },
  // Open, it points down; folded, the way of reading.
  chevron: {
    display: "inline-flex",
    flexShrink: 0,
    transform: {
      default: "none",
      ':is([aria-expanded="true"] > *)': "rotate(90deg)",
      ':is([aria-expanded="true"] > *):dir(rtl)': "rotate(-90deg)",
    },
    transitionProperty: "transform",
    transitionDuration: duration.hover,
    transitionTimingFunction: duration.ease,
  },
  // The rows of a group that folds stand in from its label, as a tree.
  under: { paddingInlineStart: space["3"] },
  empty: {
    margin: 0,
    paddingInline: `calc(${space["2"]} + ${size.sidebarRowInline})`,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    color: colors.sidebarSecondaryForeground,
    textWrap: "pretty",
  },
  // The foot: a rule over the person, a gutter in from each side.
  foot: {
    marginBlockStart: `calc(-1 * ${space["2"]})`,
    paddingBlockStart: space["2"],
    borderBlockStartWidth: size.hairline,
    borderBlockStartStyle: "solid",
    borderBlockStartColor: {
      default: colors.sidebarBorder,
      [media.forcedColors]: "CanvasText",
    },
  },
});

/** The search, a round button in the head. */
const SearchButton = ({
  label,
  shortcut,
  onSearch,
}: {
  label: string;
  shortcut: string;
  onSearch: () => void;
}) => (
  <SidebarMenuButton
    aria-label={label}
    onClick={onSearch}
    size="icon"
    title={`${label} (${shortcut})`}
  >
    <Icon icon={SearchIcon} />
  </SidebarMenuButton>
);

/** A row's mark at its end: a link of its own, said by its tooltip, folded or open. */
const RowMark = ({ mark }: { mark: NonNullable<SidebarRow["mark"]> }) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <SidebarMenuAction asChild>
        {mark.render({
          "aria-label": mark.label,
          children: <Icon icon={mark.icon} />,
        })}
      </SidebarMenuAction>
    </TooltipTrigger>
    <TooltipContent side="end">{mark.label}</TooltipContent>
  </Tooltip>
);

const Row = ({ row }: { row: SidebarRow }) => {
  const words: ReactNode[] = [
    row.icon === undefined ? null : <Icon icon={row.icon} key="icon" />,
    row.label,
    row.count !== undefined && row.count > 0 && row.countLabel !== undefined ? (
      <span key="count" {...stylex.props(visuallyHidden)}>
        {row.countLabel}
      </span>
    ) : null,
  ];
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={row.current === true}
        variant={row.quiet === true ? "quiet" : undefined}
      >
        {row.render({ children: words })}
      </SidebarMenuButton>
      {row.mark === undefined ? null : <RowMark mark={row.mark} />}
      {row.count !== undefined && row.count > 0 ? (
        <SidebarMenuBadge>
          <span aria-hidden="true">{row.count}</span>
        </SidebarMenuBadge>
      ) : null}
    </SidebarMenuItem>
  );
};

const Rows = ({
  group,
  labelledBy,
}: {
  group: SidebarGroupEntry;
  labelledBy?: string;
}) =>
  group.content ?? (
    <SidebarMenu aria-labelledby={labelledBy}>
      {group.rows.map((row) => (
        <Row key={row.id ?? row.label} row={row} />
      ))}
    </SidebarMenu>
  );

const GroupBody = ({ group }: { group: SidebarGroupEntry }) => {
  const labelId = useId();
  const { label } = group;
  if (label === undefined) {
    return (
      <SidebarGroup>
        <Rows group={group} />
      </SidebarGroup>
    );
  }
  const words = (
    <>
      <span {...stylex.props(styles.labelWords)}>{label}</span>
      {group.count === undefined ? null : (
        <span {...stylex.props(styles.labelCount)}>{group.count}</span>
      )}
    </>
  );
  if (group.collapsible !== true) {
    return (
      <SidebarGroup>
        <SidebarGroupLabel id={labelId} style={styles.label}>
          {words}
        </SidebarGroupLabel>
        <Rows group={group} labelledBy={labelId} />
      </SidebarGroup>
    );
  }
  return (
    <SidebarCollapsible name={group.id ?? label}>
      <SidebarGroup>
        <CollapsibleTrigger asChild>
          <SidebarGroupLabel asChild style={styles.label}>
            <button id={labelId} type="button">
              {words}
              <span aria-hidden="true" {...stylex.props(styles.chevron)}>
                <Icon icon={ChevronRightIcon} />
              </span>
            </button>
          </SidebarGroupLabel>
        </CollapsibleTrigger>
        <CollapsibleContent asChild>
          <div {...stylex.props(group.content === undefined && styles.under)}>
            <Rows group={group} labelledBy={labelId} />
          </div>
        </CollapsibleContent>
      </SidebarGroup>
    </SidebarCollapsible>
  );
};

const Group = ({ group }: { group: SidebarGroupEntry }) =>
  group.landmark === undefined ? (
    <GroupBody group={group} />
  ) : (
    <nav aria-label={group.landmark}>
      <GroupBody group={group} />
    </nav>
  );

/** The rows, in their groups; or one quiet sentence when there are none. */
const Nav = ({
  label,
  groups,
  empty,
}: {
  label: string;
  groups: readonly SidebarGroupEntry[];
  empty?: string;
}) => (
  <SidebarContent aria-label={label}>
    {groups.length === 0 && empty !== undefined ? (
      <p {...stylex.props(styles.empty)}>{empty}</p>
    ) : null}
    {groups.map((group, index) => (
      <Group group={group} key={group.id ?? group.label ?? index} />
    ))}
  </SidebarContent>
);

/** A place's level: Back and its name, then its rows. */
const SectionLevel = ({ section }: { section: SidebarSection }) => (
  <SidebarLevel value={section.id}>
    <LevelHead
      back={section.back.render}
      backLabel={section.back.label}
      home={section.home}
      homeCurrent={section.homeCurrent}
      icon={section.icon}
      title={section.title}
    />
    <Nav groups={section.groups} label={section.title} />
  </SidebarLevel>
);

/** Every prop the sidebar takes. */
export interface FrameSidebarProps {
  "aria-label": string;
  /** Grasp's mark, at the head's start. */
  mark: ReactNode;
  /** The search, at the head's end. */
  search: { label: string; shortcut: string; onSearch: () => void };
  foldLabel: string;
  closeLabel: string;
  /** The main list's rows, in groups. */
  groups: readonly SidebarGroupEntry[];
  /** What the main list's rows are, as a landmark. */
  navLabel: string;
  /** One quiet sentence where the rows would be, when there are none. */
  empty?: string;
  /** The main list's views, under the head (none while the admin's records come); the host gives each view's rows as `groups`. */
  views?: {
    tabs: readonly SidebarTab[];
    tab: string;
    onTabChange: (value: string) => void;
    label: string;
  };
  /** The place staff are in: its level takes the main list's place. */
  section?: SidebarSection;
  /** The staff member, at the foot; no foot without one. */
  profile?: ReactNode;
}

/**
 * The sidebar: Damsko's Sidebar on its ground beside the page's card, a
 * sheet on a narrow window, folded off the side whole.
 */
export const FrameSidebar = ({
  "aria-label": label,
  mark,
  search,
  foldLabel,
  closeLabel,
  groups,
  navLabel,
  empty,
  views,
  section,
  profile,
}: FrameSidebarProps) => {
  const { isMobile, setOpenMobile } = useSidebar();
  const switchId = useId();
  // The last level stays (unseen) after staff leave it, so the main list
  // comes back in from the way they went.
  const [last, setLast] = useState(section);
  if (section !== undefined && section !== last) {
    setLast(section);
  }
  const shownSection = section ?? last;
  return (
    <Sidebar aria-label={label} variant="inset">
      <SidebarHeader>
        <div {...stylex.props(styles.head, isMobile && styles.headInSheet)}>
          <span {...stylex.props(styles.mark)}>{mark}</span>
          <div {...stylex.props(styles.tools)}>
            <SearchButton
              label={search.label}
              onSearch={() => {
                // The search opens over the page: the phone's sheet goes first.
                setOpenMobile(false);
                search.onSearch();
              }}
              shortcut={search.shortcut}
            />
            {isMobile ? (
              <SidebarMenuButton
                aria-label={closeLabel}
                onClick={() => {
                  setOpenMobile(false);
                }}
                size="icon"
              >
                <Icon icon={XIcon} />
              </SidebarMenuButton>
            ) : (
              <SidebarTrigger aria-label={foldLabel} />
            )}
          </div>
        </div>
      </SidebarHeader>
      <SidebarLevels value={section?.id ?? "main"}>
        <SidebarLevel value="main">
          {views === undefined ? (
            <Nav empty={empty} groups={groups} label={navLabel} />
          ) : (
            <>
              <SidebarSwitch
                id={switchId}
                label={views.label}
                onChoose={(next) => {
                  views.onTabChange(next);
                }}
                tabs={views.tabs}
                value={views.tab}
              />
              <SwitchPanel id={switchId} value={views.tab}>
                <Nav empty={empty} groups={groups} label={navLabel} />
              </SwitchPanel>
            </>
          )}
        </SidebarLevel>
        {shownSection === undefined ? null : (
          <SectionLevel key={shownSection.id} section={shownSection} />
        )}
      </SidebarLevels>
      {profile === undefined ? null : (
        <SidebarFooter>
          <div data-slot="sidebar-foot" {...stylex.props(styles.foot)}>
            {profile}
          </div>
        </SidebarFooter>
      )}
    </Sidebar>
  );
};
