import { useRender } from "@base-ui/react/use-render";
import { useSidebar } from "@grasp-os/ui/components/sidebar";
import * as stylex from "@stylexjs/stylex";
import { Fragment } from "react";
import type { ReactElement, ReactNode } from "react";

import { focus } from "../focus/focus.ts";
import { iconVars } from "../icons/icon.stylex.ts";
import { Icon, SidebarToggle } from "../icons/index.ts";
import { grasp, media } from "../tokens/tokens.stylex.ts";
import { frame } from "./frame.stylex.ts";

// The bar above a page in Grasp UI's frame: flush on the page's ground,
// with no edge, where the page is (its crumbs) on the left and its actions
// on the right. The sidebar's button leads it on a phone, where the sidebar
// is a sheet, and wherever the sidebar is closed. It stays in view as the page scrolls, and keeps to one
// line: on a narrow window only the step before the page is kept, or the
// first alone (`phoneCrumbs`).

/** A step on the way to the page, and the link it renders as where it leads somewhere. */
export interface BarCrumb {
  label: string;
  link?: ReactElement;
}

const styles = stylex.create({
  bar: {
    position: "sticky",
    top: 0,
    zIndex: 30,
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: grasp.space3,
    minHeight: "48px",
    paddingInline: { default: "16px", [media.belowTablet]: frame.rowInline },
    paddingBlock: frame.rowBlock,
    backgroundColor: frame.card,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
  },
  // The sidebar's button: on a phone, where the sidebar is a sheet; on a
  // wider window only while the sidebar is closed, as its way back for the
  // keyboard (the pointer has the window's left edge).
  trigger: {
    [iconVars.size]: grasp.iconSm,
    display: { default: "none", [media.belowTablet]: "inline-flex" },
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    width: { default: frame.iconButton, [media.belowTablet]: grasp.tap },
    height: { default: frame.iconButton, [media.belowTablet]: grasp.tap },
    marginInlineStart: { default: "-4px", [media.belowTablet]: 0 },
    padding: 0,
    borderWidth: 0,
    borderRadius: frame.corner,
    backgroundColor: {
      default: "transparent",
      [media.hover]: { default: "transparent", ":hover": frame.hover },
    },
    color: {
      default: frame.textSecondary,
      [media.hover]: {
        default: frame.textSecondary,
        ":hover": frame.textPrimary,
      },
    },
    cursor: "pointer",
    transitionProperty: "color, background-color",
    transitionDuration: { default: frame.answer, [media.reduced]: "0s" },
    transitionTimingFunction: grasp.ease,
  },
  floating: {
    position: "absolute",
    zIndex: 3,
    top: frame.gutter,
    insetInlineStart: frame.gutter,
    marginInlineStart: 0,
  },
  triggerShown: {
    display: "inline-flex",
  },
  crumbs: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    minWidth: 0,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  crumb: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: grasp.space2,
    minWidth: 0,
    color: frame.textSecondary,
  },
  last: {
    flexShrink: 1,
    minWidth: "2rem",
  },
  hiddenBelowTablet: {
    display: { default: "flex", [media.belowTablet]: "none" },
  },
  hiddenBelowPhone: {
    display: { default: "flex", [media.belowPhone]: "none" },
  },
  link: {
    color: {
      default: frame.textSecondary,
      [media.hover]: {
        default: frame.textSecondary,
        ":hover": frame.textPrimary,
      },
    },
    textDecoration: "none",
    borderRadius: grasp.cornerMark,
    transitionProperty: "color",
    transitionDuration: grasp.durationHover,
    transitionTimingFunction: grasp.ease,
  },
  page: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: frame.textPrimary,
    fontWeight: grasp.weightMedium,
  },
  separator: {
    color: frame.textTertiary,
  },
  waiting: {
    width: "8rem",
    height: grasp.space4,
    borderRadius: grasp.cornerMark,
    backgroundColor: frame.selected,
  },
  trailing: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: grasp.space2,
  },
  actions: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: grasp.space2,
    marginInlineStart: "auto",
  },
});

/** A crumb that leads somewhere: its link, in the bar's link style. */
const CrumbLink = ({ link, label }: { link: ReactElement; label: string }) =>
  useRender({
    render: link,
    props: { ...stylex.props(styles.link, focus.words), children: label },
  });

/**
 * The sidebar's button: shown on a phone, where the sidebar is a sheet,
 * and wherever the sidebar is closed. In the bar, or on a page with no
 * bar (Chat), where it floats over its top left corner (`floating`).
 */
export const SidebarButton = ({
  label,
  floating = false,
}: {
  label: string;
  floating?: boolean;
}) => {
  const { toggleSidebar, open } = useSidebar();
  return (
    <button
      aria-label={label}
      data-icons="still"
      onClick={toggleSidebar}
      type="button"
      {...stylex.props(
        styles.trigger,
        !open && styles.triggerShown,
        floating && styles.floating,
        focus.ring
      )}
    >
      <Icon icon={SidebarToggle} />
    </button>
  );
};

/** The bar above a page. */
export const PageBar = ({
  crumbs,
  actions,
  trailing,
  phoneCrumbs = "last-two",
  triggerLabel,
  breadcrumbLabel,
}: {
  crumbs: readonly BarCrumb[];
  actions?: ReactNode;
  trailing?: ReactNode;
  phoneCrumbs?: "last-two" | "first";
  triggerLabel: string;
  breadcrumbLabel: string;
}) => {
  const last = crumbs.length - 1;
  const firstOnly = phoneCrumbs === "first";
  /** Whether step `index` (and the separator before it) is left out on a narrow window. */
  const narrow = (index: number) =>
    firstOnly
      ? index > 0 && styles.hiddenBelowPhone
      : index < last - 1 && styles.hiddenBelowTablet;
  return (
    <header
      data-icons="still"
      data-slot="site-header"
      {...stylex.props(styles.bar)}
    >
      <SidebarButton label={triggerLabel} />
      {crumbs.length === 0 ? (
        <div aria-hidden="true" {...stylex.props(styles.waiting)} />
      ) : (
        <nav aria-label={breadcrumbLabel}>
          <ol {...stylex.props(styles.crumbs)}>
            {crumbs.map((crumb, index) => (
              <Fragment key={`${index}:${crumb.label}`}>
                {index > 0 ? (
                  <li
                    aria-hidden="true"
                    {...stylex.props(styles.separator, narrow(index))}
                  >
                    /
                  </li>
                ) : null}
                <li
                  {...stylex.props(
                    styles.crumb,
                    index === last && styles.last,
                    narrow(index)
                  )}
                >
                  {crumb.link === undefined ? (
                    <span
                      aria-current={index === last ? "page" : undefined}
                      {...stylex.props(styles.page)}
                    >
                      {crumb.label}
                    </span>
                  ) : (
                    <CrumbLink label={crumb.label} link={crumb.link} />
                  )}
                </li>
              </Fragment>
            ))}
          </ol>
        </nav>
      )}
      {trailing === undefined ? null : (
        <div {...stylex.props(styles.trailing)}>{trailing}</div>
      )}
      {actions === undefined ? null : (
        <div {...stylex.props(styles.actions)}>{actions}</div>
      )}
    </header>
  );
};
