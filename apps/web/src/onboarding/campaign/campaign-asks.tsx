// What the admin can do on the campaign page, each done with one press:
// remind a quiet team (Grasp's reminder goes out in the admin's name to
// those still to talk, whom the admin never sees), or correct an address
// an invitation bounced from. Core does both (`onboarding.nudge`,
// `onboarding.correctAddress`) and says what needs the admin next. The
// most important stands first with the page's one filled button; every
// other is one quiet line with its press as a link.
import { failureText } from "@grasp-os/shared/errors";
import type { CampaignAsk } from "@grasp-os/shared/onboarding-campaign";
import { Button } from "@grasp-os/ui/components/button";
import { Field, FieldLabel } from "@grasp-os/ui/components/field";
import { Input } from "@grasp-os/ui/components/input";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverFooter,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@grasp-os/ui/components/popover";
import { Text } from "@grasp-os/ui/components/text";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useId, useState } from "react";

import type { Session } from "../../core.ts";
import { TopError } from "../../frame/top-error.tsx";
import { useCore } from "../../use-core.ts";

type QuietAsk = Extract<CampaignAsk, { kind: "quiet" }>;
type MailAsk = Extract<CampaignAsk, { kind: "mail" }>;

const styles = stylex.create({
  asks: {
    display: "flex",
    flexDirection: "column",
    gap: space[3],
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  ask: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    columnGap: space[4],
    rowGap: space[3],
  },
  // A second ask's press is a link: on the sentence's baseline, a little apart, so it reads as the action.
  askQuiet: { alignItems: "baseline", columnGap: space[6] },
});

/**
 * One press sent to core: why it didn't go through is said in the bar at
 * the top, and thrown on, so the button pressed shows that it failed.
 */
const useSend = (onChanged: () => Promise<void>) => {
  const core = useCore();
  const [failure, setFailure] = useState<string>();
  const send = async (
    action: (session: Session) => Promise<unknown>
  ): Promise<void> => {
    setFailure(undefined);
    try {
      await core.withSession(action);
    } catch (error) {
      setFailure(failureText(error));
      throw error;
    }
    await onChanged();
  };
  return { failure, send };
};

/** The ask in one sentence, or what became of it. */
const AskLine = ({ ask, first }: { ask: CampaignAsk; first: boolean }) => {
  const { t } = useLingui();
  let words = "";
  if (ask.kind === "mail") {
    const address = ask.email;
    words = t`The invitation to ${address} bounced.`;
  } else {
    const { name: team, waiting } = ask;
    words = ask.nudged
      ? t`${team} got your reminder.`
      : t`${team} is quiet. ${plural(waiting, {
          one: "# person is still to talk.",
          other: "# people are still to talk.",
        })}`;
  }
  return (
    <Text as="span" color={first ? "default" : "muted"} size="lg">
      {words}
    </Text>
  );
};

/** The one press for a quiet team: once a day, as core takes it. */
const Nudge = ({
  ask,
  onChanged,
  first,
}: {
  ask: QuietAsk;
  onChanged: () => Promise<void>;
  first: boolean;
}) => {
  const { t } = useLingui();
  const { failure, send } = useSend(onChanged);
  const { name: team } = ask;
  return (
    <>
      <Button
        errorText={t`Not sent`}
        onClick={async () => {
          await send(
            async (session) => await session.onboarding.nudge(ask.team)
          );
        }}
        successText={t`Sent`}
        variant={first ? "default" : "link"}
      >
        {t`Remind ${team}`}
      </Button>
      <TopError>{failure}</TopError>
    </>
  );
};

/** The address to correct, in a small panel beside its button. */
const Readdress = ({
  ask,
  onChanged,
  first,
}: {
  ask: MailAsk;
  onChanged: () => Promise<void>;
  first: boolean;
}) => {
  const { t } = useLingui();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [address, setAddress] = useState(ask.email);
  const { failure, send } = useSend(async () => {
    setOpen(false);
    await onChanged();
  });
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <Button variant={first ? "default" : "link"}>
          {t`Correct the address`}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start">
        <PopoverHeader>
          <PopoverTitle>{t`Correct the address`}</PopoverTitle>
          <PopoverDescription>
            {t`We send the invitation again at once.`}
          </PopoverDescription>
        </PopoverHeader>
        <Field>
          <FieldLabel htmlFor={id}>{t`Email address`}</FieldLabel>
          <Input
            id={id}
            onValueChange={setAddress}
            type="email"
            value={address}
          />
        </Field>
        <PopoverFooter>
          <Button
            errorText={t`Not sent`}
            onClick={async () => {
              await send(async (session) => {
                await session.onboarding.correctAddress(
                  ask.person,
                  address.trim()
                );
              });
            }}
            size="sm"
            successText={t`Sent`}
          >
            {t`Send again`}
          </Button>
        </PopoverFooter>
      </PopoverContent>
      <TopError>{failure}</TopError>
    </Popover>
  );
};

/** What tells one ask from another: its team, or its person. */
const keyOf = (ask: CampaignAsk): string =>
  ask.kind === "quiet" ? `quiet/${ask.team}` : `mail/${ask.person}`;

/** What the admin must do, as core orders it: a quiet team before a bounced address; nothing when there is nothing. */
export const Asks = ({
  asks,
  onChanged,
}: {
  asks: readonly CampaignAsk[];
  /** Called once core did what was asked: what needs the admin has changed. */
  onChanged: () => Promise<void>;
}) => {
  const { t } = useLingui();
  if (asks.length === 0) {
    return null;
  }
  return (
    <ul aria-label={t`For you`} {...stylex.props(styles.asks)}>
      {asks.map((ask, index) => {
        const first = index === 0;
        let press = null;
        if (ask.kind === "mail") {
          press = <Readdress ask={ask} first={first} onChanged={onChanged} />;
        } else if (!ask.nudged) {
          press = <Nudge ask={ask} first={first} onChanged={onChanged} />;
        }
        return (
          <li
            key={keyOf(ask)}
            {...stylex.props(styles.ask, !first && styles.askQuiet)}
          >
            <AskLine ask={ask} first={first} />
            {press}
          </li>
        );
      })}
    </ul>
  );
};
