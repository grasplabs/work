import { failureText } from "@grasp-os/shared/errors";
import { Alert, AlertDescription } from "@grasp-os/ui/components/alert";
import { Button } from "@grasp-os/ui/components/button";
import { Card, CardContent } from "@grasp-os/ui/components/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@grasp-os/ui/components/collapsible";
import { Heading } from "@grasp-os/ui/components/heading";
import { Link } from "@grasp-os/ui/components/link";
import { Text } from "@grasp-os/ui/components/text";
import { focusRingText } from "@grasp-os/ui/lib/styles";
import { colors, radius, space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useId, useState } from "react";
import type { ReactNode } from "react";

import { PauseNote, useArmed } from "../answer-pause.tsx";
import { useNarrow } from "../onboarding/use-narrow.ts";

// An ask for the person's yes in the Inbox (a held change, a start an
// agent asked for, a permission), as #2503's approval card, made of
// Damsko's Card, Heading, Text, Collapsible and Buttons: the ask in one
// serif sentence on a faint dither, one quiet line of who asks and since
// when, Details (what to read before answering), then Decline and Approve
// side by side, each half the card's width when the card is narrow.
// Damsko's Confirmation draws a dense row instead (damsko-registry-gaps,
// 2026-11-24, Inbox). Each answer works in place until core has it, the
// other waiting meanwhile; one core refuses says so on its own button,
// with core's reason under the ask, and the Inbox keeps the item in place
// until the person moves on, even once it waits no more (answered
// elsewhere). Once answered the title says what was decided, and the
// Inbox reads again, so the item leaves.

/** Narrower than this, the card puts Details on a line of its own and its answers side by side under it. */
const NARROW_CARD = "@container (width < 26rem)";
/** Narrower than this, one answer under the other. */
const NARROWEST_CARD = "@container (width < 15rem)";

const styles = stylex.create({
  // The card's own room, for its narrow forms; the dither behind it.
  body: {
    position: "relative",
    isolation: "isolate",
    containerType: "inline-size",
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    gap: space["4"],
  },
  // The faint dither the ask stands on, fading out down the card.
  dither: {
    position: "absolute",
    inset: `calc(-1 * ${space["5"]})`,
    zIndex: -1,
    borderRadius: radius.xl,
    backgroundImage: `radial-gradient(color-mix(in oklch, ${colors.foreground} 9%, transparent) 0.6px, transparent 0.8px)`,
    backgroundSize: "3px 3px",
    maskImage: "linear-gradient(to bottom, black, transparent 70%)",
    pointerEvents: "none",
    display: { default: "block", "@media (forced-colors: active)": "none" },
  },
  ditherNarrow: { inset: `calc(-1 * ${space["4"]})` },
  head: { display: "grid", minWidth: 0 },
  meta: { marginBlockStart: space["1"] },
  // Details, then the answers: one row on a wide card, Details over them on a narrow one.
  row: {
    display: "grid",
    gridTemplateColumns: {
      default: "auto minmax(0, 1fr)",
      [NARROW_CARD]: "minmax(0, 1fr)",
    },
    alignItems: "center",
    columnGap: space["3"],
    rowGap: space["3"],
  },
  rowAlone: { gridTemplateColumns: "minmax(0, 1fr)" },
  answers: {
    display: { default: "flex", [NARROW_CARD]: "grid" },
    justifyContent: "flex-end",
    gridTemplateColumns: {
      default: null,
      [NARROW_CARD]: "repeat(2, minmax(0, 1fr))",
      [NARROWEST_CARD]: "minmax(0, 1fr)",
    },
    gap: space["2"],
  },
  details: {
    display: "grid",
    gap: space["3"],
    minWidth: 0,
    paddingBlockStart: space["4"],
  },
});

/**
 * Runs `work`, then `settle` whatever came of it; when it fails, says why
 * through `failed` and fails as `work` did, so the button says so too.
 * Outside the component, as the React Compiler can't compile `finally`.
 */
const settled = async (
  work: () => Promise<void>,
  settle: () => void,
  failed: (reason: string) => void
): Promise<void> => {
  try {
    await work();
  } catch (error) {
    failed(failureText(error));
    throw error;
  } finally {
    settle();
  }
};

/** The ask on its dither, a focus target, and the quiet line of who asks and since when. */
const AskHead = ({
  titleId,
  heading,
  quiet,
  narrow,
}: {
  titleId: string;
  heading: string;
  quiet: readonly string[];
  narrow: boolean;
}) => (
  <>
    <span
      aria-hidden="true"
      {...stylex.props(styles.dither, narrow && styles.ditherNarrow)}
    />
    <div {...stylex.props(styles.head)}>
      {/* Where focus lands once an answer is through or refused. */}
      <div
        data-item-heading
        id={titleId}
        tabIndex={-1}
        {...stylex.props(focusRingText)}
      >
        <Heading level={2} size={narrow ? "sm" : "default"}>
          {heading}
        </Heading>
      </div>
      <Text color="muted" size="sm" style={styles.meta}>
        {quiet.join(" · ")}
      </Text>
    </div>
  </>
);

/** The card round it: on a phone its room is 16px, as a card's own; else a card of parts' 20. */
const AskCard = ({
  narrow,
  children,
}: {
  narrow: boolean;
  children: ReactNode;
}) =>
  narrow ? (
    <Card>{children}</Card>
  ) : (
    <Card>
      <CardContent>{children}</CardContent>
    </Card>
  );

/** Where the request stands: waiting, or what was answered here. */
type Answer = { state: "waiting" } | { state: "answered"; approved: boolean };

/** Details, then Decline and Approve: one row on a wide card, Details over the answers on a narrow one. */
const AnswerRow = ({
  details,
  approveLabel,
  declineOff,
  approveOff,
  approveHeldBy,
  pausedBy,
  onApprove,
  onDecline,
}: {
  details: ReactNode;
  approveLabel: string | undefined;
  declineOff: boolean;
  approveOff: boolean;
  /** The id of the line that says why Approve waits, while it does. */
  approveHeldBy: string | undefined;
  /** The id of the line that says the answers wait a moment, while they do. */
  pausedBy: string | undefined;
  onApprove: () => Promise<void>;
  onDecline: () => Promise<void>;
}) => {
  const { t } = useLingui();
  // Off and said why, an answer stays a Tab stop that says so.
  const approveWhy = [approveHeldBy, pausedBy].filter((id) => id !== undefined);
  return (
    <Collapsible>
      <div
        {...stylex.props(styles.row, details === undefined && styles.rowAlone)}
      >
        {details === undefined ? null : (
          <Text as="span" color="muted" size="sm">
            <CollapsibleTrigger asChild>
              <Link asChild variant="underline">
                <button type="button">{t`Details`}</button>
              </Link>
            </CollapsibleTrigger>
          </Text>
        )}
        <div {...stylex.props(styles.answers)}>
          <Button
            aria-describedby={pausedBy}
            disabled={declineOff}
            errorText={t({
              message: "Failed",
              context: "a decline that did not go through",
            })}
            focusableWhenDisabled={pausedBy !== undefined}
            onClick={onDecline}
            variant="outline"
          >
            {t`Decline`}
          </Button>
          <Button
            aria-describedby={
              approveWhy.length === 0 ? undefined : approveWhy.join(" ")
            }
            disabled={approveOff}
            errorText={t({
              message: "Failed",
              context: "an approval that did not go through",
            })}
            focusableWhenDisabled={approveWhy.length > 0}
            onClick={onApprove}
            variant="success"
          >
            {approveLabel ?? t`Approve`}
          </Button>
        </div>
      </div>
      {details === undefined ? null : (
        <CollapsibleContent>
          <div {...stylex.props(styles.details)}>{details}</div>
        </CollapsibleContent>
      )}
    </Collapsible>
  );
};

export const ApprovalRequest = ({
  title,
  asker,
  askedAt,
  approveLabel,
  approveHeld,
  details,
  arriving = false,
  gone = false,
  onApprove,
  onDecline,
}: {
  /** What is asked, in one sentence, a verb first. */
  title: string;
  /** Who asks, by name: Grasp when nobody is named (a chat's agent, an App's run). */
  asker?: string;
  /** When it was asked, as the page writes a date. */
  askedAt?: string;
  /** The words on Approve, when they can say what it does ("Grant it"). */
  approveLabel?: string;
  /** Why Approve waits, while it does: it stays out of use, and Decline stays. */
  approveHeld?: string | undefined;
  /** What to read before answering, under Details. */
  details?: ReactNode;
  /** Opened in place of an item just answered: its answers wait a moment. */
  arriving?: boolean;
  /** Kept on screen after it waits no more: nothing to answer. */
  gone?: boolean;
  /** Gives the yes to core: the button works until it is through, and says so when it fails. */
  onApprove: () => Promise<unknown>;
  onDecline: () => Promise<unknown>;
}) => {
  const { t } = useLingui();
  const titleId = useId();
  const heldId = useId();
  const pauseId = useId();
  const narrow = useNarrow();
  const [answer, setAnswer] = useState<Answer>({ state: "waiting" });
  const [giving, setGiving] = useState<boolean>();
  const [failure, setFailure] = useState<string>();
  const [armed] = useArmed(arriving);
  const off = !armed || gone;
  const waiting = answer.state === "waiting";
  const give = (approved: boolean) => async () => {
    setGiving(approved);
    setFailure(undefined);
    await settled(
      async () => {
        await (approved ? onApprove() : onDecline());
        setAnswer({ state: "answered", approved });
      },
      () => {
        setGiving(undefined);
      },
      setFailure
    );
  };
  const paused = !armed && !gone;
  const quiet = [asker ?? "Grasp", ...(askedAt === undefined ? [] : [askedAt])];
  const said = {
    waiting: title,
    approved: t`Approved: ${title}`,
    declined: t`Declined: ${title}`,
  };
  const heading =
    answer.state === "waiting"
      ? said.waiting
      : said[answer.approved ? "approved" : "declined"];
  const body = (
    <section
      aria-labelledby={titleId}
      data-slot="approval-request"
      {...stylex.props(styles.body)}
    >
      <AskHead
        heading={heading}
        narrow={narrow}
        quiet={quiet}
        titleId={titleId}
      />
      {/* The pause, said, for the answers that wait it out. */}
      {paused ? <PauseNote id={pauseId} /> : null}
      {waiting ? (
        <AnswerRow
          approveHeldBy={approveHeld === undefined ? undefined : heldId}
          approveLabel={approveLabel}
          approveOff={off || giving === false || approveHeld !== undefined}
          declineOff={off || giving === true}
          details={details}
          onApprove={give(true)}
          onDecline={give(false)}
          pausedBy={paused ? pauseId : undefined}
        />
      ) : null}
      {failure === undefined ? null : (
        <Alert variant="destructive">
          <AlertDescription>{failure}</AlertDescription>
        </Alert>
      )}
      {approveHeld === undefined || !waiting ? null : (
        <Text color="muted" size="xs">
          <span id={heldId}>{approveHeld}</span>
        </Text>
      )}
    </section>
  );
  return <AskCard narrow={narrow}>{body}</AskCard>;
};
