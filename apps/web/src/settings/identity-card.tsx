import { Badge } from "@grasp-os/ui/components/badge";
import { Card } from "@grasp-os/ui/components/card";
import { Skeleton } from "@grasp-os/ui/components/skeleton";
import type { IconData } from "@grasp-os/ui/lib/icons";
import {
  colors,
  font,
  radius,
  shadow,
  size,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useId } from "react";
import type { ReactNode } from "react";

// Who the organization is, on a card at the head of Settings › Workspace:
// a cover across the top with a faint dither of light, its mark (the logo
// well) over the cover's lower edge, its name in the serif with one action
// after it, and a few facts as small labels. The old library's Identity
// card, a settings composite with no counterpart in Damsko (the rename
// map's "identity-card → apps/web/src/settings/identity-card.tsx"), built
// of Damsko's Card, Badge and Skeleton.

/** A fact about it: a short label with an icon. */
export interface IdentityCardFact {
  label: ReactNode;
  icon?: IconData;
  /** Its key among the facts. */
  id: string;
}

/** The cover's dots: 0.75px wide, one every 3px, as the old chat box's dither drew them. */
const dot = "0.75px";
const pitch = "3px";

/** No facts: the card has none to show. */
const noFacts: readonly IdentityCardFact[] = [];

/** A card narrower than this lays its mark above its name. */
const NARROW = "@container identity-card (width < 30rem)";

const styles = stylex.create({
  frame: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    minWidth: 0,
    containerType: "inline-size",
    containerName: "identity-card",
  },
  cover: {
    position: "relative",
    overflow: "hidden",
    height: {
      default: `calc(${space["24"]} + ${space["4"]})`,
      [NARROW]: `calc(${space["20"]} + ${space["2"]})`,
    },
    backgroundColor: colors.muted,
    borderStartStartRadius: radius.xl,
    borderStartEndRadius: radius.xl,
    cornerShape: radius.shape,
    borderBlockEndWidth: size.hairline,
    borderBlockEndStyle: "solid",
    borderBlockEndColor: colors.border,
  },
  // The cover's light: mint from the top corner at the start, seen through
  // the chat box's dots. Decoration: hidden, takes no pointer, never moves.
  texture: {
    position: "absolute",
    inset: 0,
    insetInlineEnd: { default: "-60%", [NARROW]: 0 },
    pointerEvents: "none",
    opacity: size.pageHeaderDitherStrength,
    backgroundImage: {
      default: `radial-gradient(120% 90% at 0% 0%, ${colors.mint}, transparent 70%)`,
      ":dir(rtl)": `radial-gradient(120% 90% at 100% 0%, ${colors.mint}, transparent 70%)`,
    },
    maskImage: `radial-gradient(circle, black ${dot}, transparent calc(${dot} + ${size.hairline}))`,
    maskSize: `${pitch} ${pitch}`,
    maskRepeat: "repeat",
    display: { default: "block", "@media (forced-colors: active)": "none" },
  },
  body: {
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 1fr)",
    alignItems: "center",
    columnGap: space["4"],
    rowGap: space["2"],
    padding: space["4"],
  },
  bodyCovered: { paddingBlockStart: 0 },
  bodyBare: { gridTemplateColumns: "minmax(0, 1fr)" },
  mark: {
    display: "grid",
    alignSelf: "start",
    gridRow: { default: "span 2", [NARROW]: "auto" },
  },
  markCovered: {
    position: "relative",
    marginBlockStart: {
      default: `calc(-1 * ${space["12"]})`,
      [NARROW]: `calc(-1 * ${space["10"]})`,
    },
    padding: space["1"],
    borderRadius: `calc(${radius.base} + ${space["1"]})`,
    cornerShape: radius.shape,
    backgroundColor: colors.card,
    boxShadow: shadow.sm,
  },
  line: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    columnGap: space["3"],
    rowGap: space["2"],
    minWidth: 0,
    minHeight: size.controlSm,
  },
  beside: { gridColumn: 2 },
  lineCovered: { alignSelf: "end", paddingBlockStart: space["3"] },
  empty: {
    flexGrow: 1,
    minWidth: 0,
    margin: 0,
    color: colors.mutedForeground,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
  },
  name: {
    flexGrow: 1,
    minWidth: 0,
    margin: 0,
    color: colors.foreground,
    fontFamily: font.serif,
    fontSize: { default: font.headingMd, [NARROW]: font.headingSm },
    lineHeight: { default: font.headingMdLine, [NARROW]: font.headingSmLine },
    fontWeight: font.weightNormal,
    overflowWrap: "anywhere",
    textWrap: "balance",
  },
  nameWaiting: {
    width: "min(10rem, 60%)",
    maxWidth: "100%",
    height: { default: font.headingMdLine, [NARROW]: font.headingSmLine },
  },
  action: { display: "inline-flex", flexShrink: 0 },
  away: { opacity: 0 },
  factsBeside: { gridColumn: { default: 2, [NARROW]: "1 / -1" } },
  facts: {
    display: "flex",
    flexWrap: "wrap",
    alignSelf: "start",
    gap: space["2"],
    minWidth: 0,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  fact: { display: "flex", minWidth: 0, maxWidth: "100%" },
  factWaiting: {
    boxSizing: "border-box",
    width: `calc(${space["16"]} * 2)`,
    height: size.controlXs,
    borderRadius: radius.full,
    backgroundColor: colors.muted,
  },
});

/** The facts, as small labels; while loading, their pills' room. */
const Facts = ({
  facts,
  loading,
  beside,
}: {
  facts: readonly IdentityCardFact[];
  loading: boolean;
  /** Beside a mark, under the name. */
  beside: boolean;
}) => {
  const { t } = useLingui();
  const look = stylex.props(styles.facts, beside && styles.factsBeside);
  if (loading) {
    return (
      <ul aria-hidden="true" {...look}>
        {[0, 1].map((index) => (
          <li key={index} {...stylex.props(styles.factWaiting)} />
        ))}
      </ul>
    );
  }
  if (facts.length === 0) {
    return null;
  }
  return (
    <ul aria-label={t`Details`} {...look}>
      {facts.map((fact) => (
        <li key={fact.id} {...stylex.props(styles.fact)}>
          <Badge
            {...(fact.icon === undefined ? {} : { icon: fact.icon })}
            variant="secondary"
          >
            <bdi>{fact.label}</bdi>
          </Badge>
        </li>
      ))}
    </ul>
  );
};

/** Who something is, on a card: its mark, its name with one action, and a few facts. */
export const IdentityCard = ({
  name,
  empty,
  mark,
  facts = noFacts,
  action,
  "aria-label": label,
  cover = false,
  loading = false,
}: {
  /** Its name, its heading; a placeholder while loading. */
  name?: string | undefined;
  /** Said in the name's place while it has none. */
  empty?: string;
  /** Its picture: an ImageUpload. */
  mark?: ReactNode;
  facts?: readonly IdentityCardFact[];
  /** After the name: the card's one action (Edit). */
  action?: ReactNode;
  "aria-label": string;
  /** A cover across the top, the mark over its lower edge. */
  cover?: boolean;
  loading?: boolean;
}) => {
  const nameId = useId();
  const marked = mark !== undefined;
  let named: ReactNode;
  if (loading) {
    named = <Skeleton size="lg" style={styles.nameWaiting} />;
  } else if (name === undefined || name === "") {
    named = <p {...stylex.props(styles.empty)}>{empty}</p>;
  } else {
    named = (
      <h2 dir="auto" id={nameId} {...stylex.props(styles.name)}>
        {name}
      </h2>
    );
  }
  return (
    <Card aria-label={label} asChild padding="none">
      <section>
        <div {...stylex.props(styles.frame)}>
          {cover ? (
            <div aria-hidden="true" {...stylex.props(styles.cover)}>
              <span {...stylex.props(styles.texture)} />
            </div>
          ) : null}
          <div
            {...stylex.props(
              styles.body,
              cover && styles.bodyCovered,
              !marked && styles.bodyBare
            )}
          >
            {marked ? (
              <div {...stylex.props(styles.mark, cover && styles.markCovered)}>
                {mark}
              </div>
            ) : null}
            <div
              {...stylex.props(
                styles.line,
                marked && styles.beside,
                cover && styles.lineCovered
              )}
            >
              {named}
              {action === undefined ? null : (
                <span
                  inert={loading}
                  {...stylex.props(styles.action, loading && styles.away)}
                >
                  {action}
                </span>
              )}
            </div>
            <Facts beside={marked} facts={facts} loading={loading} />
          </div>
        </div>
      </section>
    </Card>
  );
};
