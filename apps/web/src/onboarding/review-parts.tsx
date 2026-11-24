import type { Difference, SettleChoice } from "@grasp-os/shared/onboarding";
import { Button } from "@grasp-os/ui/components/button";
import { Snippet } from "@grasp-os/ui/components/snippet";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@grasp-os/ui/components/tabs";
import { Text } from "@grasp-os/ui/components/text";
import { CheckIcon, Icon } from "@grasp-os/ui/lib/icons";
import {
  colors,
  media,
  radius,
  size,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { comeIn, motion } from "./motion.ts";
import { useArrives } from "./setup-parts.tsx";

const styles = stylex.create({
  // A row of the list of what needs the admin: a line over each, and one under the last.
  row: {
    display: "flex",
    flexDirection: "column",
    gap: space[3],
    paddingBlock: space[4],
    textAlign: "start",
    borderBlockStartWidth: size.hairline,
    borderBlockStartStyle: "solid",
    borderBlockStartColor: colors.border,
    borderBlockEndWidth: { default: 0, ":last-child": size.hairline },
    borderBlockEndStyle: "solid",
    borderBlockEndColor: colors.border,
  },
  words: { display: "flex", flexDirection: "column" },
  choices: { display: "flex", flexWrap: "wrap", gap: space[2] },
  settled: {
    display: "flex",
    alignItems: "center",
    gap: space[2],
    color: colors.mutedForeground,
  },
  tick: { display: "flex", color: colors.success },
  settledWords: { flexGrow: 1, minWidth: 0 },
  ways: {
    display: "grid",
    gridTemplateColumns: { default: "1fr", [media.sm]: "1fr 1fr" },
    gap: space[3],
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  way: {
    display: "flex",
    flexDirection: "column",
    gap: space[1],
    paddingBlock: space[3],
    paddingInline: space[4],
    borderRadius: radius.base,
    cornerShape: radius.shape,
    backgroundColor: colors.card,
    boxShadow: size.borderStrong,
  },
  steps: {
    display: "flex",
    flexDirection: "column",
    gap: space[2],
    margin: 0,
    paddingInlineStart: space[5],
    listStyleType: "decimal",
  },
});

/** A row of the list of what needs the admin, for an item kept elsewhere (no-sender.tsx). */
export const reviewRow = stylex.props(styles.row, styles.words);

// What only the admin can settle in their onboarding, one item each
// (prototype `components/onboarding/review-parts.tsx`): a step people told
// two ways when nobody could say why, and letting Grasp's mail through
// their mail filter (GRA-968). Microsoft
// 365 filters mail with Exchange Online Protection and Defender, Google
// Workspace with its own rules: either can put mail from a domain it
// doesn't know in spam, and the interview links with it.

/** A way to settle it: the first is the one Stephen would take. */
interface ReviewChoice {
  id: string;
  label: string;
}

/**
 * Something only the admin can settle, with what they need to settle it:
 * what it is about, anything more it shows, and every way to decide as a
 * button of its own. Once settled it says which way they chose, and that
 * can still be changed.
 */
const ReviewItem = ({
  title,
  context,
  children,
  choices,
  chosen,
  onChoose,
  onReopen,
}: {
  title: string;
  context: string;
  children?: ReactNode;
  choices: ReviewChoice[];
  /** The choice it was settled with; none while it is open. */
  chosen: ReviewChoice | null;
  onChoose: (choice: ReviewChoice) => void;
  onReopen: () => void;
}) => {
  const { t } = useLingui();
  const settled = chosen !== null;
  const choice = chosen?.label ?? "";
  const settledArrives = useArrives(chosen?.id ?? "");
  return (
    <div {...stylex.props(styles.row)}>
      <div {...stylex.props(styles.words)}>
        <Text
          as="span"
          size="sm"
          color={settled ? "muted" : "secondary"}
          weight={settled ? "normal" : "medium"}
        >
          {title}
        </Text>
        <Text as="span" size="sm" color="muted">
          {context}
        </Text>
      </div>
      {settled ? null : children}
      {chosen === null ? (
        <div key="choices" {...stylex.props(styles.choices)}>
          {choices.map((each, at) => (
            <Button
              key={each.id}
              onClick={() => {
                onChoose(each);
              }}
              size="sm"
              variant={at === 0 ? "default" : "outline"}
            >
              {each.label}
            </Button>
          ))}
        </div>
      ) : (
        <div
          key="settled"
          {...comeIn(settledArrives, motion.fade, styles.settled)}
        >
          <span {...stylex.props(styles.tick)}>
            <Icon icon={CheckIcon} />
          </span>
          <Text as="span" style={styles.settledWords} size="sm" color="muted">
            {t`Settled: ${choice}`}
          </Text>
          <Button onClick={onReopen} size="sm" variant="ghost">
            {t({ message: "Change", context: "change how it was settled" })}
          </Button>
        </div>
      )}
    </div>
  );
};

/** The ways to settle a difference, the one Stephen would take first. */
const settleChoices: readonly SettleChoice[] = ["both", "first", "other"];

/** One way a step is told, in a card: what is done, and how it was told, never by whom. */
const Way = ({ text, told }: { text: string; told: string }) => (
  <li {...stylex.props(styles.way)}>
    <Text as="span" size="sm" weight="medium">
      {text}
    </Text>
    <Text as="span" size="xs" color="muted">
      {told}
    </Text>
  </li>
);

/**
 * A step of a piece of work its people told two ways, and nobody could
 * say why: the two ways side by side, never by whom, and whether both
 * hold or which one does. Settled, it says which; `open` while it is
 * being decided again.
 */
export const DifferenceItem = ({
  difference,
  open,
  onSettle,
  onReopen,
}: {
  difference: Difference;
  open: boolean;
  onSettle: (holds: SettleChoice) => void;
  onReopen: () => void;
}) => {
  const { t } = useLingui();
  const { name, team, way, other, holds } = difference;
  const labels: Record<SettleChoice, string> = {
    both: t`Keep both`,
    first: t`Only the first way`,
    other: t`Only the second way`,
  };
  const choices = settleChoices.map((id) => ({ id, label: labels[id] }));
  return (
    <ReviewItem
      choices={choices}
      chosen={
        open || holds === null ? null : { id: holds, label: labels[holds] }
      }
      context={t`${team}: some do a step another way, and nobody could say why. I keep both ways until you decide.`}
      onChoose={({ id }) => {
        const choice = settleChoices.find((each) => each === id);
        if (choice !== undefined) {
          onSettle(choice);
        }
      }}
      onReopen={onReopen}
      title={t`People do “${name}” in two ways`}
    >
      <ul {...stylex.props(styles.ways)}>
        <Way text={way} told={t`The way most told it`} />
        <Way text={other} told={t`The way some told it`} />
      </ul>
    </ReviewItem>
  );
};

/** The sending domain as the admin types it into their filter, with a way to copy it. */
const DomainToCopy = ({ domain }: { domain: string }) => {
  const { t } = useLingui();
  return <Snippet aria-label={t`Copy`} value={domain} />;
};

/** Numbered steps, short enough to follow in the other window. */
const Steps = ({ steps }: { steps: string[] }) => (
  <ol {...stylex.props(styles.steps)}>
    {steps.map((step) => (
      <li key={step}>{step}</li>
    ))}
  </ol>
);

/**
 * Letting Grasp's mail through: the sending domain, and the few steps that
 * allow it in Microsoft 365 (a mail flow rule that skips spam filtering
 * for it) or Google Workspace (an approved senders list that asks for
 * authentication, which Grasp's signed mail passes). Settled when the
 * admin says it's done.
 */
export const MailItem = ({
  domain,
  settled,
  onSettle,
}: {
  domain: string;
  settled: boolean;
  onSettle: (settled: boolean) => void;
}) => {
  const { t } = useLingui();
  const done: ReviewChoice = { id: "done", label: t`It’s done` };
  return (
    <ReviewItem
      choices={[done]}
      chosen={settled ? done : null}
      context={t`Your people’s interview links come by email from Grasp’s sending domain. Allow it in your mail filter before they go out, so they don’t land in spam.`}
      onChoose={() => {
        onSettle(true);
      }}
      onReopen={() => {
        onSettle(false);
      }}
      title={t`Let Grasp’s mail through`}
    >
      <DomainToCopy domain={domain} />
      <Tabs defaultValue="microsoft">
        <TabsList variant="line">
          <TabsTrigger value="microsoft">Microsoft 365</TabsTrigger>
          <TabsTrigger value="google">Google Workspace</TabsTrigger>
        </TabsList>
        <TabsContent value="microsoft">
          <Steps
            steps={[
              t`In the Exchange admin center, go to Mail flow, then Rules, and add a rule.`,
              t`Apply it if the sender’s domain is ${domain}.`,
              t`As its action, set the spam confidence level (SCL) to “Bypass spam filtering”, then save it.`,
            ]}
          />
        </TabsContent>
        <TabsContent value="google">
          <Steps
            steps={[
              t`In the Google Admin console, go to Apps, then Google Workspace, then Gmail, then Spam, phishing and malware.`,
              t`Under Spam, bypass spam filters for an approved senders list, and add ${domain} to it.`,
              t`Keep “Require sender authentication” on, then save.`,
            ]}
          />
        </TabsContent>
      </Tabs>
    </ReviewItem>
  );
};

/**
 * Where Grasp sends no mail, as on hosting where mail isn't available yet:
 * nothing to let through, so nothing to settle. Says so, and that the
 * links go out by hand.
 */
export const NoMailItem = () => {
  const { t } = useLingui();
  return (
    <div {...reviewRow}>
      <Text as="span" size="sm" weight="medium">
        {t`Mail isn’t available on this hosting yet`}
      </Text>
      <Text as="span" size="sm" color="muted">
        {t`Grasp can’t email your people their interview links for now. Send each one their link by hand from Interviews.`}
      </Text>
    </div>
  );
};
