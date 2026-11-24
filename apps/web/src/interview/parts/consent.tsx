import { Button } from "@grasp-os/ui/components/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@grasp-os/ui/components/card";
import { Text } from "@grasp-os/ui/components/text";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import type { LayoutStyle } from "@grasp-os/ui/lib/utils";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

// The question that asks for consent inside the conversation: a row of its
// own in the thread, under the interviewer's first message, which says who
// asks, why and how long it takes. (On a start screen of its own the page
// asks instead, without a card.) Agreeing is recorded by the notice's
// version (`participationNotice`, shared): when what is said about it
// changes in meaning, that version goes up.
//
// The words are Ruben's (copy guide, section 8). Not a Confirmation (no
// assistant's step waits on it) nor a Questionnaire (one press agrees,
// never choose-then-send).

const styles = stylex.create({
  // The two buttons at one height in a row, declining as words on a line of its own.
  answers: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: space[2],
  },
  pair: { display: "flex", flexWrap: "wrap", gap: space[2] },
});

export const ConsentCard = ({
  onAgree,
  onLater,
  onDecline,
  style,
}: {
  /** They agree and the interview starts. A Promise keeps the button working until it settles. */
  onAgree: () => Promise<void> | void;
  /** Not right now: the interviewer then asks when to remind them. */
  onLater: () => void;
  /** They would rather skip it altogether. */
  onDecline: () => void;
  /** Where it sits and how wide it is. */
  style?: LayoutStyle;
}) => {
  const { t } = useLingui();
  return (
    <Card style={style}>
      <CardHeader>
        <CardTitle level={2}>{t`Ready to start?`}</CardTitle>
      </CardHeader>
      <CardContent>
        <Text>{t`Your microphone stays off until you agree.`}</Text>
      </CardContent>
      <CardFooter>
        <div {...stylex.props(styles.answers)}>
          <div {...stylex.props(styles.pair)}>
            <Button
              errorText={t`Could not start`}
              onClick={onAgree}
              size="lg"
            >{t`I agree, let's start`}</Button>
            <Button onClick={onLater} size="lg" variant="outline">
              {t`Not right now`}
            </Button>
          </div>
          <Button onClick={onDecline} variant="link">
            {t`I'd rather skip this`}
          </Button>
        </div>
      </CardFooter>
    </Card>
  );
};
