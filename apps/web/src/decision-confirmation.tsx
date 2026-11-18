import type {
  DecisionAnswerInput,
  DecisionView,
} from "@grasp-os/shared/decisions";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { z } from "zod";

import type { Session } from "./core.ts";
import { formatDateTime } from "./format.ts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "./grasp/alert-dialog/index.ts";
import { CodeBlock } from "./grasp/code-block/index.ts";
import { KeyValueList } from "./grasp/key-value/index.ts";
import type { KeyValueItem } from "./grasp/key-value/index.ts";
import { grasp } from "./grasp/tokens/tokens.stylex.ts";

// The trusted host decision UI's confirmation (spec 10.7.2, GRA-624):
// before a person's answer to a decision is recorded, Grasp itself shows
// them what is asked (the review context, as core pinned it) and the
// answer as core will record it, and only their click here mints the
// one-use confirmation the answer needs. Shown by the decision's page and
// by the page around an App's page, never inside the page's frame: a
// page can ask to answer, but only the person, here, confirms it.

/** A decision and the answer to confirm, as core gave them for review. */
export interface PendingConfirmation {
  decision: DecisionView;
  response: DecisionAnswerInput;
}

/**
 * How long Confirm stays disabled once the dialog opens: a click already
 * on its way, which a page could time its request for, never confirms.
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
 * an App's page, which asked to answer.
 */
export type AnswerSource = "page";

/** A payload that is a comment and nothing else. */
const commentAlone = z.strictObject({ comment: z.string() });

const styles = stylex.create({
  // What is asked scrolls, so the answer above it is always in view.
  asked: { maxHeight: "24rem", overflowY: "auto" },
  answer: { fontWeight: grasp.weightMedium },
  // A comment as the person wrote it, its line breaks kept.
  comment: { whiteSpace: "pre-wrap", overflowWrap: "anywhere" },
});

/** JSON as the person reads it: all of it, wrapped. */
const Json = ({ value }: { value: unknown }) => (
  <CodeBlock code={JSON.stringify(value, undefined, 2)} language="json" wrap />
);

/**
 * The answer's payload as the person reads it, under what it is called:
 * whose it is, and what it holds. A comment alone, as the decision's page
 * sends it, reads as the person's own; what an App's page sends with its
 * answer is the page's, whatever it looks like, and says so. Nothing
 * without one.
 */
const usePayloadItem = (
  payload: DecisionAnswerInput["payload"] | undefined,
  source: AnswerSource
): KeyValueItem[] => {
  const { t } = useLingui();
  if (payload === undefined || payload === null) {
    return [];
  }
  const alone = commentAlone.safeParse(payload);
  const comment =
    source === "page" && alone.success ? alone.data.comment : undefined;
  let key = t({
    message: "Details",
    context: "what else an answer to a decision says",
  });
  if (source === "page") {
    key = t({
      message: "Sent by the app",
      context: "what an App's page sends with an answer to a decision",
    });
  } else if (comment !== undefined) {
    key = t({
      message: "Comment",
      context: "a comment on an answer to a decision",
    });
  }
  const value: ReactNode =
    comment === undefined ? (
      <Json value={payload} />
    ) : (
      <span {...stylex.props(styles.comment)}>{comment}</span>
    );
  return [{ key, value }];
};

/**
 * What a decision asks, as the person reviews it: what is asked, what it
 * is about as its run passed it (part of the review context they
 * confirm, so always shown), where from, which run, until when.
 */
const useAskedItems = (decision: DecisionView | undefined): KeyValueItem[] => {
  const { t } = useLingui();
  if (decision === undefined) {
    return [];
  }
  return [
    {
      key: t({ message: "Asked", context: "what a decision asks" }),
      value: decision.description,
    },
    ...(decision.input === undefined
      ? []
      : [
          {
            key: t({
              message: "About",
              context:
                "what a decision is about, as its workflow run passed it",
            }),
            value: <Json value={decision.input} />,
          },
        ]),
    {
      key: t({ message: "From", context: "where a decision comes from" }),
      value: decision.workflow,
    },
    {
      key: t({
        message: "Run",
        context: "the run of a workflow a decision is for",
      }),
      value: decision.run,
      mono: true,
    },
    {
      key: t({
        message: "Open until",
        context: "until when a decision can be answered",
      }),
      value: formatDateTime(decision.expiresAt),
    },
  ];
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
  const payload = usePayloadItem(pending?.response.payload, source);
  const asked = useAskedItems(decision);
  const yourAnswer: KeyValueItem = {
    key: t({
      message: "Your answer",
      context: "the answer a person gives a decision",
    }),
    value: (
      <span {...stylex.props(styles.answer)}>
        {approved
          ? t({ message: "Approve", context: "a workflow's decision" })
          : t({ message: "Reject", context: "a workflow's decision" })}
      </span>
    ),
  };
  return (
    <AlertDialog
      onOpenChange={(open) => {
        if (!open && pending !== undefined) {
          onCancel(pending);
        }
      }}
      open={pending !== undefined}
    >
      <AlertDialogContent>
        <AlertDialogTitle>
          {approved ? t`Confirm your approval` : t`Confirm your rejection`}
        </AlertDialogTitle>
        <AlertDialogDescription>
          {t`Grasp records this answer only once you confirm it here. Check what is asked and what you answer.`}
        </AlertDialogDescription>
        {decision === undefined || pending === undefined ? null : (
          <>
            {/* What the person answers comes first, outside the scrolled
                part: always in view, whatever the App's description. */}
            <KeyValueList items={[yourAnswer, ...payload]} variant="inline" />
            <div {...stylex.props(styles.asked)}>
              <KeyValueList items={asked} variant="inline" />
            </div>
          </>
        )}
        <AlertDialogFooter>
          <AlertDialogAction>{t`Cancel`}</AlertDialogAction>
          <AlertDialogAction
            disabled={ready !== pending}
            onClick={() => {
              if (pending !== undefined) {
                onConfirm(pending);
              }
            }}
            variant="ink"
          >
            {t({
              message: "Confirm",
              context: "confirm an answer to a decision",
            })}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
