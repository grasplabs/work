// IdentityCard: who something is, on a card. Its mark (a logo, an avatar, an app's mark), its name
// in the serif, a few facts as small tags, and one action at the end of the name's line. Built of
// the finished parts: Section card (grouped, compact) when it has a title, else Card; Tag for each
// fact; Skeleton while it loads; the shared texture (src/texture) for its cover. The mark and the
// action are the caller's own parts: an Avatar or an Image well, a Button or a Dialog's trigger.
//
//   <IdentityCard title="Billing details" name="Noordkade Finance B.V."
//     facts={[{ icon: Home, label: "Keizersgracht 12, Amsterdam" }, { icon: Mail, label: "finance@noordkade.nl" }]}
//     action={<Button icon={Edit} size="sm" variant="quiet">Edit</Button>} />
//   <IdentityCard aria-label="Organization" cover mark={<ImageWell … size="lg" />} name="Noordkade" … />
//
// In a settings column it stands as the groups beside it: the title on the page's ground, the card a
// small step under it, its words where the rows' start (16px in). Every word is a prop. Every value
// is a token (src/tokens). A caller may set layout and width only (the `layout` prop).
"use client";

import * as stylex from "@stylexjs/stylex";
import { useId } from "react";
import type { ReactNode } from "react";

import { Card } from "../card";
import type { IconData } from "../icons";
import type { LayoutStyle } from "../layout/layout";
import { SectionCard } from "../section-card";
import { Skeleton } from "../skeleton";
import { Tag } from "../tag";
import { Texture } from "../texture/texture";
import { grasp } from "../tokens/tokens.stylex";
import { useWords } from "../words/words";
import { identityCardWords } from "./words";
import type { IdentityCardWords } from "./words";

/** One fact about who it is: a small tag with its icon. */
export interface IdentityCardFact {
  /** Its words, short: an address, a VAT number, where people sign in from. */
  label: ReactNode;
  /** An icon before the words, from the icons entry (`@/components/grasp/icons`). */
  icon?: IconData;
  /** A key that stays the same while the facts change; the label's text when left out. */
  id?: string;
}

/** Every prop an IdentityCard takes. */
export interface IdentityCardProps {
  /** Who it is: an organisation's, a company's or a person's name, in the serif. */
  name?: ReactNode;
  /** A quiet line in the name's place while there is no name: "No billing details yet". */
  empty?: ReactNode;
  /** Its mark before the name: an Avatar, an Image well, an app's mark. */
  mark?: ReactNode;
  /** One to three facts under the name, as small tags, each only when there is one. */
  facts?: readonly IdentityCardFact[];
  /** One action at the end of the name's line: a small quiet Button, or a ghost pencil alone. */
  action?: ReactNode;
  /**
   * In a settings column, the title over the card, on the page's ground, as a grouped Section
   * card's. Leave it out at the head of a page whose title already says it, and give `aria-label`.
   */
  title?: ReactNode;
  /** One sentence under the title. */
  description?: ReactNode;
  /** Its name for a screen reader, when it has no title. Without either, the name names it. */
  "aria-label"?: string;
  /**
   * The name's heading level when the card has no title; with one, the title is the heading.
   * @default 2
   */
  headingLevel?: 2 | 3 | 4;
  /**
   * A faint dither across the card's top (the shared texture), the mark standing over its lower
   * edge: for the one thing a page is about.
   * @default false
   */
  cover?: boolean;
  /**
   * Before it arrives: the name waits as a quiet line at its height, each fact as its own empty pill
   * (two when `facts` is left out), and the action keeps its room, unseen. The mark is the caller's.
   * @default false
   */
  loading?: boolean;
  /** This instance's own words, over the catalogue's (GraspWords), key by key. */
  words?: Partial<IdentityCardWords>;
  /** Layout only: margins, alignment and width. The look belongs to the card. */
  layout?: LayoutStyle;
}

const NARROW = "@container identity-card (width < 30rem)";

const styles = stylex.create({
  // The container the narrow card's rules read: the cover's height, the name's size, the facts' row.
  frame: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    minWidth: 0,
    containerType: "inline-size",
    containerName: "identity-card",
  },
  // The cover's top corners are the card's, so it fills them.
  cover: {
    position: "relative",
    overflow: "hidden",
    height: {
      default: `calc(${grasp.space24} + ${grasp.space4})`,
      [NARROW]: `calc(${grasp.space20} + ${grasp.space2})`,
    },
    backgroundColor: grasp.soft,
    borderStartStartRadius: grasp.corner,
    borderStartEndRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    borderBlockEndWidth: grasp.hairline,
    borderBlockEndStyle: "solid",
    borderBlockEndColor: grasp.line,
  },
  // On a wide card the texture's box runs on past the card's end, so its light reaches across the
  // whole cover. A phone's cover is short enough as it is.
  reach: { insetInlineEnd: { default: "-60%", [NARROW]: 0 } },
  // The room a grouped settings card gives its rows: 16px, so the name starts where their labels do.
  // Beside a mark, the name's line and the facts stand in the second column; on a narrow card the
  // facts take the whole width under the mark, so they are not squeezed beside it.
  body: {
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 1fr)",
    alignItems: "center",
    columnGap: grasp.space4,
    rowGap: grasp.space2,
    padding: grasp.space4,
  },
  bodyCovered: { paddingBlockStart: 0 },
  bodyBare: { gridTemplateColumns: "minmax(0, 1fr)" },
  // A grid, so the mark sits on no text line and the card is as tall with a mark as without.
  mark: {
    display: "grid",
    alignSelf: "start",
    gridRow: { default: "span 2", [NARROW]: "auto" },
  },
  // Over the cover's lower edge, on a step of the card's own ground.
  markCovered: {
    position: "relative",
    marginBlockStart: {
      default: `calc(-1 * ${grasp.space12})`,
      [NARROW]: `calc(-1 * ${grasp.space10})`,
    },
    padding: grasp.space1,
    borderRadius: `calc(${grasp.corner} + ${grasp.space1})`,
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.raised,
    boxShadow: grasp.liftLow,
  },
  beside: { gridColumn: 2 },
  // Under the cover the name's line stands at the mark's foot.
  lineCovered: { alignSelf: "end", paddingBlockStart: grasp.space3 },
  factsBeside: { gridColumn: { default: 2, [NARROW]: "1 / -1" } },
  // The name and its action share a line while there is room; a long action goes under the name.
  line: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    columnGap: grasp.space3,
    rowGap: grasp.space2,
    minWidth: 0,
    minHeight: grasp.controlSm,
  },
  name: {
    flexGrow: 1,
    minWidth: 0,
    margin: 0,
    color: grasp.ink,
    fontFamily: grasp.fontSerif,
    fontSize: { default: grasp.titleMd, [NARROW]: grasp.titleSm },
    lineHeight: { default: grasp.titleMdLine, [NARROW]: grasp.titleSmLine },
    fontWeight: grasp.weightRegular,
    overflowWrap: "anywhere",
    textWrap: "balance",
  },
  empty: {
    flexGrow: 1,
    minWidth: 0,
    margin: 0,
    color: grasp.muted,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
  },
  nameWaiting: {
    width: "min(10rem, 60%)",
    maxWidth: "100%",
    height: { default: grasp.titleMdLine, [NARROW]: grasp.titleSmLine },
  },
  action: { display: "inline-flex", flexShrink: 0 },
  // Opacity, not visibility: Button sets its own parts visible.
  away: { opacity: 0 },
  facts: {
    display: "flex",
    flexWrap: "wrap",
    alignSelf: "start",
    gap: grasp.space2,
    minWidth: 0,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  fact: { display: "flex", minWidth: 0, maxWidth: "100%" },
  // A fact's own empty pill, at a short fact's width, as tall as a tag.
  factWaiting: {
    boxSizing: "border-box",
    width: `calc(${grasp.space16} * 2)`,
    height: grasp.controlXs,
    borderRadius: grasp.cornerPill,
    backgroundColor: grasp.soft,
  },
});

const textOf = (label: ReactNode, index: number) =>
  typeof label === "string" || typeof label === "number"
    ? String(label)
    : String(index);

/** The facts as small tags, or their empty pills while they load. */
const Facts = ({
  facts,
  loading,
  label,
  beside,
}: {
  facts: readonly IdentityCardFact[] | undefined;
  loading: boolean;
  label: string;
  beside: boolean;
}) => {
  const look = stylex.props(styles.facts, beside && styles.factsBeside);
  if (loading) {
    const count = facts === undefined || facts.length === 0 ? 2 : facts.length;
    return (
      <ul aria-hidden="true" {...look}>
        {Array.from({ length: count }, (_, index) => (
          <li key={index} {...stylex.props(styles.factWaiting)} />
        ))}
      </ul>
    );
  }
  if (facts === undefined || facts.length === 0) {
    return null;
  }
  return (
    <ul aria-label={label} data-slot="identity-card-facts" {...look}>
      {facts.map((fact, index) => (
        <li
          key={fact.id ?? textOf(fact.label, index)}
          {...stylex.props(styles.fact)}
        >
          <Tag icon={fact.icon}>
            <bdi>{fact.label}</bdi>
          </Tag>
        </li>
      ))}
    </ul>
  );
};

interface NameProps {
  id: string;
  name: ReactNode;
  empty: ReactNode;
  heading: boolean;
  level: 2 | 3 | 4;
  loading: boolean;
}

/** The name in the serif, its heading when the card has no title; or the quiet line, or its wait. */
const Name = ({ id, name, empty, heading, level, loading }: NameProps) => {
  if (loading) {
    return <Skeleton text="lg" layout={styles.nameWaiting} />;
  }
  if (name === undefined || name === null || name === false || name === "") {
    return (
      <p id={id} {...stylex.props(styles.empty)}>
        {empty}
      </p>
    );
  }
  const Heading = heading ? (`h${level}` as const) : "p";
  return (
    <Heading id={id} dir="auto" {...stylex.props(styles.name)}>
      {name}
    </Heading>
  );
};

interface InsideProps {
  nameId: string;
  props: IdentityCardProps;
}

/** What the card holds: the cover, then the mark beside the name, its action and the facts. */
const Inside = ({ nameId, props }: InsideProps) => {
  const {
    name,
    empty,
    mark,
    facts,
    action,
    title,
    headingLevel = 2,
    cover = false,
    loading = false,
    words: given,
  } = props;
  const words = useWords("identityCard", identityCardWords, given);
  const marked = mark !== undefined && mark !== null && mark !== false;
  return (
    <div data-slot="identity-card" {...stylex.props(styles.frame)}>
      {cover && (
        <div
          aria-hidden="true"
          data-slot="identity-card-cover"
          {...stylex.props(styles.cover)}
        >
          <Texture layout={styles.reach} />
        </div>
      )}
      <div
        {...stylex.props(
          styles.body,
          cover && styles.bodyCovered,
          !marked && styles.bodyBare
        )}
      >
        {marked && (
          <div {...stylex.props(styles.mark, cover && styles.markCovered)}>
            {mark}
          </div>
        )}
        <div
          {...stylex.props(
            styles.line,
            marked && styles.beside,
            cover && styles.lineCovered
          )}
        >
          <Name
            id={nameId}
            name={name}
            empty={empty}
            heading={title === undefined}
            level={headingLevel}
            loading={loading}
          />
          {action !== undefined && action !== null && (
            <span
              data-slot="identity-card-action"
              inert={loading}
              {...stylex.props(styles.action, loading && styles.away)}
            >
              {action}
            </span>
          )}
        </div>
        <Facts
          facts={facts}
          loading={loading}
          label={words.facts}
          beside={marked}
        />
      </div>
    </div>
  );
};

/** Who something is, on a card: its mark, its name, a few facts and one action. */
export const IdentityCard = (props: IdentityCardProps) => {
  const nameId = useId();
  const {
    title,
    description,
    "aria-label": ariaLabel,
    headingLevel = 2,
    layout,
  } = props;
  if (title !== undefined) {
    return (
      <SectionCard
        variant="grouped"
        density="compact"
        flush
        title={title}
        description={description}
        headingLevel={headingLevel}
        aria-label={ariaLabel}
        layout={layout}
      >
        <Inside nameId={nameId} props={props} />
      </SectionCard>
    );
  }
  return (
    <Card
      element="section"
      padding="none"
      aria-label={ariaLabel}
      aria-labelledby={ariaLabel === undefined ? nameId : undefined}
      layout={layout}
    >
      <Inside nameId={nameId} props={props} />
    </Card>
  );
};
