import type { DecisionView } from "@grasp-os/shared/decisions";
import { Alert, AlertDescription } from "@grasp-os/ui/components/alert";
import { Button } from "@grasp-os/ui/components/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@grasp-os/ui/components/card";
import { Field, FieldLabel } from "@grasp-os/ui/components/field";
import { Text } from "@grasp-os/ui/components/text";
import { Textarea } from "@grasp-os/ui/components/textarea";
import { ClockIcon, Icon } from "@grasp-os/ui/lib/icons";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";
import type { ReactNode } from "react";

import type { Session } from "../core.ts";
import { formatDateTime } from "../format.ts";
import { useCoreAction } from "../use-core-action.ts";
import {
  confirmAndAnswer,
  DecisionConfirmDialog,
  WithheldAskNote,
} from "./decision-confirmation.tsx";
import type { PendingConfirmation } from "./decision-confirmation.tsx";
import { JsonFields } from "./json-fields.tsx";

// A decision as the person who answers it sees it, in #2503's shape for
// every approval: what is asked, where it comes from, what it is about,
// until when, and the answers core offers, or how it ended. The same card
// stands on its own page (routes/decisions.$decision.tsx) and in the
// Inbox's panel. It shows what core serves, never more: once core refuses
// something because the decision changed (an ask withheld since it was
// read, GRA-1988), it reads the decision again and shows it as it is now.

const styles = stylex.create({
  card: { width: "100%", maxWidth: "36rem" },
  stack: { display: "flex", flexDirection: "column", gap: space["3"] },
  deadline: { display: "flex", alignItems: "center", gap: space["2"] },
  answers: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space["2"],
  },
  push: { flexGrow: 1 },
});

/** The answers' row: what stands apart at its start, then the answers at its end. */
const Answers = ({
  extra,
  children,
}: {
  extra?: ReactNode;
  children?: ReactNode;
}) => (
  <div {...stylex.props(styles.answers)}>
    {extra}
    <span {...stylex.props(styles.push)} />
    {children}
  </div>
);

/** Why something failed, said as it appears; nothing when it didn't. */
const Failure = ({ children }: { children: string | undefined }) =>
  children === undefined ? null : (
    <Alert variant="destructive">
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );

/** How a decision that is no longer open ended. */
const outcomeOf = (decision: DecisionView): string => {
  const { decided } = decision;
  // `closed` is only ever an open decision whose run has ended.
  if (decision.status === "closed") {
    return i18n._(
      msg`The workflow run that asked this has ended, so this decision has closed.`
    );
  }
  if (decision.status === "timed_out") {
    return i18n._(msg`Nobody answered in time, so this decision has closed.`);
  }
  if (decided === undefined) {
    return i18n._(msg`This decision has closed.`);
  }
  const { name } = decided.by;
  const date = formatDateTime(decided.at);
  return decision.status === "approved"
    ? i18n._(msg`Approved by ${name} on ${date}.`)
    : i18n._(msg`Declined by ${name} on ${date}.`);
};

/**
 * The decision, as the prototype's card: what is asked, where it comes
 * from, until when, and the answers core offers, or how it ended.
 */
export const DecisionCard = ({
  decision,
  held = false,
  onAnswered,
}: {
  decision: DecisionView;
  /** Its answers wait a moment: it opened in place of one just answered. */
  held?: boolean;
  /** Called once an answer is recorded, with how it ended: the Inbox lets the item go. */
  onAnswered?: (said: string) => void;
}) => {
  const { t } = useLingui();
  // What the card learned of the decision since it was given it, shown
  // only over the decision it learned it of: one given anew (a fresh load
  // after a cached one) is shown as given.
  const [learned, setLearned] = useState<{
    of: DecisionView;
    view: DecisionView;
  }>();
  const current = learned?.of === decision ? learned.view : decision;
  const setCurrent = (view: DecisionView): void => {
    setLearned({ of: decision, view });
  };
  const [comment, setComment] = useState("");
  const [pending, setPending] = useState<PendingConfirmation>();
  const { busy, failure, run } = useCoreAction();
  const open = current.status === "open";
  const [commenting, setCommenting] = useState(false);
  const off = busy || held;
  const date = formatDateTime(current.expiresAt);
  /**
   * Reads the decision again and shows it as core serves it now: after
   * core refused something of it (what is asked may have changed since the
   * card was read: its ask withheld, `decision.withheld`, or
   * `decision.conflict`), or when the person tries again. One that can't
   * be read again shows nothing of what it asks, never what the card
   * showed before, and takes no answer; the read's failure is thrown.
   */
  const readAgain = async (session: Session): Promise<void> => {
    try {
      setCurrent(await session.decisions.get(current.id));
    } catch (error) {
      const { input: _input, ...rest } = current;
      setCurrent({
        ...rest,
        description: t`What this decision asks can't be shown right now.`,
        withheld: "unchecked",
      });
      throw error;
    }
  };
  /**
   * After core refused `error`: the decision as it is now, shown with why
   * it was refused, which is thrown again.
   */
  const refusedWith = async (
    session: Session,
    error: unknown
  ): Promise<never> => {
    try {
      await readAgain(session);
    } catch {
      // Shown as unreadable; why it was refused says more.
    }
    throw error;
  };
  // Core shows the answer as it would record it, and Grasp's own dialog
  // asks the person to confirm exactly that (decision-confirmation.tsx).
  // An answer already recorded, as after a lost reply, asks nothing more.
  // Either way the card shows the decision as the review served it.
  const answer = async (approved: boolean): Promise<void> => {
    const note = comment.trim();
    const given =
      note === "" ? { approved } : { approved, payload: { comment: note } };
    const review = await run(async (session) => {
      try {
        return await session.decisions.review(current.id, given);
      } catch (error) {
        return await refusedWith(session, error);
      }
    });
    if (review !== undefined) {
      setCurrent(review.decision);
      if (review.decision.status !== "open") {
        onAnswered?.(outcomeOf(review.decision));
      }
    }
    if (review?.state === "review") {
      setPending(review);
    }
  };
  const confirm = async (confirmed: PendingConfirmation): Promise<void> => {
    setPending(undefined);
    const answered = await run(async (session) => {
      try {
        return await confirmAndAnswer(
          session,
          confirmed,
          async (confirmation) =>
            await session.decisions.answer(
              confirmed.decision.id,
              confirmed.response,
              confirmation
            )
        );
      } catch (error) {
        return await refusedWith(session, error);
      }
    });
    if (answered !== undefined) {
      setCurrent(answered);
      if (answered.status !== "open") {
        onAnswered?.(outcomeOf(answered));
      }
    }
  };
  return (
    <>
      <DecisionConfirmDialog
        onCancel={() => {
          setPending(undefined);
        }}
        source="page"
        onConfirm={(confirmed) => {
          void confirm(confirmed);
        }}
        pending={pending}
      />
      <div {...stylex.props(styles.card)}>
        <Card asChild>
          <section>
            <CardHeader>
              <CardTitle level={2}>{current.description}</CardTitle>
            </CardHeader>
            <CardContent>
              <div {...stylex.props(styles.stack)}>
                <Text as="span" color="muted" size="sm">
                  {current.workflowResource.name}
                </Text>
                {current.input === undefined ? null : (
                  <JsonFields value={current.input} />
                )}
                {open ? (
                  <span {...stylex.props(styles.deadline)}>
                    <Icon icon={ClockIcon} />
                    <Text as="span" color="muted" size="sm">
                      {t`No answer by ${date}: it closes.`}
                    </Text>
                  </span>
                ) : null}
                {open && current.withheld === "unchecked" ? (
                  <>
                    <Failure>{failure}</Failure>
                    {/* Not shown for now: it takes no answer until a later
                      read shows it. */}
                    <Text color="muted">
                      <WithheldAskNote withheld={current.withheld} />
                    </Text>
                    <Answers
                      extra={
                        <Button
                          disabled={off}
                          onClick={() => {
                            void run(readAgain);
                          }}
                          size="sm"
                          variant="ghost"
                        >
                          {t`Try again`}
                        </Button>
                      }
                    />
                  </>
                ) : null}
                {open && current.withheld !== "unchecked" ? (
                  <>
                    {commenting ? (
                      <Field name="decision-comment">
                        <FieldLabel>{t`Comment (optional)`}</FieldLabel>
                        <Textarea
                          disabled={busy}
                          maxLength={2000}
                          onValueChange={setComment}
                          value={comment}
                        />
                      </Field>
                    ) : null}
                    <Failure>{failure}</Failure>
                    {/* Nobody approves what they can't read: a withheld
                      decision takes a rejection alone. */}
                    {current.withheld === "revoked" ? (
                      <Text color="muted">
                        <WithheldAskNote withheld={current.withheld} />
                      </Text>
                    ) : null}
                    <Answers
                      extra={
                        commenting ? null : (
                          <Button
                            disabled={busy}
                            onClick={() => {
                              setCommenting(true);
                            }}
                            size="sm"
                            variant="ghost"
                          >
                            {t`Add a comment`}
                          </Button>
                        )
                      }
                    >
                      <Button
                        disabled={off}
                        onClick={() => {
                          void answer(false);
                        }}
                        size="sm"
                        variant="ghost"
                      >
                        {t({
                          message: "Decline",
                          context: "a workflow's decision",
                        })}
                      </Button>
                      {current.withheld === "revoked" ? null : (
                        <Button
                          disabled={off}
                          onClick={() => {
                            void answer(true);
                          }}
                          size="sm"
                          variant="outline"
                        >
                          {t({
                            message: "Approve",
                            context: "a workflow's decision",
                          })}
                        </Button>
                      )}
                    </Answers>
                  </>
                ) : null}
                {open ? null : (
                  <>
                    {/* Why a confirmed answer wasn't taken, when the decision
                      closed meanwhile. */}
                    <Failure>{failure}</Failure>
                    <output>
                      <Text as="span">{outcomeOf(current)}</Text>
                    </output>
                  </>
                )}
              </div>
            </CardContent>
          </section>
        </Card>
      </div>
    </>
  );
};
