import type {
  DecisionAnswerInput,
  DecisionView,
} from "@grasp-os/shared/decisions";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@grasp-os/ui/components/alert-dialog";
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import { z } from "zod";

import type { Session } from "./core.ts";
import { formatDateTime } from "./format.ts";

// The trusted host decision UI's confirmation (spec 10.7.2, GRA-624):
// before a person's answer to a decision is recorded, Grasp itself shows
// them what is asked (the review context, as core pinned it) and the
// answer as core will record it, and only their click here mints the
// one-use confirmation the answer needs. Shown by the decision's page and
// by the page around an App's screen, never inside the screen's frame: a
// screen can ask to answer, but only the person, here, confirms it.

/** A decision and the answer to confirm, as core gave them for review. */
export interface PendingConfirmation {
  decision: DecisionView;
  response: DecisionAnswerInput;
}

/**
 * How long Confirm stays disabled once the dialog opens: a click already
 * on its way, which a screen could time its request for, never confirms.
 */
const confirmDelayMs = 1000;

/**
 * Confirms `pending` on the person's session: mints the one-use
 * confirmation of exactly that answer to exactly that decision as it was
 * reviewed, then answers with it through `answer`, which gets the
 * confirmation and never hands it on.
 */
export const confirmAndAnswer = async (
  session: Session,
  { decision, response }: PendingConfirmation,
  answer: (confirmation: string) => Promise<DecisionView>
): Promise<DecisionView> => {
  const { confirmation } = await session.decisions.confirm(
    decision.id,
    decision.revision,
    response
  );
  return await answer(confirmation);
};

/**
 * Who wrote the answer's payload: the person, on the decision's page, or
 * an App's screen, which asked to answer.
 */
export type AnswerSource = "page" | "screen";

/** A payload that is a comment and nothing else. */
const commentAlone = z.strictObject({ comment: z.string() });

/** What the answer's payload is called: whose it is, and what it holds. */
const PayloadLabel = ({
  source,
  comment,
}: {
  source: AnswerSource;
  comment: boolean;
}) => {
  if (source === "screen") {
    return (
      <Trans context="what an App's screen sends with an answer to a decision">
        Sent by the app
      </Trans>
    );
  }
  return comment ? (
    <Trans context="a comment on an answer to a decision">Comment</Trans>
  ) : (
    <Trans context="what else an answer to a decision says">Details</Trans>
  );
};

/** The answer's payload, as the person reads it. */
const PayloadText = ({
  payload,
  source,
}: {
  payload: DecisionAnswerInput["payload"];
  source: AnswerSource;
}) => {
  if (payload === undefined || payload === null) {
    return null;
  }
  // A comment alone, as the decision's page sends it, reads as the
  // person's own. What an App's screen sends with its answer is the
  // screen's, whatever it looks like, and says so.
  const alone = commentAlone.safeParse(payload);
  const comment =
    source === "page" && alone.success ? alone.data.comment : undefined;
  return (
    <div className="flex gap-4">
      <dt className="text-muted-foreground w-24 flex-none">
        <PayloadLabel comment={comment !== undefined} source={source} />
      </dt>
      <dd className="min-w-0 flex-1">
        {comment === undefined ? (
          <pre className="max-h-48 overflow-auto font-mono text-xs break-all whitespace-pre-wrap">
            {JSON.stringify(payload, undefined, 2)}
          </pre>
        ) : (
          <p className="break-words whitespace-pre-wrap">{comment}</p>
        )}
      </dd>
    </div>
  );
};

/** The person's confirmation of `pending`, in Grasp's own dialog. */
export const DecisionConfirmDialog = ({
  pending,
  source,
  onConfirm,
  onCancel,
}: {
  pending: PendingConfirmation | undefined;
  source: AnswerSource;
  /** Called with the question confirmed: only that one is answered. */
  onConfirm: (pending: PendingConfirmation) => void;
  /** Called with the question cancelled. */
  onCancel: (pending: PendingConfirmation) => void;
}) => {
  const { t } = useLingui();
  const [ready, setReady] = useState<PendingConfirmation>();
  useEffect(() => {
    const timer = setTimeout(() => {
      setReady(pending);
    }, confirmDelayMs);
    return () => {
      clearTimeout(timer);
    };
  }, [pending]);
  const decision = pending?.decision;
  const approved = pending?.response.approved === true;
  return (
    <AlertDialog
      onOpenChange={(open) => {
        if (!open && pending !== undefined) {
          onCancel(pending);
        }
      }}
      open={pending !== undefined}
    >
      <AlertDialogContent className="max-h-svh overflow-y-auto">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {approved ? t`Confirm your approval` : t`Confirm your rejection`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            <Trans>
              Grasp records this answer only once you confirm it here. Check
              what is asked and what you answer.
            </Trans>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {decision === undefined || pending === undefined ? null : (
          <>
            {/* What the person answers comes first, outside the scrolled
                part: always in view, whatever the App's description. */}
            <dl className="flex flex-col gap-1 text-sm">
              <div className="flex gap-4">
                <dt className="text-muted-foreground w-24 flex-none">
                  <Trans context="the answer a person gives a decision">
                    Your answer
                  </Trans>
                </dt>
                <dd className="font-medium">
                  {approved ? t`Approve` : t`Reject`}
                </dd>
              </div>
              <PayloadText payload={pending.response.payload} source={source} />
            </dl>
            <dl className="flex max-h-96 flex-col gap-1 overflow-y-auto text-sm">
              <div className="flex gap-4">
                <dt className="text-muted-foreground w-24 flex-none">
                  <Trans context="what a decision asks">Asked</Trans>
                </dt>
                <dd className="min-w-0 flex-1 break-words">
                  {decision.description}
                </dd>
              </div>
              <div className="flex gap-4">
                <dt className="text-muted-foreground w-24 flex-none">
                  <Trans context="where a decision comes from">From</Trans>
                </dt>
                <dd className="min-w-0 truncate">
                  {decision.app.name} · {decision.workflow}
                </dd>
              </div>
              <div className="flex gap-4">
                <dt className="text-muted-foreground w-24 flex-none">
                  <Trans context="the run of a workflow a decision is for">
                    Run
                  </Trans>
                </dt>
                <dd className="min-w-0 truncate font-mono text-xs leading-5">
                  {decision.run}
                </dd>
              </div>
              <div className="flex gap-4">
                <dt className="text-muted-foreground w-24 flex-none">
                  <Trans context="until when a decision can be answered">
                    Open until
                  </Trans>
                </dt>
                <dd>{formatDateTime(decision.expiresAt)}</dd>
              </div>
            </dl>
          </>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>
            <Trans>Cancel</Trans>
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={ready !== pending}
            onClick={() => {
              if (pending !== undefined) {
                onConfirm(pending);
              }
            }}
          >
            <Trans context="confirm an answer to a decision">Confirm</Trans>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
