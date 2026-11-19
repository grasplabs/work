"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import {
  Fragment,
  createElement,
  isValidElement,
  useRef,
  useState,
} from "react";
import type { ReactElement, ReactNode } from "react";

import { Button } from "../button";
import type { ButtonProps } from "../button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../dropdown-menu";
import { dropdownMenuWords } from "../dropdown-menu/words";
import { More, Spinner } from "../icons";
import type { LayoutStyle } from "../layout/layout";
import { arrive } from "../motion/arrive";
import { Skeleton } from "../skeleton/skeleton";
import { grasp } from "../tokens/tokens.stylex";
import { useWords } from "../words/words";

/** What a caller may style: where the header sits, and how wide it is. Never its look. */
export type PageHeaderLayoutStyle = LayoutStyle;

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
  descriptionLines?: 1 | 2 | "all";
  /**
   * While `loading`: how many lines the description's placeholder reserves, when you know the
   * description wraps (a phone, a long line), so nothing moves when it arrives. Without it, the
   * clamp you set with `descriptionLines`, or one line.
   */
  loadingLines?: number;
  /** Above the title: where the page sits, a Breadcrumb, for a page without an App shell (whose page bar holds the crumbs). */
  breadcrumb?: ReactNode;
  /** Beside the title: a badge that says its status. */
  aside?: ReactNode;
  /**
   * At the end of the title row: the page's own Buttons, the main one last. On a phone the main one
   * stays there (its icon alone, named by its words, when the row is narrowest) and the others fold
   * into one More menu beside it. Anything that is not a Button is drawn as given.
   */
  actions?: ReactNode;
  /**
   * `lg` for a page of its own: the serif title-lg with a lead. `md` for a settings page: the serif
   * at title-md, a sentence (if any) at text-sm, as dense as `sm`. `sm` for a sub-page whose crumbs
   * already say where you are: the title at title-sm in the sans, and a sentence, if any, at text-sm.
   * Leave the lead out on `md` and `sm`.
   * @default "lg"
   */
  size?: "lg" | "md" | "sm";
  /** Under the title: the page's Tabs, when it has views. */
  tabs?: ReactNode;
  /**
   * Placeholders where the title and the line will be, while the page loads.
   * @default false
   */
  loading?: boolean;
  /** @deprecated Use `layout`. */
  style?: PageHeaderLayoutStyle;
  /** Layout only: margins and width. The look belongs to the header. */
  layout?: PageHeaderLayoutStyle;
}

// The header's own width: on a phone it folds its actions (Buttons only) and keeps them on the
// title's row; narrowest, the main one is its icon.
const PHONE = "@container page-header (width < 40rem)";
const NARROWEST = "@container page-header (width < 20rem)";

const styles = stylex.create({
  header: {
    containerType: "inline-size",
    containerName: "page-header",
    display: "grid",
    rowGap: grasp.space3,
    minWidth: 0,
    fontFamily: grasp.fontSans,
  },
  // As Palermo's section header: the actions stand 16px from the words, level with their last line.
  row: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "flex-end",
    justifyContent: "space-between",
    columnGap: grasp.space4,
    rowGap: grasp.space4,
    minWidth: 0,
  },
  words: {
    display: "grid",
    rowGap: grasp.space1,
    flexGrow: 1,
    flexBasis: "20rem",
    minWidth: 0,
  },
  titleRow: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: grasp.space3,
    rowGap: grasp.space1,
    minWidth: 0,
  },
  title: {
    margin: 0,
    minWidth: 0,
    fontFamily: grasp.fontSerif,
    fontSize: grasp.titleLg,
    lineHeight: grasp.titleLgLine,
    fontWeight: grasp.weightRegular,
    letterSpacing: grasp.trackingTitle,
    color: grasp.ink,
    textWrap: "balance",
    overflowWrap: "break-word",
  },
  description: {
    margin: 0,
    fontSize: grasp.textLg,
    lineHeight: grasp.textLgLine,
    color: grasp.muted,
    textWrap: "pretty",
    overflowWrap: "break-word",
  },
  actions: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: grasp.space2,
    flexShrink: 0,
    minHeight: grasp.titleLgLine,
  },
  tabs: {
    minWidth: 0,
    marginTop: grasp.space3,
  },
  // Folding: the row keeps one line on a phone, the words taking what the actions leave and
  // wrapping beside them; the actions stand on the title's line.
  // On a phone the row is a grid: the title and the actions on its first line, the line under the
  // title across the whole width beneath them, as it is without actions.
  rowFolds: {
    display: { default: "flex", [PHONE]: "grid" },
    gridTemplateColumns: { default: null, [PHONE]: "minmax(0, 1fr) auto" },
    rowGap: { default: grasp.space4, [PHONE]: grasp.space1 },
    alignItems: { default: "flex-end", [PHONE]: "start" },
  },
  wordsFold: { display: { default: "grid", [PHONE]: "contents" } },
  // With a title alone on its line, on a phone the actions hold the end of the title's first line
  // only: an unseen copy of them floats there inside the h1, so the title's later lines run the
  // whole width under them, and the actions themselves stand over that copy.
  // The words and the actions share one cell, the actions at its top end over the room, so the row
  // is as tall as the taller of them.
  rowFloats: {
    display: { default: "flex", [PHONE]: "grid" },
    gridTemplateColumns: { default: null, [PHONE]: "minmax(0, 1fr)" },
    alignItems: { default: "flex-end", [PHONE]: "start" },
  },
  oneCell: { gridColumn: 1, gridRow: 1 },
  phoneFloats: { gridColumn: 1, gridRow: 1, justifySelf: "end" },
  // Balanced lines are measured without the float, so beside it they run under the actions.
  // It fills its line, so the room stands at the line's end even after a short title.
  titleFlows: {
    textWrap: { default: "balance", [PHONE]: "pretty" },
    flexGrow: 1,
  },
  room: {
    display: { default: "none", [PHONE]: "flex" },
    float: "inline-end",
    alignItems: "center",
    gap: grasp.space2,
    marginInlineStart: grasp.space4,
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

  // Never wider than its room: a phone is narrower than a title is long.
  // As tall as the title's letters, in the middle of its line, as a text placeholder is: the line
  // keeps its room, so nothing moves when the title arrives.
  titleWait: {
    width: "100%",
    maxWidth: grasp.pageTitleWait,
    height: grasp.titleLg,
    marginBlock: `calc((${grasp.titleLgLine} - ${grasp.titleLg}) / 2)`,
  },
  // A sub-page's title: a step down, in the sans, as a component's own title; its line, and the
  // actions' and the placeholder's, follow it.
  titleSm: {
    fontFamily: grasp.fontSans,
    fontSize: grasp.titleSm,
    lineHeight: grasp.titleSmLine,
    fontWeight: grasp.weightMedium,
    letterSpacing: grasp.trackingUiTitle,
  },
  descriptionSm: { fontSize: grasp.textSm, lineHeight: grasp.textSmLine },
  // A settings page's title: the page's serif at the middle size, as dense as a sub-page's.
  titleMd: { fontSize: grasp.titleMd, lineHeight: grasp.titleMdLine },
  actionsMd: { minHeight: grasp.titleMdLine },
  titleWaitMd: {
    height: grasp.titleMd,
    marginBlock: `calc((${grasp.titleMdLine} - ${grasp.titleMd}) / 2)`,
  },
  actionsSm: { minHeight: grasp.titleSmLine },
  titleWaitSm: {
    height: grasp.titleSm,
    marginBlock: `calc((${grasp.titleSmLine} - ${grasp.titleSm}) / 2)`,
  },
  // A description cut short at its line, with an ellipsis. Its height never changes.
  clamp: {
    display: "-webkit-box",
    WebkitBoxOrient: "vertical",
    overflow: "hidden",
  },
  clampOne: { WebkitLineClamp: 1 },
  clampTwo: { WebkitLineClamp: 2 },
  // A description runs to its line's end: its placeholder does too.
  descriptionWait: { width: "100%" },
  // Its lines stacked as the description's own lines stand: no gap between them.
  descriptionWaitLines: { display: "grid", minWidth: 0 },
});

/** Each size's own look, over the large one's (none for `lg`). */
const sizeLooks = {
  lg: { title: null, description: null, actions: null, titleWait: null },
  md: {
    title: styles.titleMd,
    description: styles.descriptionSm,
    actions: styles.actionsMd,
    titleWait: styles.titleWaitMd,
  },
  sm: {
    title: styles.titleSm,
    description: styles.descriptionSm,
    actions: styles.actionsSm,
    titleWait: styles.titleWaitSm,
  },
} as const;

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
        <Skeleton key={index} text="lg" layout={styles.descriptionWait} />
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

/** A Button's words as one string, for its name when it is its icon alone and for a menu item. */
const wordsOf = (props: ButtonProps) => {
  if (
    typeof props.children === "string" ||
    typeof props.children === "number"
  ) {
    return String(props.children);
  }
  return props["aria-label"] ?? "";
};

interface Folding {
  /** The main action: the last Button. */
  main: ReactElement<ButtonProps>;
  /** The others, in order: folded into the More menu on a phone. */
  others: ReactElement<ButtonProps>[];
  /** All of them, as given. */
  all: ReactElement<ButtonProps>[];
}

/**
 * The Buttons in `actions`, when every action is one with words; else nothing to fold. A held one
 * (`hold`) among the others asks in a popover by its own button, which a menu cannot stand for, so
 * then nothing folds either.
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
    all.some((button) => wordsOf(button.props) === "") ||
    all
      .slice(0, -1)
      .some(
        (button) =>
          button.props.hold !== undefined && button.props.hold !== false
      )
  ) {
    return undefined;
  }
  return { main, others: all.slice(0, -1), all };
};

/** The main Button as its icon alone: its own props, its words moved to its name. */
const iconOnly = (
  props: ButtonProps,
  icon: NonNullable<ButtonProps["icon"]>
): ButtonProps => {
  const {
    children: _words,
    label: _label,
    iconEnd: _iconEnd,
    "aria-label": _name,
    ...rest
  } = props;
  return { ...rest, icon, "aria-label": wordsOf(props) };
};

/** A folded Button's words in the menu: its own, or what its action's life says now. */
const itemWords = (props: ButtonProps) => {
  if (props.status === "done") {
    return props.doneLabel;
  }
  return props.status === "failed" ? props.failedLabel : wordsOf(props);
};

/**
 * One folded Button as an item of More: its words and icon, disabled as it is, a link when it is one
 * (its own `render`, so a modifier click opens a new tab), and while it works disabled and busy, the
 * spinner's mark in its icon's place (still: an item turns its spinner only for its own `action`). A plain one, chosen, presses its own Button.
 */
const FoldedItem = ({
  button,
  onPress,
}: {
  button: ReactElement<ButtonProps>;
  onPress: () => void;
}) => {
  const { props } = button;
  const working = props.status === "working";
  const words = itemWords(props);
  return (
    <DropdownMenuItem
      icon={working ? Spinner : props.icon}
      variant={props.variant === "danger" ? "danger" : undefined}
      disabled={props.disabled === true || working}
      aria-busy={working ? true : undefined}
      render={props.render}
      onSelect={props.render === undefined ? onPress : undefined}
    >
      {words}
    </DropdownMenuItem>
  );
};

/**
 * The room the actions take at the end of the title's first line, on a phone: the same Buttons,
 * unseen (opacity), out of the accessibility tree and inert, floated inside the h1 under the
 * actions themselves, so its words flow round them and then run the whole width beneath. A page
 * search can find the main action's words twice, both in the one place.
 */
const Room = ({ folding }: { folding: Folding }) => {
  const { main, others } = folding;
  return (
    <span aria-hidden="true" inert {...stylex.props(styles.room)}>
      {others.length > 0 && (
        <Button
          icon={More}
          aria-label=""
          variant="ghost"
          size={main.props.size ?? "sm"}
        />
      )}
      <span
        {...stylex.props(
          main.props.icon === undefined ? undefined : styles.mainWords
        )}
      >
        {main}
      </span>
      {main.props.icon !== undefined && (
        <span {...stylex.props(styles.mainIcon)}>
          {createElement(Button, iconOnly(main.props, main.props.icon))}
        </span>
      )}
    </span>
  );
};

/**
 * The actions: as given on a wide row; on a phone the main one at the end and the others folded into
 * one More menu beside it, a danger one last and apart. A folded action, chosen, presses its own
 * Button, kept in the wide row, which is `display: none` there: out of the tab order, the
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
  const { more } = useWords("dropdownMenu", dropdownMenuWords);
  const { main, others, all } = folding;
  const press = (button: ReactElement<ButtonProps>) => () => {
    const own = wide.current?.querySelectorAll<HTMLElement>(
      ":scope > [data-page-action] > *"
    );
    own?.[all.indexOf(button)]?.click();
  };
  const plain = others.filter((button) => button.props.variant !== "danger");
  const danger = others.filter((button) => button.props.variant === "danger");
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
            <DropdownMenuTrigger
              icon={More}
              aria-label={more}
              variant="ghost"
              size={main.props.size ?? "sm"}
            />
            <DropdownMenuContent align="end">
              {plain.map((button) => (
                <FoldedItem
                  key={all.indexOf(button)}
                  button={button}
                  onPress={press(button)}
                />
              ))}
              {plain.length > 0 && danger.length > 0 && (
                <DropdownMenuSeparator />
              )}
              {danger.map((button) => (
                <FoldedItem
                  key={all.indexOf(button)}
                  button={button}
                  onPress={press(button)}
                />
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <span
          {...stylex.props(
            main.props.icon === undefined ? undefined : styles.mainWords
          )}
        >
          {main}
        </span>
        {main.props.icon !== undefined && (
          <span {...stylex.props(styles.mainIcon)}>
            {createElement(Button, iconOnly(main.props, main.props.icon))}
          </span>
        )}
      </div>
    </>
  );
};

/** The title, the line under it and what stands beside the title, or their placeholders. */
const Words = ({
  title,
  description,
  descriptionLines,
  loadingLines,
  aside,
  loading,
  look,
  folds,
  room,
  oneCell,
}: Pick<PageHeaderProps, "title" | "description" | "aside" | "loadingLines"> & {
  descriptionLines: NonNullable<PageHeaderProps["descriptionLines"]>;
  loading: boolean;
  look: (typeof sizeLooks)[keyof typeof sizeLooks];
  folds: boolean;
  room: ReactNode;
  oneCell: boolean;
}) => {
  const arrived = useArrived(loading);
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
          <Skeleton
            variant="block"
            layout={[styles.titleWait, look.titleWait]}
          />
          {description !== undefined &&
            (folds ? (
              <div {...stylex.props(styles.under)}>
                <DescriptionWait
                  lines={loadingLines}
                  clamp={descriptionLines}
                />
              </div>
            ) : (
              <DescriptionWait lines={loadingLines} clamp={descriptionLines} />
            ))}
        </>
      ) : (
        <>
          <div {...stylex.props(styles.titleRow, arrived && arrive.in)}>
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
            {aside}
          </div>
          {description !== undefined && (
            <p
              title={
                descriptionLines !== "all" && typeof description === "string"
                  ? description
                  : undefined
              }
              {...stylex.props(
                styles.description,
                look.description,
                descriptionLines !== "all" && styles.clamp,
                descriptionLines === 1 && styles.clampOne,
                descriptionLines === 2 && styles.clampTwo,
                folds && styles.under,
                arrived && arrive.in
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

export const PageHeader = ({
  title,
  description,
  descriptionLines = "all",
  loadingLines,
  breadcrumb,
  aside,
  actions,
  tabs,
  loading = false,
  size = "lg",
  style: styleProp,
  layout,
}: PageHeaderProps) => {
  const look = sizeLooks[size];
  const folding = foldingOf(actions);
  // The title's later lines run under the actions when the title stands alone on its line, words
  // and not placeholders; with something beside it, the actions keep a column of their own.
  const floats = folding !== undefined && !loading && aside === undefined;
  return (
    <header
      data-slot="page-header"
      aria-busy={loading ? true : undefined}
      {...stylex.props(styles.header, layout ?? styleProp)}
    >
      {breadcrumb}
      <div
        {...stylex.props(
          styles.row,
          folding !== undefined && (floats ? styles.rowFloats : styles.rowFolds)
        )}
      >
        <Words
          title={title}
          description={description}
          descriptionLines={descriptionLines}
          loadingLines={loadingLines}
          aside={aside}
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
    </header>
  );
};
