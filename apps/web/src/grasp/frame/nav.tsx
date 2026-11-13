import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import * as stylex from "@stylexjs/stylex";
import type { ComponentType, ReactElement, ReactNode, SVGProps } from "react";

import { focus } from "../focus/focus.ts";
import { grasp, media } from "../tokens/tokens.stylex.ts";
import { frame } from "./frame.stylex.ts";

// The parts Grasp UI's sidebar is made of (grasp-sidebar.tsx), in StyleX:
// a list of rows, each a link (or a button) with its icon and name, a
// count where something waits, and rows under it. A row is quiet (the
// secondary words and icon) until the pointer is on it or the person is
// there, when it takes the selected fill and the primary words.

const styles = stylex.create({
  list: {
    display: "flex",
    flexDirection: "column",
    gap: frame.rowGap,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  row: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    gap: frame.iconGap,
    minWidth: 0,
    height: { default: frame.row, [media.coarse]: grasp.tap },
    paddingBlock: frame.rowBlock,
    paddingInline: frame.rowInline,
    borderWidth: 0,
    borderRadius: frame.corner,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    fontWeight: grasp.weightMedium,
    color: {
      default: frame.textSecondary,
      [media.hover]: {
        default: frame.textSecondary,
        ":hover": frame.textPrimary,
      },
    },
    backgroundColor: {
      default: "transparent",
      [media.hover]: { default: "transparent", ":hover": frame.hover },
    },
    letterSpacing: frame.tracking,
    textDecoration: "none",
    transitionProperty: "color, background-color",
    transitionDuration: { default: frame.answer, [media.reduced]: "0s" },
    transitionTimingFunction: grasp.ease,
    textAlign: "start",
    whiteSpace: "nowrap",
    cursor: "pointer",
  },
  // Where the person is.
  current: {
    color: frame.textPrimary,
    backgroundColor: frame.selected,
  },
  icon: {
    flexShrink: 0,
    width: frame.icon,
    height: frame.icon,
  },
  name: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "0%",
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  // A count: a small pill at the row's end.
  count: {
    flexShrink: 0,
    marginInlineStart: "auto",
    paddingInline: "5px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: frame.rule,
    borderRadius: grasp.cornerPill,
    backgroundColor: frame.card,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    fontWeight: grasp.weightMedium,
    fontVariantNumeric: "tabular-nums",
    color: frame.textSecondary,
  },
  srOnly: {
    position: "absolute",
    width: "1px",
    height: "1px",
    overflow: "hidden",
    clipPath: "inset(50%)",
    whiteSpace: "nowrap",
  },
  sub: {
    display: "flex",
    flexDirection: "column",
    gap: frame.rowGap,
    margin: 0,
    marginBlockStart: frame.rowGap,
    padding: 0,
    listStyle: "none",
  },
  // A row under a row: its name lines up with the name above.
  subRow: {
    display: "flex",
    alignItems: "center",
    minWidth: 0,
    height: { default: frame.row, [media.coarse]: grasp.tap },
    paddingInlineStart: `calc(${frame.rowInline} + ${frame.icon} + ${frame.iconGap})`,
    paddingInlineEnd: frame.rowInline,
    borderRadius: frame.corner,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    fontWeight: grasp.weightMedium,
    color: {
      default: frame.textSecondary,
      [media.hover]: {
        default: frame.textSecondary,
        ":hover": frame.textPrimary,
      },
    },
    backgroundColor: {
      default: "transparent",
      [media.hover]: { default: "transparent", ":hover": frame.hover },
    },
    letterSpacing: frame.tracking,
    textDecoration: "none",
    transitionProperty: "color, background-color",
    transitionDuration: { default: frame.answer, [media.reduced]: "0s" },
    transitionTimingFunction: grasp.ease,
    whiteSpace: "nowrap",
  },
  group: {
    display: "flex",
    flexDirection: "column",
    gap: frame.rowGap,
  },
  groupLabel: {
    margin: 0,
    paddingInline: frame.rowInline,
    paddingBlock: "8px 4px",
    fontFamily: grasp.fontSans,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    fontWeight: grasp.weightMedium,
    color: frame.textTertiary,
  },
});

/** A list of rows. */
export const NavList = ({
  children,
  ...props
}: {
  children: ReactNode;
  "aria-labelledby"?: string;
}) => (
  <ul {...props} {...stylex.props(styles.list)}>
    {children}
  </ul>
);

/** Words only a screen reader reads, such as what a count is of. */
export const Unseen = ({ children }: { children: ReactNode }) => (
  <span {...stylex.props(styles.srOnly)}>{children}</span>
);

/**
 * One row: `render` is what it is (a router's `<Link>`, or a `<button>`),
 * with its icon and `label`. `count`, where something waits: the number,
 * and `countLabel`, what a screen reader hears instead ("3 things
 * waiting"). Under it, `children`: its own rows (`NavSub`).
 */
export const NavEntry = ({
  render,
  icon: Icon,
  label,
  current = false,
  count,
  countLabel,
  trailing,
  onClick,
  children,
}: {
  render: ReactElement;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  label: string;
  current?: boolean;
  count?: number;
  countLabel?: ReactNode;
  trailing?: ReactNode;
  onClick?: () => void;
  children?: ReactNode;
}) => {
  const counted = count !== undefined && count > 0;
  const element = useRender({
    render,
    props: mergeProps<"a">(
      {},
      {
        ...stylex.props(styles.row, current && styles.current, focus.inside),
        "aria-current": current ? "page" : undefined,
        onClick,
        children: (
          <>
            <Icon aria-hidden="true" {...stylex.props(styles.icon)} />
            <span {...stylex.props(styles.name)}>{label}</span>
            {counted ? (
              <span aria-hidden="true" {...stylex.props(styles.count)}>
                {count}
              </span>
            ) : null}
            {counted && countLabel !== undefined ? (
              <Unseen>{countLabel}</Unseen>
            ) : null}
            {trailing}
          </>
        ),
      }
    ),
  });
  return (
    <li>
      {element}
      {children}
    </li>
  );
};

/** A row's own rows, under its name. */
export const NavSub = ({ children }: { children: ReactNode }) => (
  <ul {...stylex.props(styles.sub)}>{children}</ul>
);

/** One of a row's own rows: `render` is its link. */
export const NavSubEntry = ({
  render,
  label,
  current = false,
}: {
  render: ReactElement;
  label: string;
  current?: boolean;
}) => {
  const element = useRender({
    render,
    props: mergeProps<"a">(
      {},
      {
        ...stylex.props(styles.subRow, current && styles.current, focus.inside),
        "aria-current": current ? "page" : undefined,
        children: <span {...stylex.props(styles.name)}>{label}</span>,
      }
    ),
  });
  return <li>{element}</li>;
};

/** A group of rows under a label. */
export const NavGroup = ({
  label,
  labelId,
  children,
}: {
  label: string;
  labelId: string;
  children: ReactNode;
}) => (
  <div {...stylex.props(styles.group)}>
    <p id={labelId} {...stylex.props(styles.groupLabel)}>
      {label}
    </p>
    {children}
  </div>
);
