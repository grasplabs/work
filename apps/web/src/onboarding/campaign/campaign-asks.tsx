// What the admin can do on the campaign page, at most two things at once,
// each done with one press: nudge a quiet team (Grasp's reminder goes out
// in the admin's name to those still to talk, whom the admin never sees),
// or correct an address an invitation bounced from. The most important
// stands first with the page's one filled button; a second is one quiet
// line with its press as a link.
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

import type { Ask } from "./fixtures.ts";

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

/** What core would do to send: here, nothing (fixtures). */
const sent = async (): Promise<void> => {
  await Promise.resolve();
};

/** The ask in one sentence, or what became of it. */
const AskLine = ({
  ask,
  done,
  first,
}: {
  ask: Ask;
  done: boolean;
  first: boolean;
}) => {
  const { t } = useLingui();
  const { team } = ask;
  let words = t`The invitation went out again.`;
  if (ask.kind === "quiet") {
    const { waiting } = ask;
    words = done
      ? t`${team} got your nudge.`
      : t`${team} is quiet. ${plural(waiting, {
          one: "# person is still to talk.",
          other: "# people are still to talk.",
        })}`;
  } else if (!done) {
    const { address } = ask;
    words = t`The invitation to ${address} bounced.`;
  }
  return (
    <Text as="span" color={first ? "default" : "muted"} size="lg">
      {words}
    </Text>
  );
};

/** The one press for a quiet team. */
const Nudge = ({
  ask,
  onDone,
  first,
}: {
  ask: Ask;
  onDone: () => void;
  first: boolean;
}) => {
  const { t } = useLingui();
  const { team } = ask;
  return (
    <Button
      onClick={async () => {
        await sent();
        onDone();
      }}
      successText={t`Sent`}
      variant={first ? "default" : "link"}
    >
      {t`Nudge ${team}`}
    </Button>
  );
};

/** The address to correct, in a small panel beside its button. */
const Readdress = ({
  ask,
  onDone,
  first,
}: {
  ask: Extract<Ask, { kind: "bounce" }>;
  onDone: () => void;
  first: boolean;
}) => {
  const { t } = useLingui();
  const id = useId();
  const [open, setOpen] = useState(false);
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
          <Input defaultValue={ask.address} id={id} type="email" />
        </Field>
        <PopoverFooter>
          <Button
            onClick={async () => {
              await sent();
              setOpen(false);
              onDone();
            }}
            size="sm"
          >
            {t`Send again`}
          </Button>
        </PopoverFooter>
      </PopoverContent>
    </Popover>
  );
};

/** The asks, the most important first: a quiet team before a bounced address. */
const asksInOrder = (asks: Ask[]): Ask[] =>
  asks.toSorted(
    (a, b) => Number(b.kind === "quiet") - Number(a.kind === "quiet")
  );

/** What the admin must do, the most important first; nothing when there is nothing. */
export const Asks = ({ asks }: { asks: Ask[] }) => {
  const { t } = useLingui();
  const [done, setDone] = useState<string[]>([]);
  if (asks.length === 0) {
    return null;
  }
  return (
    <ul aria-label={t`For you`} {...stylex.props(styles.asks)}>
      {asksInOrder(asks).map((ask, index) => {
        const isDone = done.includes(ask.id);
        const first = index === 0;
        const onDone = () => {
          setDone((was) => [...was, ask.id]);
        };
        let press = null;
        if (!isDone) {
          press =
            ask.kind === "quiet" ? (
              <Nudge ask={ask} first={first} onDone={onDone} />
            ) : (
              <Readdress ask={ask} first={first} onDone={onDone} />
            );
        }
        return (
          <li
            key={ask.id}
            {...stylex.props(styles.ask, !first && styles.askQuiet)}
          >
            <AskLine ask={ask} done={isDone} first={first} />
            {press}
          </li>
        );
      })}
    </ul>
  );
};
