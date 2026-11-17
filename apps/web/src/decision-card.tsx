import type { DecisionView } from "@grasp-os/shared/decisions";
import { Button } from "@grasp-os/ui/components/button";
import { Card, CardContent } from "@grasp-os/ui/components/card";
import { Label } from "@grasp-os/ui/components/label";
import { Textarea } from "@grasp-os/ui/components/textarea";
import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { CircleDotIcon } from "lucide-react";
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
import { useCoreAction } from "./use-core-action.ts";

// A decision as the person who answers it sees it on its own page
// (routes/decisions.$decision.tsx): what is asked, where it comes from,
// until when, and the answers core offers, or how it ended. It shows what
// core serves, never more: once core refuses something because the
// decision changed (an ask withheld since it was read, GRA-1988), it reads
// the decision again and shows it as it is now.

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
    : i18n._(msg`Rejected by ${name} on ${date}.`);
};

/**
 * The decision, as the prototype's card: what is asked, where it comes
 * from, until when, and the answers core offers, or how it ended.
 */
export const DecisionCard = ({ decision }: { decision: DecisionView }) => {
  const [current, setCurrent] = useState(decision);
  const [comment, setComment] = useState("");
  const [pending, setPending] = useState<PendingConfirmation>();
  const { busy, failure, run } = useCoreAction();
  const open = current.status === "open";
  /**
   * Shows the decision as core serves it now, after core refused something
   * of it: what is asked may have changed since the card was read (its ask
   * withheld, `decision.withheld`, or `decision.conflict`), so the card
   * shows that, with why, and keeps the comment for a deliberate answer.
   */
  const readAgain = async (session: Session): Promise<void> => {
    try {
      setCurrent(await session.decisions.get(current.id));
    } catch {
      // Shown as it was.
    }
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
        await readAgain(session);
        throw error;
      }
    });
    if (review !== undefined) {
      setCurrent(review.decision);
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
        await readAgain(session);
        throw error;
      }
    });
    if (answered !== undefined) {
      setCurrent(answered);
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
      <Card className="w-full max-w-xl" size="sm">
        <CardContent>
          <div className="flex items-start gap-4">
            <div className="bg-muted grid size-8 flex-none place-items-center rounded-md">
              <CircleDotIcon aria-hidden="true" className="size-4" />
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-3">
              <div className="flex flex-col gap-1">
                <h1 className="font-medium">{current.description}</h1>
                <p className="text-muted-foreground">
                  {open ? (
                    <Trans>A run of a workflow waits for this answer.</Trans>
                  ) : (
                    <Trans>A run of a workflow asked for this answer.</Trans>
                  )}
                </p>
                <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-0.5">
                  <dt className="text-muted-foreground">
                    <Trans context="where a decision comes from">From</Trans>
                  </dt>
                  <dd className="truncate">{current.workflow}</dd>
                  <dt className="text-muted-foreground">
                    <Trans context="the run of a workflow a decision is for">
                      Run
                    </Trans>
                  </dt>
                  <dd className="truncate font-mono text-xs leading-5">
                    {current.run}
                  </dd>
                  {current.input === undefined ? null : (
                    <>
                      <dt className="text-muted-foreground">
                        <Trans context="what a decision is about, as its workflow run passed it">
                          About
                        </Trans>
                      </dt>
                      <dd className="min-w-0">
                        <pre className="max-h-48 overflow-auto font-mono text-xs break-all whitespace-pre-wrap">
                          {JSON.stringify(current.input, undefined, 2)}
                        </pre>
                      </dd>
                    </>
                  )}
                  {open ? (
                    <>
                      <dt className="text-muted-foreground">
                        <Trans context="until when a decision can be answered">
                          Open until
                        </Trans>
                      </dt>
                      <dd>{formatDateTime(current.expiresAt)}</dd>
                    </>
                  ) : null}
                </dl>
              </div>
              {open && current.withheld === "unchecked" ? (
                <div className="flex flex-col gap-2">
                  <ErrorText>{failure}</ErrorText>
                  {/* Not shown for now: it takes no answer until a later
                      read shows it. */}
                  <p className="text-muted-foreground">
                    <WithheldAskNote withheld={current.withheld} />
                  </p>
                  <div className="flex gap-2">
                    <Button
                      disabled={busy}
                      onClick={() => {
                        void run(readAgain);
                      }}
                      size="sm"
                      variant="outline"
                    >
                      <Trans>Try again</Trans>
                    </Button>
                  </div>
                </div>
              ) : null}
              {open && current.withheld !== "unchecked" ? (
                <div className="flex flex-col gap-3">
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="decision-comment">
                      <Trans>Comment (optional)</Trans>
                    </Label>
                    <Textarea
                      disabled={busy}
                      id="decision-comment"
                      maxLength={2000}
                      onChange={(event) => {
                        setComment(event.target.value);
                      }}
                      value={comment}
                    />
                  </div>
                  <ErrorText>{failure}</ErrorText>
                  {/* Nobody approves what they can't read: a withheld
                      decision takes a rejection alone. */}
                  {current.withheld === "revoked" ? (
                    <p className="text-muted-foreground">
                      <WithheldAskNote withheld={current.withheld} />
                    </p>
                  ) : null}
                  <div className="flex gap-2">
                    {current.withheld === "revoked" ? null : (
                      <Button
                        disabled={busy}
                        onClick={() => {
                          void answer(true);
                        }}
                        size="sm"
                      >
                        <Trans>Approve</Trans>
                      </Button>
                    )}
                    <Button
                      disabled={busy}
                      onClick={() => {
                        void answer(false);
                      }}
                      size="sm"
                      variant="outline"
                    >
                      <Trans>Reject</Trans>
                    </Button>
                  </div>
                </div>
              ) : null}
              {open ? null : (
                <div className="flex flex-col gap-2">
                  {/* Why a confirmed answer wasn't taken, when the decision
                      closed meanwhile. */}
                  <ErrorText>{failure}</ErrorText>
                  <output>{outcomeOf(current)}</output>
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </>
  );
};
