import type { Difference, SettleChoice } from "@grasp-os/shared/onboarding";
import { Button } from "@grasp-os/ui/components/button";
import { Card } from "@grasp-os/ui/components/card";
import { Snippet } from "@grasp-os/ui/components/snippet";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@grasp-os/ui/components/tabs";
import { Text } from "@grasp-os/ui/components/text";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { mailToLetThrough } from "./step-parts.ts";
import type { StepProps } from "./step-parts.ts";

// What only the admin can settle in their setup, a card each: a step
// people told two ways when nobody could say why, and letting Grasp's mail
// through their mail filter (GRA-968). Microsoft 365 filters mail with
// Exchange Online Protection and Defender, Google Workspace with its own
// rules: either can put mail from a domain it doesn't know in spam, and
// the interview links with it.

const styles = stylex.create({
  item: { display: "grid", gap: space[4] },
  choices: { display: "flex", flexWrap: "wrap", gap: space[3] },
  // The sentence, and "Change" a little apart on its baseline, so it reads as the action.
  settled: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "baseline",
    columnGap: space[4],
    rowGap: space[2],
  },
  list: {
    display: "grid",
    gap: space[2],
    margin: 0,
    paddingInlineStart: space[5],
  },
});

/** A way to settle it. */
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
  const choice = chosen?.label ?? "";
  return (
    <Card padding="lg">
      <div {...stylex.props(styles.item)}>
        <Text size="lg">{`${title} ${context}`}</Text>
        {chosen === null ? children : null}
        {chosen === null ? (
          <div {...stylex.props(styles.choices)}>
            {choices.map((each) => (
              <Button
                key={each.id}
                onClick={() => {
                  onChoose(each);
                }}
                size="lg"
                variant="outline"
              >
                {each.label}
              </Button>
            ))}
          </div>
        ) : (
          <div {...stylex.props(styles.settled)}>
            <Text size="lg">{t`Settled: ${choice}`}</Text>
            <Button onClick={onReopen} size="lg" variant="link">
              {t({ message: "Change", context: "change how it was settled" })}
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
};

/** A fact the admin can only read, as one quiet line: no way to settle it. */
const Note = ({ title, context }: { title: string; context: string }) => (
  <Text size="lg">{`${title} ${context}`}</Text>
);

/** The ways to settle a difference. */
const settleChoices: readonly SettleChoice[] = ["both", "first", "other"];

/**
 * A step of a piece of work its people told two ways, and nobody could
 * say why: the two ways, never by whom, and whether both hold or which
 * one does. Settled, it says which; `open` while it is decided again.
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
      title={t`People do “${name}” in two ways.`}
    >
      <ol {...stylex.props(styles.list)}>
        <li>
          <Text size="lg">{t`The first way: ${way}`}</Text>
        </li>
        <li>
          <Text size="lg">{t`The second way: ${other}`}</Text>
        </li>
      </ol>
    </ReviewItem>
  );
};

/** Numbered steps, short enough to follow in the other window. */
const Steps = ({ steps }: { steps: string[] }) => (
  <ol {...stylex.props(styles.list)}>
    {steps.map((step) => (
      <li key={step}>
        <Text size="lg">{step}</Text>
      </li>
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
      title={t`Let Grasp’s mail through.`}
    >
      <Snippet aria-label={t`Copy`} value={domain} />
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

/** Where Grasp sends no mail, as on hosting where mail isn't available yet: nothing to settle, and the links go out by hand. */
export const NoMailItem = () => {
  const { t } = useLingui();
  return (
    <Note
      context={t`Grasp can’t email your people their interview links for now. Send each one their link by hand from Interviews.`}
      title={t`Mail isn’t available on this hosting yet.`}
    />
  );
};

/** Where Grasp can send mail but no sender is set (core's `MAIL_FROM`): every mail fails until it is, so it says so instead of guessing a domain. */
export const NoSenderItem = () => {
  const { t } = useLingui();
  return (
    <Note
      context={t`Until Grasp support sets one, interview links can’t go out by email. Send each one their link by hand from Interviews.`}
      title={t`Grasp has no sender for its mail yet.`}
    />
  );
};

/**
 * Letting Grasp's mail through, as one of what needs the admin, on the
 * team step before the links go out and among what needs them later;
 * where Grasp sends no mail, or has no sender yet, that it doesn't.
 */
export const MailToLetThrough = ({
  data,
  settled,
  onSettle,
}: Pick<StepProps, "data" | "settled" | "onSettle">) => {
  if (data.view.mailSends && data.sendingDomain === null) {
    return <NoSenderItem />;
  }
  return mailToLetThrough(data) && data.sendingDomain !== null ? (
    <MailItem
      domain={data.sendingDomain}
      onSettle={(done) => {
        onSettle("mail", done);
      }}
      settled={settled.includes("mail")}
    />
  ) : (
    <NoMailItem />
  );
};
