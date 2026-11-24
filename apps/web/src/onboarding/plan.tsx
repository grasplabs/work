import { Text } from "@grasp-os/ui/components/text";
import {
  colors,
  media,
  radius,
  size,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import { pixel } from "@grasp-os/ui/lib/vars.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

// "Here's the plan": the admin's own campaign as plain rows, what happens
// and on which day, then one small, neutral example of what a finding
// looks like, quietly set on Damsko's calm dither of light. The dates are
// counted from today: core plans no campaign yet.

const styles = stylex.create({
  stack: { display: "grid", gap: space[8] },
  rows: { margin: 0, padding: 0, listStyle: "none" },
  row: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: space[4],
    paddingBlock: space[3],
    borderBlockEndWidth: size.hairline,
    borderBlockEndStyle: "solid",
    borderBlockEndColor: colors.border,
  },
  day: { flexShrink: 0 },
  numbers: { fontVariantNumeric: "tabular-nums" },
  example: {
    position: "relative",
    isolation: "isolate",
    overflow: "hidden",
    margin: 0,
    padding: space[6],
    borderRadius: radius.lg,
    cornerShape: radius.shape,
    backgroundColor: colors.card,
    boxShadow: size.borderStrong,
  },
  // The light from the end corner, through the system's one pixel, at the banner's strength.
  light: {
    position: "absolute",
    inset: 0,
    zIndex: -1,
    pointerEvents: "none",
    opacity: size.pageHeaderDitherStrength,
    backgroundImage: {
      default: `radial-gradient(120% 140% at 100% 0%, ${colors.mint}, transparent 75%)`,
      ":dir(rtl)": `radial-gradient(120% 140% at 0% 0%, ${colors.mint}, transparent 75%)`,
    },
    maskImage: pixel.mask,
    maskSize: "3px 3px",
    display: { default: "block", [media.forcedColors]: "none" },
  },
});

const dayMs = 24 * 60 * 60 * 1000;

/** The campaign's days, counted from `today`: until core plans one. */
const campaignDays = (today: Date) => {
  const at = (days: number) => new Date(today.getTime() + days * dayMs);
  return {
    first: at(2),
    everyone: at(6),
    close: at(9),
    findings: at(13),
  };
};

export const PlanBody = ({ today }: { today: Date }) => {
  const { t, i18n } = useLingui();
  const format = new Intl.DateTimeFormat(i18n.locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
  const days = campaignDays(today);
  const moments = [
    {
      id: "first",
      what: t`The people who know the work best go first`,
      day: days.first,
    },
    {
      id: "everyone",
      what: t`Everyone else gets their own link`,
      day: days.everyone,
    },
    { id: "close", what: t`The interviews close`, day: days.close },
    { id: "findings", what: t`You get what I learned`, day: days.findings },
  ];
  return (
    <div {...stylex.props(styles.stack)}>
      <ol aria-label={t`Your campaign`} {...stylex.props(styles.rows)}>
        {moments.map(({ id, what, day }) => (
          <li key={id} {...stylex.props(styles.row)}>
            <Text as="span" size="lg">
              {what}
            </Text>
            <Text as="span" size="lg" style={styles.day}>
              <time
                dateTime={day.toISOString().slice(0, 10)}
                {...stylex.props(styles.numbers)}
              >
                {format.format(day)}
              </time>
            </Text>
          </li>
        ))}
      </ol>
      <figure {...stylex.props(styles.example)}>
        <span aria-hidden="true" {...stylex.props(styles.light)} />
        <Text size="lg">{t`A finding reads like this: new people wait two to three days for a laptop from IT.`}</Text>
      </figure>
    </div>
  );
};
