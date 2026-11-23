import type { DecisionView } from "@grasp-os/shared/decisions";
import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import type { Session } from "./core.ts";
import {
  confirmAndAnswer,
  DecisionConfirmDialog,
  WithheldAskNote,
} from "./decision-confirmation.tsx";
import type { PendingConfirmation } from "./decision-confirmation.tsx";
import { ErrorText } from "./error-text.tsx";
import { formatDateTime } from "./format.ts";
import { Button } from "./grasp/button/index.ts";
import { Field, FieldLabel } from "./grasp/field/index.ts";
import { Link as TextLink } from "./grasp/link/index.ts";
import { Text } from "./grasp/text/index.ts";
import { Textarea } from "./grasp/textarea/index.ts";
import { JsonFields } from "./json-fields.tsx";
import { useCoreAction } from "./use-core-action.ts";
import {
  ApprovalAnswers,
  ApprovalCard,
  ApprovalSource,
} from "./workflows/approval-card.tsx";

// A decision as the person who answers it sees it, in the one shape every
// approval takes in direction C (Track): what is asked, where it comes from
// with the way to the run that asks, what it is about, until when, and the
// answers core offers, or how it ended. The same card stands on its own
// page (routes/decisions.$decision.tsx), in the Inbox's panel, on its
// workflow's page and on its run's. It shows what core serves, never more:
// what each answer then does and who gets it past its deadline need core
// (GRA-2281). Once core refuses something because the decision changed (an
// ask withheld since it was read, GRA-1988), it reads the decision again
// and shows it as it is now.

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

/** Where a decision card stands: what it says of where the decision comes from. */
export type DecisionCardWhere = "page" | "inbox" | "workflow" | "run";

/**
 * Where it comes from, and the way to the run that asks: its workflow's
 * name, then Open, except on that run's own page and where the reader may
 * not open the workflow.
 */
const Source = ({
  decision,
  where,
}: {
  decision: DecisionView;
  where: DecisionCardWhere;
}) => {
  const { t } = useLingui();
  return (
    <ApprovalSource
      open={
        decision.opens === true && where !== "run" ? (
          <TextLink
            render={
              <Link
                params={{
                  workflow: decision.workflowResource.id,
                  run: decision.run,
                }}
                to="/workflows/$workflow/runs/$run"
              />
            }
            variant="standalone"
          >
            {t({
              message: "Open",
              context: "open the workflow run a decision is for",
            })}
          </TextLink>
        ) : undefined
      }
      said={where === "workflow" ? undefined : decision.workflowResource.name}
    />
  );
};

/**
 * The decision, as the prototype's card: what is asked, where it comes
 * from, until when, and the answers core offers, or how it ended.
 */
export const DecisionCard = ({
  decision,
  where,
  onAnswered,
}: {
  decision: DecisionView;
  /** Where it stands: the decision's own page, the Inbox, its workflow's page or its run's. */
  where: DecisionCardWhere;
  /** Called once an answer is recorded, with how it was said: the Inbox lets the item go. */
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
      <ApprovalCard
        deadline={open ? t`No answer by ${date}: it closes.` : undefined}
        details={
          current.input === undefined ? undefined : (
            <JsonFields value={current.input} />
          )
        }
        source={<Source decision={current} where={where} />}
        title={current.description}
      >
        {open && current.withheld === "unchecked" ? (
          <>
            <ErrorText>{failure}</ErrorText>
            {/* Not shown for now: it takes no answer until a later read
                  shows it. */}
            <Text tone="muted">
              <WithheldAskNote withheld={current.withheld} />
            </Text>
            <ApprovalAnswers
              extra={
                <Button
                  disabled={busy}
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
            <ErrorText>{failure}</ErrorText>
            {/* Nobody approves what they can't read: a withheld decision
                  takes a rejection alone. */}
            {current.withheld === "revoked" ? (
              <Text tone="muted">
                <WithheldAskNote withheld={current.withheld} />
              </Text>
            ) : null}
            <ApprovalAnswers
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
                disabled={busy}
                onClick={() => {
                  void answer(false);
                }}
                size="sm"
                variant="ghost"
              >
                {t({ message: "Decline", context: "a workflow's decision" })}
              </Button>
              {current.withheld === "revoked" ? null : (
                <Button
                  disabled={busy}
                  onClick={() => {
                    void answer(true);
                  }}
                  size="sm"
                  variant="quiet"
                >
                  {t({
                    message: "Approve",
                    context: "a workflow's decision",
                  })}
                </Button>
              )}
            </ApprovalAnswers>
          </>
        ) : null}
        {open ? null : (
          <>
            {/* Why a confirmed answer wasn't taken, when the decision
                  closed meanwhile. */}
            <ErrorText>{failure}</ErrorText>
            <output>
              <Text element="span">{outcomeOf(current)}</Text>
            </output>
          </>
        )}
      </ApprovalCard>
    </>
  );
};
