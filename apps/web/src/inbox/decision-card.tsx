import type { DecisionView } from "@grasp-os/shared/decisions";
import { Alert, AlertDescription } from "@grasp-os/ui/components/alert";
import { Button } from "@grasp-os/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@grasp-os/ui/components/card";
import {
  CodeBlock,
  CodeBlockContent,
} from "@grasp-os/ui/components/code-block";
import { Field, FieldLabel } from "@grasp-os/ui/components/field";
import { KeyValueList } from "@grasp-os/ui/components/key-value";
import type { KeyValueItem } from "@grasp-os/ui/components/key-value";
import { Text } from "@grasp-os/ui/components/text";
import { Textarea } from "@grasp-os/ui/components/textarea";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import type { Session } from "../core.ts";
import { formatDateTime } from "../format.ts";
import { useCoreAction } from "../use-core-action.ts";
import {
  confirmAndAnswer,
  DecisionConfirmDialog,
  WithheldAskNote,
} from "./decision-confirmation.tsx";
import type { PendingConfirmation } from "./decision-confirmation.tsx";

// A decision as the person who answers it sees it on its own page
// (routes/decisions.$decision.tsx): what is asked, where it comes from,
// until when, and the answers core offers, or how it ended. It shows what
// core serves, never more: once core refuses something because the
// decision changed (an ask withheld since it was read, GRA-1988), it reads
// the decision again and shows it as it is now.

const styles = stylex.create({
  card: { width: "100%", maxWidth: "36rem" },
  stack: { display: "flex", flexDirection: "column", gap: space["4"] },
  answers: { display: "flex", gap: space["2"] },
});

/** Why something failed, said as it appears; nothing when it didn't. */
const Failure = ({ children }: { children: string | undefined }) =>
  children === undefined ? null : (
    <Alert variant="destructive">
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );

/** What a decision says about itself: where from, which run, about what, until when. */
const useFacts = (current: DecisionView, open: boolean): KeyValueItem[] => {
  const { t } = useLingui();
  return [
    {
      id: "from",
      label: t({ message: "From", context: "where a decision comes from" }),
      value: current.workflow,
    },
    {
      id: "run",
      label: t({
        message: "Run",
        context: "the run of a workflow a decision is for",
      }),
      value: current.run,
      mono: true,
    },
    ...(current.input === undefined
      ? []
      : [
          {
            id: "about",
            label: t({
              message: "About",
              context:
                "what a decision is about, as its workflow run passed it",
            }),
            value: (
              <CodeBlock language="json" size="sm">
                <CodeBlockContent wrap>
                  {JSON.stringify(current.input, undefined, 2)}
                </CodeBlockContent>
              </CodeBlock>
            ),
          },
        ]),
    ...(open
      ? [
          {
            id: "until",
            label: t({
              message: "Open until",
              context: "until when a decision can be answered",
            }),
            value: formatDateTime(current.expiresAt),
          },
        ]
      : []),
  ];
};

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
  const facts = useFacts(current, open);
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
              <CardDescription>
                {open
                  ? t`A run of a workflow waits for this answer.`
                  : t`A run of a workflow asked for this answer.`}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div {...stylex.props(styles.stack)}>
                <KeyValueList items={facts} orientation="horizontal" />
                {open && current.withheld === "unchecked" ? (
                  <>
                    <Failure>{failure}</Failure>
                    {/* Not shown for now: it takes no answer until a later
                      read shows it. */}
                    <Text color="muted">
                      <WithheldAskNote withheld={current.withheld} />
                    </Text>
                    <div {...stylex.props(styles.answers)}>
                      <Button
                        disabled={busy}
                        onClick={() => {
                          void run(readAgain);
                        }}
                        size="sm"
                        variant="secondary"
                      >
                        {t`Try again`}
                      </Button>
                    </div>
                  </>
                ) : null}
                {open && current.withheld !== "unchecked" ? (
                  <>
                    <Field name="decision-comment">
                      <FieldLabel>{t`Comment (optional)`}</FieldLabel>
                      <Textarea
                        disabled={busy}
                        maxLength={2000}
                        onValueChange={setComment}
                        value={comment}
                      />
                    </Field>
                    <Failure>{failure}</Failure>
                    {/* Nobody approves what they can't read: a withheld
                      decision takes a rejection alone. */}
                    {current.withheld === "revoked" ? (
                      <Text color="muted">
                        <WithheldAskNote withheld={current.withheld} />
                      </Text>
                    ) : null}
                    <div {...stylex.props(styles.answers)}>
                      {current.withheld === "revoked" ? null : (
                        <Button
                          disabled={busy}
                          onClick={() => {
                            void answer(true);
                          }}
                          size="sm"
                        >
                          {t({
                            message: "Approve",
                            context: "a workflow's decision",
                          })}
                        </Button>
                      )}
                      <Button
                        disabled={busy}
                        onClick={() => {
                          void answer(false);
                        }}
                        size="sm"
                        variant="secondary"
                      >
                        {t({
                          message: "Reject",
                          context: "a workflow's decision",
                        })}
                      </Button>
                    </div>
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
