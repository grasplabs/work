import {
  AppShellNav,
  AppShellSwitch,
} from "@grasp-os/ui/blocks/app-shell-01/app-shell-01-sidebar";
import type {
  AppShellNavGroup,
  AppShellTab,
} from "@grasp-os/ui/blocks/app-shell-01/app-shell-01-sidebar";
import {
  SidebarLevel,
  SidebarLevelHeader,
  SidebarLevels,
  SidebarLevelTitle,
  SidebarLevelTrigger,
} from "@grasp-os/ui/components/sidebar";
import { Icon } from "@grasp-os/ui/lib/icons";
import type { IconData } from "@grasp-os/ui/lib/icons";
import { size } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";
import type { ReactElement, ReactNode } from "react";

// The product's sidebar levels, as the reference's (#2503's grasp/sidebar):
// the main list, and while a page of an area with a navigation of its own
// is open (Settings, an App, an agent, the Brain, Integrations) that area's
// level in its place, with Back and its name as one row, its views and its
// rows, drawn with Damsko's Sidebar and AppShell parts. The areas give
// their levels as data.

/** Views of a level's page, under its name, in the switch (an App's preview widths). */
export interface SidebarSectionViews {
  label: string;
  tabs: readonly AppShellTab[];
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
  /** Where Back leads, as a link with no words (`<Link to="/apps" />`), and its name. */
  back: { label: string; link: ReactElement<Record<string, unknown>> };
  /**
   * The area's own first page, as a link holding its mark (`lead`) and its
   * name, each as a child of its own: its name opens it.
   */
  home: (lead: ReactNode, title: string) => ReactElement;
  homeCurrent?: boolean;
  views?: SidebarSectionViews;
  groups: readonly AppShellNavGroup[];
  /** What its rows are, said as a landmark. @default `title` */
  navLabel?: string;
}

const styles = stylex.create({
  // An area's own mark (an agent's face), in an icon's room.
  mark: {
    display: "inline-flex",
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    width: size.sidebarIcon,
    height: size.sidebarIcon,
  },
});

/** A level of an area: Back and its name, its views, its rows. */
const SectionLevel = ({ section }: { section: SidebarSection }) => {
  let lead: ReactNode = null;
  if (section.mark !== undefined) {
    lead = (
      <span aria-hidden="true" {...stylex.props(styles.mark)}>
        {section.mark}
      </span>
    );
  } else if (section.icon !== undefined) {
    lead = <Icon icon={section.icon} />;
  }
  return (
    <SidebarLevel value={section.id}>
      <SidebarLevelHeader>
        <SidebarLevelTrigger
          aria-label={section.back.label}
          asChild
          value="main"
        >
          {section.back.link}
        </SidebarLevelTrigger>
        <SidebarLevelTitle asChild isActive={section.homeCurrent === true}>
          {section.home(lead, section.title)}
        </SidebarLevelTitle>
      </SidebarLevelHeader>
      {section.views === undefined ? null : (
        <AppShellSwitch
          aria-label={section.views.label}
          onValueChange={(next) => {
            section.views?.onChange(next);
          }}
          tabs={section.views.tabs}
          value={section.views.value}
        />
      )}
      <AppShellNav
        aria-label={section.navLabel ?? section.title}
        groups={section.groups}
      />
    </SidebarLevel>
  );
};

/** The main list (`children`), and while one is open an area's level in its place. */
export const FrameLevels = ({
  section,
  children,
}: {
  section: SidebarSection | undefined;
  children: ReactNode;
}) => {
  // The last area's level stays (unseen) after the person leaves it, so the
  // main list comes back in from the way they went.
  const [last, setLast] = useState(section);
  if (section !== undefined && section !== last) {
    setLast(section);
  }
  const shown = section ?? last;
  return (
    <SidebarLevels value={section?.id ?? "main"}>
      <SidebarLevel value="main">{children}</SidebarLevel>
      {shown === undefined ? null : (
        <SectionLevel key={shown.id} section={shown} />
      )}
    </SidebarLevels>
  );
};
