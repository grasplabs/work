// PageHeader: the title row of a page. The page's title in the serif with one line under it, the
// page's actions at the end of the row, and its tabs and its toolbar underneath. A page without a
// shell's bar may put a Breadcrumb above the title.
//
//   <PageHeader
//     title="Spring launch"
//     description="Everything the team ships in March."
//     actions={<Button>Share</Button>}
//     tabs={<Tabs …>…</Tabs>}
//     toolbar={<PageHeaderToolbar start={chips} end={search} />}
//   />
//
// The title is the page's h1. On a phone (the header under 40rem wide) the actions stay on the
// title's row: the main one, the last Button, at its end, and the others in one More menu beside
// it; under 20rem the main one is its icon alone, named by its words. That reads the Buttons given
// in `actions`; anything else there is drawn as given.
//
// `variant="banner"` is the head of a record's page: the page's whole width, flush under a shell's
// bar, a faint dither of light behind the title, and one hairline along its foot that draws from
// the start to the end once, when the page arrives. Every value is a token. A caller may set layout
// only (the `style` prop). Words that replace their placeholders fade in.
"use client";

import * as stylex from "@stylexjs/stylex";
import { Fragment, isValidElement, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";

import { useI18n } from "../lib/i18n";
import { EllipsisIcon, Icon, LoaderIcon } from "../lib/icons";
import type { IconData } from "../lib/icons";
import { fadeIn, texture } from "../lib/styles";
import {
  colors,
  duration,
  font,
  media,
  size as sizes,
  space,
} from "../lib/tokens.stylex";
import { isBlank } from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";
import { Button } from "./button";
import type { ButtonProps, ButtonSize } from "./button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./dropdown-menu";
import { pageBandVars } from "./page-header.stylex";
import { Skeleton } from "./skeleton";

/** Every prop a PageHeader takes. */
export interface PageHeaderProps {
  /** The page's name, in sentence case ("Spring launch"). It is the page's h1. */
  title: ReactNode;
  /** One line under the title: what the page holds. */
  description?: ReactNode;
  /**
   * How many lines the description may take before it is cut short with an ellipsis: 1 or 2 for one
   * someone wrote, which may run long. Cut short, a text description is whole in its title (a
   * pointer's tooltip) and to a screen reader, which reads the whole text.
   * @default "all"
   */
  descriptionLineClamp?: 1 | 2 | "all";
  /**
   * While `loading`: how many lines the description's placeholder reserves, when you know the
   * description wraps (a phone, a long line), so nothing moves when it arrives. Without it, the
   * clamp you set with `descriptionLineClamp`, or one line.
   */
  loadingLines?: number;
  /** Above the title: where the page sits, a Breadcrumb, for a page without a shell's bar. */
  breadcrumb?: ReactNode;
  /** Beside the title: a Badge that says its status. */
  badge?: ReactNode;
  /**
   * At the end of the title row: the page's own Buttons, the main one last. On a phone the main one
   * stays there (its icon alone, named by its words, when the row is narrowest) and the others fold
   * into one More menu beside it. Anything that is not a Button is drawn as given.
   */
  actions?: ReactNode;
  /**
   * `default` for a page of its own: the serif at heading-lg with a lead. `sm` for a settings page:
   * the serif at heading-md, a sentence (if any) at text-sm. `xs` for a sub-page whose crumbs
   * already say where you are: the title at heading-sm in the sans, a sentence at text-sm. Leave
   * the lead out on `sm` and `xs`.
   * @default "default"
   */
  size?: "xs" | "sm" | "default";
  /**
   * `default`, the header on the page's ground. `banner`, the head of a record's page: the page's
   * whole width, flush under a shell's bar and edge to edge of its card, a faint dither behind the
   * title, and one hairline along its foot that draws from the start to the end once, when the page
   * arrives. Its words start on the page column's line.
   * @default "default"
   */
  variant?: "default" | "banner";
  /**
   * The banner's dither in the colour of the page's object (an app's brand), fading down from the
   * top instead of the mint from the corner. Any CSS colour; drawn as faint, so words on it keep
   * their contrast. Only with `variant="banner"`.
   */
  accentColor?: string;
  /** Over the title: the page's object's own mark (an app's logo), decorative; the title names it. */
  media?: ReactNode;
  /** Under the title: the page's Tabs, when it has views. */
  tabs?: ReactNode;
  /**
   * The row under the title (and the tabs) that changes the list below: a PageHeaderToolbar, the
   * way to browse at its start and what narrows it at its end.
   */
  toolbar?: ReactNode;
  /**
   * Placeholders where the title and the line will be, while the page loads.
   * @default false
   */
  loading?: boolean;
  /** Layout only: margins and width. The look belongs to the header. */
  style?: LayoutStyle;
}

/** Every prop a PageHeaderToolbar takes. */
export interface PageHeaderToolbarProps {
  /** The way to browse: chips for the kinds of thing, at the start. They scroll sideways when they do not fit. */
  start?: ReactNode;
  /** What narrows the list, and the page's actions: a scope, a search, a button, at the end. */
  end?: ReactNode;
  /** Its name for a screen reader, when the page has more than one band of controls: "Outputs". */
  "aria-label"?: string;
  /** Layout only: where it sits, and how wide it is. */
  style?: LayoutStyle;
}

// The header's own width: on a phone it folds its actions (Buttons only) and keeps them on the
// title's row; narrowest, the main one is its icon.
const PHONE = "@container page-header (width < 40rem)";
const NARROWEST = "@container page-header (width < 20rem)";
// The width under which a toolbar's start and end stack, measured on the toolbar itself.
const TOOLBAR_NARROW = "@container (width < 40rem)";

// The banner's line, drawn from the start to the end.
const draw = stylex.keyframes({
  from: { transform: "scaleX(0)" },
  to: { transform: "scaleX(1)" },
});

const styles = stylex.create({
  // A banner: the page's padding taken back (a shell tells it, pageBandVars), so it stands flush
  // under the bar and edge to edge; its own padding the page's sides again, so its words start on
  // the page column's line. Compact on a phone.
  banner: {
    position: "relative",
    isolation: "isolate",
    marginBlockStart: `calc(-1 * ${pageBandVars.top})`,
    marginInline: `calc(-1 * ${pageBandVars.inline})`,
    paddingInline: `max(${pageBandVars.inline}, ${space[5]})`,
    paddingBlockStart: { default: space[7], [media.maxSm]: space[5] },
    paddingBlockEnd: { default: space[6], [media.maxSm]: space[4] },
    // The page keeps its room under the banner, as under a header on its ground.
    marginBlockEnd: space[6],
    // As tall as a page panel's head beside it: its line, drawn just under it, meets the panel's
    // line as one.
    boxSizing: "border-box",
    minHeight: sizes.sidePanelHead,
  },
  // In a banner the actions stand on the title's line at every width, never level with the line
  // under it.
  rowTop: { alignItems: "flex-start" },
  // One hairline along the foot, start to end, drawn once as the page arrives; at once with
  // reduced motion. A re-render never starts it again.
  bannerLine: {
    position: "absolute",
    insetInline: 0,
    top: "100%",
    height: sizes.hairline,
    backgroundColor: colors.border,
    transformOrigin: { default: "left", ":dir(rtl)": "right" },
    animationName: { default: draw, [media.reducedMotion]: "none" },
    animationDuration: duration.open,
    animationTimingFunction: duration.ease,
    animationFillMode: "both",
  },
  header: {
    containerType: "inline-size",
    containerName: "page-header",
    display: "grid",
    rowGap: space[3],
    minWidth: 0,
    fontFamily: font.sans,
  },
  // The actions stand 16px from the words, level with their last line.
  row: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "flex-end",
    justifyContent: "space-between",
    columnGap: space[4],
    rowGap: space[4],
    minWidth: 0,
  },
  words: {
    display: "grid",
    rowGap: space[1],
    flexGrow: 1,
    flexBasis: "20rem",
    minWidth: 0,
  },
  titleRow: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: space[3],
    rowGap: space[1],
    minWidth: 0,
  },
  // The object's mark over the title, its own size, the title's gap under it.
  media: { display: "flex", marginBlockEnd: space[3] },
  // The title: the serif at heading-lg, as Heading's `lg`, and it may shrink beside the actions.
  title: {
    margin: 0,
    minWidth: 0,
    color: colors.foreground,
    overflowWrap: "break-word",
    textWrap: "balance",
    fontFamily: font.serif,
    fontWeight: font.weightNormal,
    letterSpacing: font.trackingTitle,
    fontSize: font.headingLg,
    lineHeight: font.headingLgLine,
  },
  // A settings page's title: the serif at the middle size (Heading's `default`).
  titleSm: { fontSize: font.headingMd, lineHeight: font.headingMdLine },
  // A sub-page's title: a step down, in the sans, as a component's own title.
  titleXs: {
    fontFamily: font.sans,
    fontSize: font.headingSm,
    lineHeight: font.headingSmLine,
    fontWeight: font.weightMedium,
    letterSpacing: font.trackingUiTitle,
  },
  // The line under it: text-lg in muted, its lines evened; text-sm on the smaller sizes.
  description: {
    margin: 0,
    fontFamily: font.sans,
    fontSize: font.textLg,
    lineHeight: font.textLgLine,
    fontWeight: font.weightNormal,
    letterSpacing: font.trackingUi,
    color: colors.mutedForeground,
    overflowWrap: "break-word",
    textWrap: "pretty",
  },
  descriptionSm: { fontSize: font.textSm, lineHeight: font.textSmLine },
  actions: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space[2],
    flexShrink: 0,
    minHeight: font.headingLgLine,
  },
  actionsSm: { minHeight: font.headingMdLine },
  actionsXs: { minHeight: font.headingSmLine },
  tabs: {
    minWidth: 0,
    marginTop: space[3],
  },
  // Folding: on a phone the row is a grid: the title and the actions on its first line, the line
  // under the title across the whole width beneath them, as it is without actions.
  rowFolds: {
    display: { default: "flex", [PHONE]: "grid" },
    gridTemplateColumns: { default: null, [PHONE]: "minmax(0, 1fr) auto" },
    rowGap: { default: space[4], [PHONE]: space[1] },
    alignItems: { default: "flex-end", [PHONE]: "start" },
  },
  wordsFold: { display: { default: "grid", [PHONE]: "contents" } },
  // With a title alone on its line, on a phone the actions hold the end of the title's first line
  // only: an unseen copy of them floats there inside the h1, so the title's later lines run the
  // whole width under them, and the actions themselves stand over that copy. The words and the
  // actions share one cell, the actions at its top end over the room.
  rowFloats: {
    display: { default: "flex", [PHONE]: "grid" },
    gridTemplateColumns: { default: null, [PHONE]: "minmax(0, 1fr)" },
    alignItems: { default: "flex-end", [PHONE]: "start" },
  },
  oneCell: { gridColumn: 1, gridRow: 1 },
  phoneFloats: { gridColumn: 1, gridRow: 1, justifySelf: "end" },
  // Balanced lines are measured without the float, so beside it they run under the actions. It
  // fills its line, so the room stands at the line's end even after a short title.
  titleFlows: {
    textWrap: { default: "balance", [PHONE]: "pretty" },
    flexGrow: 1,
  },
  room: {
    display: { default: "none", [PHONE]: "flex" },
    float: "inline-end",
    alignItems: "center",
    gap: space[2],
    marginInlineStart: space[4],
    // Exactly one of the title's lines tall, at every size: only its width matters.
    height: "1lh",
    // Unseen by opacity: Button's own layers set their visibility, which a hidden parent cannot
    // undo. It lies exactly under the actions themselves, aria-hidden and inert.
    opacity: 0,
    pointerEvents: "none",
  },
  under: { gridColumn: { default: null, [PHONE]: "1 / -1" } },
  wide: { display: { default: "flex", [PHONE]: "none" } },
  phone: {
    display: { default: "none", [PHONE]: "flex" },
    flexWrap: "nowrap",
    alignSelf: "start",
  },
  phoneColumn: { gridColumn: 2, gridRow: 1 },
  // Each action of the wide row, as it is: a box that takes no room of its own.
  given: { display: "contents" },
  mainWords: { display: { default: "contents", [NARROWEST]: "none" } },
  mainIcon: { display: { default: "none", [NARROWEST]: "contents" } },

  // The title's placeholder: never wider than its room (a phone is narrower than a title is long),
  // and one line of the title tall, a lead's line of Skeleton in its middle: the line keeps its
  // room, so nothing moves when the title arrives.
  titleWait: {
    display: "grid",
    alignContent: "center",
    width: "100%",
    maxWidth: sizes.pageTitleWait,
    height: font.headingLgLine,
  },
  titleWaitSm: { height: font.headingMdLine },
  titleWaitXs: { height: font.headingSmLine },
  // A description cut short at its line, with an ellipsis. Its height never changes.
  clamp: {
    display: "-webkit-box",
    WebkitBoxOrient: "vertical",
    overflow: "hidden",
  },
  clampOne: { WebkitLineClamp: 1 },
  clampTwo: { WebkitLineClamp: 2 },
  // Its lines stacked as the description's own lines stand: no gap between them.
  descriptionWaitLines: { display: "grid", minWidth: 0 },

  // ---- The banner's texture ----
  // The shared texture (lib's `texture`), under the banner's words.
  textureBehind: { zIndex: -1 },
  // In the object's own colour: from the top, down, the same in either direction. In the dark the
  // colour's own hue and strength at a lightness that shows on a dark ground.
  tinted: (tint: string) => ({
    backgroundImage: `linear-gradient(to bottom, light-dark(${tint}, oklch(from ${tint} 0.72 c h)), transparent 85%)`,
  }),

  // ---- PageHeaderToolbar ----
  // The container the toolbar measures; the toolbar itself is laid out inside it.
  toolbarFrame: {
    containerType: "inline-size",
    minWidth: 0,
  },
  toolbar: {
    display: "flex",
    flexDirection: { default: "row", [TOOLBAR_NARROW]: "column" },
    alignItems: { default: "center", [TOOLBAR_NARROW]: "stretch" },
    justifyContent: "space-between",
    gap: space[3],
    minWidth: 0,
    paddingBlockEnd: space[3],
    fontFamily: font.sans,
  },
  // The chips: one line that scrolls, with room for their focus rings at the ends. A box that
  // scrolls clips what reaches past it, so on a touch screen it also makes room above and below
  // for each chip's 44px touch area, and takes that room back from the toolbar so nothing moves.
  toolbarStart: {
    display: "flex",
    alignItems: "center",
    gap: space[1],
    minWidth: 0,
    overflowX: "auto",
    scrollbarWidth: "none",
    marginInline: `calc(-1 * ${space[1]})`,
    paddingInline: space[1],
    paddingBlock: {
      default: space[1],
      [media.pointerCoarse]: `calc((${sizes.tapTarget} - ${sizes.toggleHeight}) / 2)`,
    },
    marginBlock: {
      default: 0,
      [media.pointerCoarse]: `calc(${space[1]} - (${sizes.tapTarget} - ${sizes.toggleHeight}) / 2)`,
    },
  },
  // The narrowing controls: the room the start leaves, beside it, and the row when stacked. Their
  // width is the toolbar's, not their content's, so a field that gains its clear button as you
  // type moves nothing: a growing field (a search) takes the room, the rest keep their own width.
  toolbarEnd: {
    display: "flex",
    flexGrow: 1,
    flexBasis: { default: 0, [TOOLBAR_NARROW]: "auto" },
    justifyContent: "flex-end",
    flexWrap: { default: "nowrap", [TOOLBAR_NARROW]: "wrap" },
    alignItems: "center",
    gap: space[2],
    minWidth: 0,
    flexShrink: { default: 0, [TOOLBAR_NARROW]: 1 },
  },
});

/** Each size's own look, over the default one's. */
const sizeLooks = {
  default: {
    title: null,
    description: null,
    actions: null,
    titleWait: null,
  },
  sm: {
    title: styles.titleSm,
    description: styles.descriptionSm,
    actions: styles.actionsSm,
    titleWait: styles.titleWaitSm,
  },
  xs: {
    title: styles.titleXs,
    description: styles.descriptionSm,
    actions: styles.actionsXs,
    titleWait: styles.titleWaitXs,
  },
} as const;

type Look = (typeof sizeLooks)[keyof typeof sizeLooks];

/** The faint dither of light behind a banner's title. */
const Texture = ({ tint }: { tint: string | undefined }) => (
  <span
    aria-hidden="true"
    data-slot="page-header-texture"
    data-tinted={tint === undefined ? undefined : ""}
    {...stylex.props(
      texture,
      styles.textureBehind,
      tint !== undefined && styles.tinted(tint)
    )}
  />
);

/** The description's placeholder: one Skeleton line per line it will take (the hint, else the clamp, else one). */
const DescriptionWait = ({
  lines,
  clamp,
}: {
  lines: number | undefined;
  clamp: 1 | 2 | "all";
}) => (
  <div {...stylex.props(styles.descriptionWaitLines)}>
    {Array.from(
      {
        length: Math.max(1, Math.round(lines ?? (clamp === "all" ? 1 : clamp))),
      },
      (_, index) => (
        <Skeleton key={index} size="lg" />
      )
    )}
  </div>
);

/** Words that replace the placeholders fade in; a header that never waited is simply there. */
const useArrived = (loading: boolean) => {
  const [waited, setWaited] = useState(loading);
  if (loading && !waited) {
    setWaited(true);
  }
  return waited && !loading;
};

/** Children as a flat list: lists and fragments opened. */
const flat = (children: ReactNode): ReactNode[] => {
  if (Array.isArray(children)) {
    return children.flatMap((child: ReactNode) => flat(child));
  }
  if (
    isValidElement<{ children?: ReactNode }>(children) &&
    children.type === Fragment
  ) {
    return flat(children.props.children);
  }
  return children === null ||
    children === undefined ||
    typeof children === "boolean"
    ? []
    : [children];
};

/** What a Button draws: its own children, or, with `asChild`, its child element's. */
const insideOf = (props: ButtonProps): ReactNode[] => {
  if (
    props.asChild === true &&
    isValidElement<{ children?: ReactNode }>(props.children)
  ) {
    return flat(props.children.props.children);
  }
  return flat(props.children);
};

/** A Button's words as one string, for its name when it is its icon alone and for a menu item. */
const wordsOf = (props: ButtonProps) => {
  const words = insideOf(props)
    .filter(
      (child): child is string | number =>
        typeof child === "string" || typeof child === "number"
    )
    .map(String)
    .join("")
    .trim();
  return words === "" ? (props["aria-label"] ?? "") : words;
};

/** The icon a Button shows (`<Icon icon={…} />` among its children), if any. */
const iconOf = (props: ButtonProps): IconData | undefined => {
  const mark = insideOf(props).find(
    (child): child is ReactElement<{ icon: IconData }> =>
      isValidElement(child) && child.type === Icon
  );
  return mark?.props.icon;
};

/** Whether a Button is at work: the page gave it `status="loading"`. */
const isWorking = (props: ButtonProps) => props.status === "loading";

/** The address of a Button drawn as a link (`asChild` with an `<a href>`), if it is one. */
const hrefOf = (props: ButtonProps): string | undefined => {
  if (
    props.asChild === true &&
    isValidElement<{ href?: unknown }>(props.children) &&
    props.children.type === "a" &&
    typeof props.children.props.href === "string"
  ) {
    return props.children.props.href;
  }
  return undefined;
};

/** The icon-only size of a Button's size: the same height, square. */
const iconSizeOf = (size: ButtonSize | undefined): ButtonSize => {
  if (size === "xs" || size === "icon-xs") {
    return "icon-xs";
  }
  if (size === "sm" || size === "icon-sm") {
    return "icon-sm";
  }
  return size === "lg" || size === "icon-lg" ? "icon-lg" : "icon";
};

/** The More button's size: the main action's, as a square, and a step smaller beside a main one of the default size. */
const moreSizeOf = (size: ButtonSize | undefined): ButtonSize =>
  size === undefined ? "icon-sm" : iconSizeOf(size);

interface Folding {
  /** The main action: the last Button. */
  main: ReactElement<ButtonProps>;
  /** The others, in order: folded into the More menu on a phone. */
  others: ReactElement<ButtonProps>[];
  /** All of them, as given. */
  all: ReactElement<ButtonProps>[];
}

/**
 * The Buttons in `actions`, when every action is a Button with words; else nothing to fold. Any
 * other part among them (a HoldButton, whose ask a menu cannot stand for) keeps them as given.
 */
const foldingOf = (actions: ReactNode): Folding | undefined => {
  const given = flat(actions);
  const all = given.filter(
    (child): child is ReactElement<ButtonProps> =>
      isValidElement<ButtonProps>(child) && child.type === Button
  );
  const main = all.at(-1);
  if (
    main === undefined ||
    all.length !== given.length ||
    all.some((button) => wordsOf(button.props) === "")
  ) {
    return undefined;
  }
  return { main, others: all.slice(0, -1), all };
};

/** The main Button as its icon alone, its words its name: only a Button that is not drawn as its child. */
const IconOnly = ({ button }: { button: ReactElement<ButtonProps> }) => {
  const icon = iconOf(button.props);
  if (icon === undefined || button.props.asChild === true) {
    return null;
  }
  const { children: _children, size, ...rest } = button.props;
  return (
    <span {...stylex.props(styles.mainIcon)}>
      <Button
        {...rest}
        size={iconSizeOf(size)}
        aria-label={wordsOf(button.props)}
      >
        <Icon icon={icon} />
      </Button>
    </span>
  );
};

/** The main Button with its words, which give way to its icon alone when the row is narrowest. */
const Main = ({ button }: { button: ReactElement<ButtonProps> }) => {
  const shrinks =
    iconOf(button.props) !== undefined && button.props.asChild !== true;
  return (
    <>
      <span {...stylex.props(shrinks ? styles.mainWords : undefined)}>
        {button}
      </span>
      <IconOnly button={button} />
    </>
  );
};

/**
 * One folded Button as an item of More: its words and icon, disabled as it is, a link when it is one
 * (so a modifier click opens a new tab), and while it works disabled, the spinner's mark in its
 * icon's place. A plain one, chosen, presses its own Button.
 */
const FoldedItem = ({
  button,
  onPress,
}: {
  button: ReactElement<ButtonProps>;
  onPress: () => void;
}) => {
  const { props } = button;
  const working = isWorking(props);
  const words = wordsOf(props);
  const href = hrefOf(props);
  const shared = {
    icon: working ? LoaderIcon : iconOf(props),
    variant:
      props.variant === "destructive"
        ? ("destructive" as const)
        : ("default" as const),
    disabled: props.disabled === true || working,
  };
  if (href !== undefined) {
    return (
      <DropdownMenuItem {...shared} asChild>
        <a href={href}>{words}</a>
      </DropdownMenuItem>
    );
  }
  return (
    <DropdownMenuItem {...shared} onSelect={onPress}>
      {words}
    </DropdownMenuItem>
  );
};

/**
 * The room the actions take at the end of the title's first line, on a phone: the same Buttons,
 * unseen (opacity), out of the accessibility tree and inert, floated inside the h1 under the
 * actions themselves, so its words flow round them and then run the whole width beneath.
 */
const Room = ({ folding }: { folding: Folding }) => {
  const { main, others } = folding;
  return (
    <span aria-hidden="true" inert {...stylex.props(styles.room)}>
      {others.length > 0 && (
        <Button
          variant="ghost"
          size={moreSizeOf(main.props.size)}
          aria-label=""
        >
          <Icon icon={EllipsisIcon} />
        </Button>
      )}
      <Main button={main} />
    </span>
  );
};

/**
 * The actions: as given on a wide row; on a phone the main one at the end and the others folded into
 * one More menu beside it, a destructive one last and apart. A folded action, chosen, presses its
 * own Button, kept in the wide row, which is `display: none` there: out of the tab order, the
 * accessibility tree and a page search. Its handler and its states stay its own.
 */
const Folded = ({
  folding,
  look,
  floats,
}: {
  folding: Folding;
  look: stylex.StyleXStyles;
  floats: boolean;
}) => {
  const wide = useRef<HTMLDivElement | null>(null);
  const { dropdownMenu } = useI18n();
  const { main, others, all } = folding;
  const press = (button: ReactElement<ButtonProps>) => () => {
    const own = wide.current?.querySelectorAll<HTMLElement>(
      ":scope > [data-page-action] > *"
    );
    own?.[all.indexOf(button)]?.click();
  };
  const plain = others.filter(
    (button) => button.props.variant !== "destructive"
  );
  const destructive = others.filter(
    (button) => button.props.variant === "destructive"
  );
  return (
    <>
      <div ref={wide} {...stylex.props(styles.actions, look, styles.wide)}>
        {all.map((button, index) => (
          <span
            key={button.key ?? index}
            data-page-action=""
            {...stylex.props(styles.given)}
          >
            {button}
          </span>
        ))}
      </div>
      <div
        {...stylex.props(
          styles.actions,
          look,
          styles.phone,
          floats ? styles.phoneFloats : styles.phoneColumn
        )}
      >
        {others.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size={moreSizeOf(main.props.size)}
                aria-label={dropdownMenu.expand}
              >
                <Icon icon={EllipsisIcon} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {plain.map((button) => (
                <FoldedItem
                  key={all.indexOf(button)}
                  button={button}
                  onPress={press(button)}
                />
              ))}
              {plain.length > 0 && destructive.length > 0 && (
                <DropdownMenuSeparator />
              )}
              {destructive.map((button) => (
                <FoldedItem
                  key={all.indexOf(button)}
                  button={button}
                  onPress={press(button)}
                />
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <Main button={main} />
      </div>
    </>
  );
};

/** The title, the line under it and what stands beside the title, or their placeholders. */
const Words = ({
  title,
  description,
  descriptionLineClamp,
  loadingLines,
  badge,
  loading,
  look,
  folds,
  room,
  oneCell,
}: Pick<PageHeaderProps, "title" | "description" | "badge" | "loadingLines"> & {
  descriptionLineClamp: NonNullable<PageHeaderProps["descriptionLineClamp"]>;
  loading: boolean;
  look: Look;
  folds: boolean;
  room: ReactNode;
  oneCell: boolean;
}) => {
  const arrived = useArrived(loading);

  const wait = (
    <DescriptionWait lines={loadingLines} clamp={descriptionLineClamp} />
  );
  return (
    <div
      {...stylex.props(
        styles.words,
        folds && styles.wordsFold,
        oneCell && styles.oneCell
      )}
    >
      {loading ? (
        <>
          <span {...stylex.props(styles.titleWait, look.titleWait)}>
            <Skeleton size="lg" />
          </span>
          {description !== undefined &&
            (folds ? <div {...stylex.props(styles.under)}>{wait}</div> : wait)}
        </>
      ) : (
        <>
          <div {...stylex.props(styles.titleRow, arrived && fadeIn)}>
            <h1
              {...stylex.props(
                styles.title,
                look.title,
                room !== false && room !== undefined && styles.titleFlows
              )}
            >
              {room}
              {title}
            </h1>
            {badge}
          </div>
          {description !== undefined && (
            <p
              title={
                descriptionLineClamp !== "all" &&
                typeof description === "string"
                  ? description
                  : undefined
              }
              {...stylex.props(
                styles.description,
                look.description,
                descriptionLineClamp !== "all" && styles.clamp,
                descriptionLineClamp === 1 && styles.clampOne,
                descriptionLineClamp === 2 && styles.clampTwo,
                folds && styles.under,
                arrived && fadeIn
              )}
            >
              {description}
            </p>
          )}
        </>
      )}
    </div>
  );
};

/** The object's mark over the title, when given: decorative, the title names it. */
const Media = ({ media: mark }: { media: ReactNode }) =>
  mark === undefined || mark === null ? null : (
    <span
      aria-hidden="true"
      data-slot="page-header-media"
      {...stylex.props(styles.media)}
    >
      {mark}
    </span>
  );

export const PageHeader = ({
  title,
  description,
  descriptionLineClamp = "all",
  loadingLines,
  breadcrumb,
  badge,
  actions,
  tabs,
  toolbar,
  loading = false,
  size = "default",
  variant = "default",
  accentColor,
  media: mark,
  style,
}: PageHeaderProps) => {
  const look = sizeLooks[size];
  const folding = foldingOf(actions);
  // The title's later lines run under the actions when the title stands alone on its line, words
  // and not placeholders; with something beside it, the actions keep a column of their own.
  const floats = folding !== undefined && !loading && badge === undefined;
  const banner = variant === "banner";
  return (
    <header
      data-slot="page-header"
      data-variant={variant}
      aria-busy={loading ? true : undefined}
      {...stylex.props(styles.header, banner && styles.banner, style)}
    >
      {banner && <Texture tint={accentColor} />}
      {breadcrumb}
      <Media media={mark} />
      <div
        {...stylex.props(
          styles.row,
          folding !== undefined &&
            (floats ? styles.rowFloats : styles.rowFolds),
          banner && styles.rowTop
        )}
      >
        <Words
          title={title}
          description={description}
          descriptionLineClamp={descriptionLineClamp}
          loadingLines={loadingLines}
          badge={badge}
          loading={loading}
          look={look}
          folds={folding !== undefined && !floats}
          room={floats && <Room folding={folding} />}
          oneCell={floats}
        />
        {folding === undefined ? (
          actions !== undefined && (
            <div {...stylex.props(styles.actions, look.actions)}>{actions}</div>
          )
        ) : (
          <Folded folding={folding} look={look.actions} floats={floats} />
        )}
      </div>
      {tabs !== undefined && <div {...stylex.props(styles.tabs)}>{tabs}</div>}
      {toolbar}
      {banner && (
        <span
          aria-hidden="true"
          data-slot="page-header-banner-line"
          {...stylex.props(styles.bannerLine)}
        />
      )}
    </header>
  );
};

/**
 * The row under a page's header that changes the list below: the way to browse (chips for the kinds
 * of thing) at the start, what narrows it (a scope, a search) and the page's own actions at the
 * end. Narrower than 40rem of its own width, the two stack, and the chips scroll sideways rather
 * than wrap. Give it as the PageHeader's `toolbar`.
 */
export const PageHeaderToolbar = ({
  start,
  end,
  "aria-label": label,
  style,
}: PageHeaderToolbarProps) => (
  <div {...stylex.props(styles.toolbarFrame, style)}>
    <div
      data-slot="page-header-toolbar"
      role={label !== undefined && label !== "" ? "group" : undefined}
      aria-label={label}
      {...stylex.props(styles.toolbar)}
    >
      {isBlank(start) ? (
        <span />
      ) : (
        <div {...stylex.props(styles.toolbarStart)}>{start}</div>
      )}
      {isBlank(end) ? null : (
        <div {...stylex.props(styles.toolbarEnd)}>{end}</div>
      )}
    </div>
  </div>
);
