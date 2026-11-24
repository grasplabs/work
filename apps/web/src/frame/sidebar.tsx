import { AgentIndicator } from "@grasp-os/ui/components/agent-indicator";
import {
  CollapsibleContent,
  CollapsibleTrigger,
} from "@grasp-os/ui/components/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import { InlineEdit } from "@grasp-os/ui/components/inline-edit";
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
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@grasp-os/ui/components/sidebar";
import {
  ChevronRightIcon,
  EllipsisIcon,
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
import type { MouseEvent, ReactElement, ReactNode } from "react";

import { LevelHead, SidebarSwitch, SwitchPanel } from "./sidebar-switch.tsx";
import type { RenderLink, SidebarTab } from "./sidebar-switch.tsx";

// The product's sidebar, as the reference's (#2503's grasp/sidebar, which
// the frame fills from grasp/frame/grasp-sidebar.tsx): the rows as data, in
// groups, drawn with Damsko's Sidebar parts. At its top Grasp's mark, the
// search and the fold; under it the switch of the main list's views (Home,
// Inbox); then the rows, or a level of an area of its own (Settings, an
// App, an agent, the Brain, Integrations) with Back and its name, which
// slides in over the main list and back; at its foot the person.

export type { LinkLook, RenderLink, SidebarTab } from "./sidebar-switch.tsx";

/** One entry of a row's menu: a choice, or a line between choices. */
export type RowAction =
  | {
      value: string;
      label: string;
      icon: IconData;
      /** A choice that removes or destroys, in the danger ink. */
      danger?: boolean;
    }
  | "separator";

/** A row under a row: a page within it. */
export interface SidebarSubRow {
  id?: string;
  label: string;
  /** The link itself (`(look) => <Link {...look} to="/apps" />`): it takes the row's look and its words. */
  render?: RenderLink;
  current?: boolean;
}

/** One row: a link to a page, its icon, and what stands at its end. */
export interface SidebarRow extends SidebarSubRow {
  icon?: IconData;
  /** How many things wait there: a small pill at the row's end. None at 0. */
  count?: number;
  /** What a screen reader hears of the count. @default the number */
  countLabel?: string;
  /** Runs when the row is pressed; a row without `render` is a button. */
  onClick?: (event: MouseEvent<HTMLElement>) => void;
  /** Its own rows, under its name. */
  rows?: readonly SidebarSubRow[];
  /** A second, quieter line under its name: the row grows to two lines. */
  detail?: string;
  /** Short words at the row's end, quiet, instead of a count ("2d"). */
  end?: string;
  /** What a screen reader hears of `end`. @default `end` */
  endLabel?: string;
  /** Its name in the regular weight: a thing (a chat) in a list of them, not a place. */
  quiet?: boolean;
  /** An agent works there now: the Working mark at the row's end. */
  working?: boolean;
  workingLabel?: string;
  /** Its menu, behind three dots at its end. */
  actions?: readonly RowAction[];
  /** The dots' name ("More for Weekly numbers"). */
  actionsLabel?: string;
  onAction?: (value: string) => void;
  /** Renamed in place: its menu's `rename` opens a field over its words. */
  onRename?: (name: string) => void;
  renameLabel?: string;
}

/** The last, quiet row of a group: the way to all of them ("All chats"). */
export interface SidebarMore {
  label: string;
  render?: RenderLink;
  onClick?: () => void;
}

/** A run of rows, under a small label or none. */
export interface SidebarGroupEntry {
  /** What its fold is kept under. @default its label */
  id?: string;
  label?: string;
  rows: readonly SidebarRow[];
  /** Its own content in place of the rows (a tree). */
  content?: ReactElement;
  /** Its label folds the rows away and opens them again. */
  collapsible?: boolean;
  /** A number beside its label. */
  count?: number;
  more?: SidebarMore;
}

/** Views of a level's page, under its name, in the switch (an App's preview widths). */
export interface SidebarSectionViews {
  label: string;
  tabs: readonly SidebarTab[];
  value: string;
  onChange: (value: string) => void;
}

/** An area of the product with a navigation of its own, a level of the sidebar while one of its pages is open. */
export interface SidebarSection {
  id: string;
  title: string;
  icon?: IconData;
  /** A mark of the area's own before its name (an agent's face), instead of `icon`. */
  mark?: ReactNode;
  /** Where Back leads, as a link, and its words. */
  back: { label: string; render: RenderLink };
  /** The area's own first page, as a link: its name opens it. */
  home: RenderLink;
  homeCurrent?: boolean;
  views?: SidebarSectionViews;
  groups: readonly SidebarGroupEntry[];
  /** What its rows are, said as a landmark. @default `title` */
  navLabel?: string;
}

const HOVER = media.hover;

const styles = stylex.create({
  // Grasp's mark at the start, the search and the fold at the end, in one
  // row the icon buttons' height; the fold's glyph ends where the rows' ink
  // does.
  head: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: size.sidebarRowGap,
    minHeight: size.sidebarIconButton,
  },
  // In the phone's sheet the head stands nearer the sheet's top, as the
  // reference's: the sheet's own inset less than the sidebar's room above.
  headInSheet: { marginBlockStart: `calc(-1 * ${space["3"]})` },
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
  // A group label as tall as its words and their room, as the reference's.
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
  under: { marginInlineStart: space["3"] },
  quiet: { fontWeight: font.weightNormal },
  more: {
    fontWeight: font.weightNormal,
    color: {
      default: colors.mutedForeground,
      [HOVER]: {
        default: colors.mutedForeground,
        ":hover": colors.sidebarForeground,
      },
    },
  },
  name: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "0%",
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  // A row with a second line: as tall as its lines.
  words: { display: "flex", flexDirection: "column", minWidth: 0 },
  detail: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    fontWeight: font.weightNormal,
    letterSpacing: "normal",
    color: colors.mutedForeground,
  },
  end: {
    flexShrink: 0,
    marginInlineStart: "auto",
    fontSize: font.textXs,
    lineHeight: font.textSmLine,
    fontWeight: font.weightNormal,
    letterSpacing: "normal",
    fontVariantNumeric: "tabular-nums",
    color: colors.mutedForeground,
  },
  tall: { height: "auto", minHeight: size.sidebarMenuButtonHeight },
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
  rename: { position: "absolute", inset: 0, display: "flex" },
});

/** The search of the person's chats, a round button in the head. */
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

/** A row's menu: three dots at its end, shown while the row is pointed at or holds focus. */
const RowMenu = ({
  row,
  onRename,
}: {
  row: SidebarRow;
  onRename: () => void;
}) => (
  <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <SidebarMenuAction aria-label={row.actionsLabel ?? row.label} showOnHover>
        <Icon icon={EllipsisIcon} />
      </SidebarMenuAction>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" side="right">
      {(row.actions ?? []).map((action, index) =>
        action === "separator" ? (
          <DropdownMenuSeparator key={`separator-${index}`} />
        ) : (
          <DropdownMenuItem
            icon={action.icon}
            key={action.value}
            onSelect={() => {
              if (action.value === "rename" && row.onRename !== undefined) {
                onRename();
                return;
              }
              row.onAction?.(action.value);
            }}
            variant={action.danger === true ? "destructive" : "default"}
          >
            {action.label}
          </DropdownMenuItem>
        )
      )}
    </DropdownMenuContent>
  </DropdownMenu>
);

/** A row's own words and what stands with them: its icon, its name, a second line. */
const RowWords = ({ row }: { row: SidebarRow }) => (
  <>
    {row.icon === undefined ? null : <Icon icon={row.icon} />}
    {row.detail === undefined && row.quiet !== true ? row.label : null}
    {row.detail === undefined && row.quiet === true ? (
      <span {...stylex.props(styles.name, styles.quiet)}>{row.label}</span>
    ) : null}
    {row.detail === undefined ? null : (
      <span {...stylex.props(styles.words)}>
        <span
          {...stylex.props(styles.name, row.quiet === true && styles.quiet)}
        >
          {row.label}
        </span>
        <span {...stylex.props(styles.detail)}>{row.detail}</span>
      </span>
    )}
    {row.end === undefined ? null : (
      <span {...stylex.props(styles.end)}>
        <span aria-hidden="true">{row.end}</span>
        <span {...stylex.props(visuallyHidden)}>{row.endLabel ?? row.end}</span>
      </span>
    )}
    {row.count !== undefined &&
    row.count > 0 &&
    row.countLabel !== undefined ? (
      <span {...stylex.props(visuallyHidden)}>{row.countLabel}</span>
    ) : null}
    {row.working === true && row.workingLabel !== undefined ? (
      <span {...stylex.props(visuallyHidden)}>{row.workingLabel}</span>
    ) : null}
  </>
);

const Row = ({ row }: { row: SidebarRow }) => {
  const [renaming, setRenaming] = useState(false);
  const tall = row.detail === undefined ? undefined : styles.tall;
  const words = <RowWords row={row} />;
  return (
    <SidebarMenuItem>
      {row.render === undefined ? (
        <SidebarMenuButton
          isActive={row.current === true}
          onClick={(event) => {
            row.onClick?.(event);
          }}
          style={tall}
        >
          {words}
        </SidebarMenuButton>
      ) : (
        <SidebarMenuButton asChild isActive={row.current === true} style={tall}>
          {row.render({ children: words })}
        </SidebarMenuButton>
      )}
      {renaming && row.onRename !== undefined ? (
        <div {...stylex.props(styles.rename)}>
          <InlineEdit
            aria-label={row.renameLabel ?? row.label}
            defaultEditing
            onCancel={() => {
              setRenaming(false);
            }}
            onSubmit={(name) => {
              setRenaming(false);
              row.onRename?.(name);
            }}
            value={row.label}
          />
        </div>
      ) : null}
      {row.count !== undefined && row.count > 0 ? (
        <SidebarMenuBadge>
          <span aria-hidden="true">{row.count}</span>
        </SidebarMenuBadge>
      ) : null}
      {row.working === true ? (
        <SidebarMenuBadge>
          <AgentIndicator aria-hidden="true" />
        </SidebarMenuBadge>
      ) : null}
      {row.actions === undefined ? null : (
        <RowMenu
          onRename={() => {
            setRenaming(true);
          }}
          row={row}
        />
      )}
      {row.rows === undefined || row.rows.length === 0 ? null : (
        <SidebarMenuSub>
          {row.rows.map((sub) => (
            <SidebarMenuSubItem key={sub.id ?? sub.label}>
              {sub.render === undefined ? null : (
                <SidebarMenuSubButton asChild isActive={sub.current === true}>
                  {sub.render({ children: sub.label })}
                </SidebarMenuSubButton>
              )}
            </SidebarMenuSubItem>
          ))}
        </SidebarMenuSub>
      )}
    </SidebarMenuItem>
  );
};

const MoreRow = ({ more }: { more: SidebarMore }) => {
  const words = (
    <span {...stylex.props(styles.name, styles.more)}>{more.label}</span>
  );
  return (
    <SidebarMenuItem>
      {more.render === undefined ? (
        <SidebarMenuButton
          onClick={() => {
            more.onClick?.();
          }}
        >
          {words}
        </SidebarMenuButton>
      ) : (
        <SidebarMenuButton asChild>
          {more.render({ children: words })}
        </SidebarMenuButton>
      )}
    </SidebarMenuItem>
  );
};

const Rows = ({
  group,
  labelledBy,
  under = false,
}: {
  group: SidebarGroupEntry;
  labelledBy?: string;
  under?: boolean;
}) =>
  group.content ?? (
    <SidebarMenu
      aria-labelledby={labelledBy}
      style={under ? styles.under : undefined}
    >
      {group.rows.map((row) => (
        <Row key={row.id ?? row.label} row={row} />
      ))}
      {group.more === undefined ? null : <MoreRow more={group.more} />}
    </SidebarMenu>
  );

const Group = ({ group }: { group: SidebarGroupEntry }) => {
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
        <CollapsibleContent>
          <Rows group={group} labelledBy={labelId} under />
        </CollapsibleContent>
      </SidebarGroup>
    </SidebarCollapsible>
  );
};

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

/** A level of an area: Back and its name, its views, its rows. */
const SectionLevel = ({ section }: { section: SidebarSection }) => {
  const viewsId = useId();
  return (
    <SidebarLevel value={section.id}>
      <LevelHead
        back={section.back.render}
        backLabel={section.back.label}
        home={section.home}
        homeCurrent={section.homeCurrent}
        icon={section.icon}
        mark={section.mark}
        title={section.title}
      />
      {section.views === undefined ? null : (
        <SidebarSwitch
          id={viewsId}
          label={section.views.label}
          onChoose={(next) => {
            section.views?.onChange(next);
          }}
          panel={false}
          tabs={section.views.tabs}
          value={section.views.value}
        />
      )}
      <Nav groups={section.groups} label={section.navLabel ?? section.title} />
    </SidebarLevel>
  );
};

/** Every prop the product's sidebar takes. */
export interface FrameSidebarProps {
  /** What its landmark is called. */
  "aria-label": string;
  /** Grasp's mark, at the head's start. */
  mark: ReactNode;
  /** The search of the chats, at the head's end; none without it. */
  search?: { label: string; shortcut: string; onSearch: () => void };
  foldLabel: string;
  closeLabel: string;
  /** The main list's rows, in groups. */
  groups: readonly SidebarGroupEntry[];
  /** What the main list's rows are, as a landmark. */
  navLabel: string;
  /** One quiet sentence where the rows would be, when there are none. */
  empty?: string;
  /** The main list's views, under the head; the host gives each view's rows as `groups`. */
  tabs?: readonly SidebarTab[];
  tab?: string;
  onTabChange?: (value: string) => void;
  tabsLabel?: string;
  /** The area the person is in: its level takes the main list's place. */
  section?: SidebarSection;
  /** The person, at the foot. */
  profile: ReactNode;
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
  tabs,
  tab,
  onTabChange,
  tabsLabel,
  section,
  profile,
}: FrameSidebarProps) => {
  const { isMobile, setOpenMobile } = useSidebar();
  const switchId = useId();
  // The last area's level stays (unseen) after the person leaves it, so the
  // main list comes back in from the way they went.
  const [last, setLast] = useState(section);
  if (section !== undefined && section !== last) {
    setLast(section);
  }
  const shownSection = section ?? last;
  const chosen = tab ?? tabs?.[0]?.value ?? "";
  const rows = <Nav empty={empty} groups={groups} label={navLabel} />;
  return (
    <Sidebar aria-label={label} variant="inset">
      <SidebarHeader>
        <div {...stylex.props(styles.head, isMobile && styles.headInSheet)}>
          <span {...stylex.props(styles.mark)}>{mark}</span>
          <div {...stylex.props(styles.tools)}>
            {search === undefined ? null : (
              <SearchButton
                label={search.label}
                onSearch={() => {
                  // The search opens over the page: the phone's sheet goes first.
                  setOpenMobile(false);
                  search.onSearch();
                }}
                shortcut={search.shortcut}
              />
            )}
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
          {tabs === undefined || tabs.length === 0 ? (
            rows
          ) : (
            <>
              <SidebarSwitch
                id={switchId}
                label={tabsLabel ?? ""}
                onChoose={(next) => {
                  onTabChange?.(next);
                }}
                tabs={tabs}
                value={chosen}
              />
              <SwitchPanel id={switchId} value={chosen}>
                {rows}
              </SwitchPanel>
            </>
          )}
        </SidebarLevel>
        {shownSection === undefined ? null : (
          <SectionLevel key={shownSection.id} section={shownSection} />
        )}
      </SidebarLevels>
      <SidebarFooter>
        <div data-slot="sidebar-foot" {...stylex.props(styles.foot)}>
          {profile}
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
};
