import { Badge } from "@grasp-os/ui/components/badge";
import { Card } from "@grasp-os/ui/components/card";
import { Heading } from "@grasp-os/ui/components/heading";
import { Skeleton } from "@grasp-os/ui/components/skeleton";
import { Text } from "@grasp-os/ui/components/text";
import type { IconData } from "@grasp-os/ui/lib/icons";
import {
  colors,
  radius,
  shadow,
  size,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useId } from "react";
import type { ReactNode } from "react";

import { SettingsGroup } from "./section.tsx";

// Who something is, on a card, as Settings' Workspace and Billing head
// their pages: its mark (a logo), its name in the serif, a few facts as
// small badges, and one action at the end of the name's line. Composed of
// Damsko's Card, Heading, Badge and Skeleton; Damsko has no such part (it
// is one product's), so it is the product's own (plan 5.5). With a title
// it stands as the groups beside it: the title on the page's ground, the
// card under it. With `cover`, a soft band across the card's top, the mark
// standing over its lower edge: for the one thing a page is about.

/** One fact about who it is: a small badge with its icon. */
export interface IdentityFact {
  /** A key that stays the same while the facts change. */
  id: string;
  /** Its words, short: an address, a VAT number, where people sign in from. */
  label: string;
  icon?: IconData;
}

const NARROW = "@container identity-card (width < 30rem)";

const styles = stylex.create({
  frame: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    minWidth: 0,
    containerType: "inline-size",
    containerName: "identity-card",
  },
  // The card's top, its corners the card's own: a soft band under a hairline.
  cover: {
    height: {
      default: `calc(${space[24]} + ${space[4]})`,
      [NARROW]: `calc(${space[20]} + ${space[2]})`,
    },
    backgroundColor: colors.muted,
    borderStartStartRadius: radius.base,
    borderStartEndRadius: radius.base,
    cornerShape: radius.shape,
    borderBlockEndWidth: size.hairline,
    borderBlockEndStyle: "solid",
    borderBlockEndColor: colors.border,
  },
  // The room a settings card gives its rows, so the name starts where their labels do.
  body: {
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 1fr)",
    alignItems: "center",
    columnGap: space[4],
    rowGap: space[2],
    padding: space[4],
  },
  bodyCovered: { paddingBlockStart: 0 },
  bodyBare: { gridTemplateColumns: "minmax(0, 1fr)" },
  mark: {
    display: "grid",
    alignSelf: "start",
    gridRow: { default: "span 2", [NARROW]: "auto" },
  },
  // Over the cover's lower edge, on a step of the card's own ground.
  markCovered: {
    marginBlockStart: {
      default: `calc(-1 * ${space[12]})`,
      [NARROW]: `calc(-1 * ${space[10]})`,
    },
    padding: space[1],
    borderRadius: `calc(${radius.base} + ${space[1]})`,
    cornerShape: radius.shape,
    backgroundColor: colors.card,
    boxShadow: shadow.sm,
  },
  beside: { gridColumn: 2 },
  lineCovered: { alignSelf: "end", paddingBlockStart: space[3] },
  factsBeside: { gridColumn: { default: 2, [NARROW]: "1 / -1" } },
  // The name and its action share a line while there is room.
  line: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    columnGap: space[3],
    rowGap: space[2],
    minWidth: 0,
    minHeight: size.controlSm,
  },
  name: { flexGrow: 1, minWidth: 0 },
  nameWaiting: { width: "min(10rem, 60%)" },
  facts: {
    display: "flex",
    flexWrap: "wrap",
    alignSelf: "start",
    gap: space[2],
    minWidth: 0,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  fact: { display: "flex", minWidth: 0, maxWidth: "100%" },
  factWaiting: { width: space[24] },
});

interface IdentityProps {
  /** Who it is, in the serif. */
  name?: string | undefined;
  /** A quiet line in the name's place while there is no name. */
  empty?: string;
  /** Its mark before the name: an image well, an avatar. */
  mark?: ReactNode;
  facts?: readonly IdentityFact[];
  /** One action at the end of the name's line: a small Button, or a Dialog's trigger. */
  action?: ReactNode;
  cover?: boolean;
  /** Before it arrives: the name and two facts wait as placeholders, the action keeps its room. */
  loading?: boolean;
  /** The name is the card's heading, with this id, when it has no title. */
  heading: string | undefined;
}

/** No facts: a list kept once, so a card with none stays the same. */
const noFacts: readonly IdentityFact[] = [];

/** The name in the serif, its heading when the card has none; the quiet line in its place, or its wait. */
const Name = ({
  name,
  empty,
  heading,
  loading,
}: Pick<IdentityProps, "name" | "empty" | "heading" | "loading">) => {
  if (loading === true) {
    return <Skeleton size="lg" style={styles.nameWaiting} />;
  }
  if (name === undefined || name === "") {
    return (
      <Text color="muted" size="sm">
        {empty}
      </Text>
    );
  }
  return (
    <div {...stylex.props(styles.name)}>
      {heading === undefined ? (
        <Text color="default" size="lg" variant="display">
          <bdi>{name}</bdi>
        </Text>
      ) : (
        <Heading id={heading} level={2} size="sm">
          <bdi>{name}</bdi>
        </Heading>
      )}
    </div>
  );
};

/** The facts as small badges, or two placeholders while they load. */
const Facts = ({
  facts,
  loading,
  beside,
}: {
  facts: readonly IdentityFact[];
  loading: boolean;
  beside: boolean;
}) => {
  const { t } = useLingui();
  const look = stylex.props(styles.facts, beside && styles.factsBeside);
  if (loading) {
    return (
      <div aria-hidden="true" {...look}>
        <Skeleton style={styles.factWaiting} />
        <Skeleton style={styles.factWaiting} />
      </div>
    );
  }
  if (facts.length === 0) {
    return null;
  }
  return (
    <ul aria-label={t`Facts`} {...look}>
      {facts.map((fact) => (
        <li key={fact.id} {...stylex.props(styles.fact)}>
          <Badge
            variant="secondary"
            {...(fact.icon === undefined ? {} : { icon: fact.icon })}
          >
            <bdi>{fact.label}</bdi>
          </Badge>
        </li>
      ))}
    </ul>
  );
};

/** The cover, then the mark beside the name, its action and the facts. */
const Inside = ({
  name,
  empty,
  mark,
  facts = noFacts,
  action,
  cover = false,
  loading = false,
  heading,
}: IdentityProps) => {
  const marked = mark !== undefined;
  return (
    <div {...stylex.props(styles.frame)}>
      {cover ? (
        <div aria-hidden="true" {...stylex.props(styles.cover)} />
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
          <Name empty={empty} heading={heading} loading={loading} name={name} />
          {action === undefined || loading ? null : action}
        </div>
        <Facts beside={marked} facts={facts} loading={loading} />
      </div>
    </div>
  );
};

/** Who something is, on a card: its mark, its name, a few facts and one action. */
export const IdentityCard = ({
  title,
  "aria-label": label,
  ...props
}: Omit<IdentityProps, "heading"> & {
  /** In a settings column, the title over the card, as a group's. */
  title?: string;
  /** Its name for a screen reader, when it has no title. */
  "aria-label"?: string;
}) => {
  const nameId = useId();
  if (title !== undefined) {
    return (
      <SettingsGroup flush title={title}>
        <Inside {...props} heading={undefined} />
      </SettingsGroup>
    );
  }
  return (
    <Card
      aria-label={label}
      {...(label === undefined ? { "aria-labelledby": nameId } : {})}
      asChild
      padding="none"
    >
      <section>
        <Inside {...props} heading={nameId} />
      </section>
    </Card>
  );
};
