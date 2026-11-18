import { decisionErrors } from "@grasp-os/shared/decisions";
import type { DecisionView } from "@grasp-os/shared/decisions";
import { failureText } from "@grasp-os/shared/errors";
import type { Identity, SignInOption } from "@grasp-os/shared/rpc";
// The kit's mark: Grasp UI has no Grasp mark yet (the sidebar's is the same).
import { GraspMark } from "@grasp-os/ui/components/grasp-mark";
import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { createFileRoute, Link as RouterLink } from "@tanstack/react-router";
import { useState } from "react";
import type { ReactNode } from "react";

import { loadCoreStatus, readWithin } from "../core-connection.ts";
import type { CoreConnection } from "../core-connection.ts";
import { CoreTimeoutError } from "../core.ts";
import {
  confirmAndAnswer,
  DecisionConfirmDialog,
} from "../decision-confirmation.tsx";
import type { PendingConfirmation } from "../decision-confirmation.tsx";
import { decisionSource } from "../decision-source.ts";
import { ErrorText } from "../error-text.tsx";
import { formatDateTime } from "../format.ts";
import { AppFrame } from "../frame/app-frame.tsx";
import { NotFound } from "../frame/page-states.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import type { Crumb } from "../frame/site-header.tsx";
import { Button } from "../grasp/button/index.ts";
import { CodeBlock } from "../grasp/code-block/index.ts";
import { Field, FieldLabel } from "../grasp/field/index.ts";
import { Heading } from "../grasp/heading/index.ts";
import { KeyValueList } from "../grasp/key-value/index.ts";
import type { KeyValueItem } from "../grasp/key-value/index.ts";
import { Link } from "../grasp/link/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import { Text } from "../grasp/text/index.ts";
import { Textarea } from "../grasp/textarea/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { signInErrorSearch } from "../sign-in-errors.ts";
import { SignInOptions } from "../sign-in-options.tsx";
import { useCoreAction } from "../use-core-action.ts";

// Where a decision link leads (`/decisions/<id>`), from notifications, the
// runs log or mail. Opening it answers nothing (threat model R8): the
// person signs in, sees what is asked, and answers with a button. Core
// checks on every call that they may answer; this page only shows what
// core says. Someone signed in sees it in the app's frame; anyone else
// on a page of its own, asked to sign in. The card is the prototype's
// decision card (grasplabs/prototype `components/decision-card.tsx`).

const styles = stylex.create({
  card: { width: "100%", maxWidth: "36rem" },
  stack: { display: "flex", flexDirection: "column", gap: grasp.space4 },
  answers: { display: "flex", gap: grasp.space2 },
  // A page of its own: the mark and what it says, in the middle.
  alone: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: grasp.space4,
    minHeight: "100svh",
    padding: grasp.space6,
    textAlign: "center",
    backgroundColor: grasp.paper,
    color: grasp.text,
  },
  inFrame: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: grasp.space4,
  },
});

type DecisionPage =
  | { state: "offline" }
  | { state: "signed-out"; signInOptions: SignInOption[] }
  | { state: "missing"; identity: Identity }
  | { state: "refused"; identity: Identity; message: string }
  | { state: "not-yours"; identity: Identity }
  | { state: "ready"; identity: Identity; decision: DecisionView };

const loadDecision = async (
  core: CoreConnection,
  decision: string
): Promise<DecisionPage> => {
  const { connected, signInOptions, identity } = await loadCoreStatus(core);
  if (!connected) {
    return { state: "offline" };
  }
  if (identity === undefined) {
    return { state: "signed-out", signInOptions };
  }
  try {
    // A connection that answered the status check can still hang here.
    const found = await readWithin(
      core,
      async (session) => await session.decisions.get(decision)
    );
    return { state: "ready", identity, decision: found };
  } catch (error) {
    if (error instanceof CoreTimeoutError) {
      return { state: "offline" };
    }
    const code = decisionErrors.codeOf(error);
    if (code === "decision.not_found") {
      return { state: "missing", identity };
    }
    if (code === "decision.forbidden") {
      return { state: "not-yours", identity };
    }
    return { state: "refused", identity, message: failureText(error) };
  }
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

/** What a decision says about itself: where from, which run, about what, until when. */
const useFacts = (current: DecisionView, open: boolean): KeyValueItem[] => {
  const { t } = useLingui();
  return [
    {
      key: t({ message: "From", context: "where a decision comes from" }),
      value: current.workflow,
    },
    {
      key: t({
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
            key: t({
              message: "About",
              context:
                "what a decision is about, as its workflow run passed it",
            }),
            value: (
              <CodeBlock
                code={JSON.stringify(current.input, undefined, 2)}
                language="json"
                wrap
              />
            ),
          },
        ]),
    ...(open
      ? [
          {
            key: t({
              message: "Open until",
              context: "until when a decision can be answered",
            }),
            value: formatDateTime(current.expiresAt),
          },
        ]
      : []),
  ];
};

/**
 * The decision, as the prototype's card: what is asked, where it comes
 * from, until when, and the answers core offers, or how it ended.
 */
const DecisionCard = ({ decision }: { decision: DecisionView }) => {
  const [current, setCurrent] = useState(decision);
  const [comment, setComment] = useState("");
  const [pending, setPending] = useState<PendingConfirmation>();
  const { busy, failure, run } = useCoreAction();
  const { t } = useLingui();
  const open = current.status === "open";
  const facts = useFacts(current, open);
  // Core shows the answer as it would record it, and Grasp's own dialog
  // asks the person to confirm exactly that (decision-confirmation.tsx).
  // An answer already recorded, as after a lost reply, asks nothing more.
  const answer = async (approved: boolean): Promise<void> => {
    const note = comment.trim();
    const review = await run(
      async (session) =>
        await session.decisions.review(
          current.id,
          note === "" ? { approved } : { approved, payload: { comment: note } }
        )
    );
    if (review?.state === "recorded") {
      setCurrent(review.decision);
    } else if (review !== undefined) {
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
        // Refused: what is asked may have changed since it was reviewed
        // (`decision.conflict`), so the card shows the decision as it is
        // now, with why, and keeps the comment for a deliberate answer.
        try {
          setCurrent(await session.decisions.get(current.id));
        } catch {
          // Shown as it was.
        }
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
      <SectionCard
        description={
          open
            ? t`A run of a workflow waits for this answer.`
            : t`A run of a workflow asked for this answer.`
        }
        layout={styles.card}
        title={current.description}
      >
        <div {...stylex.props(styles.stack)}>
          <KeyValueList items={facts} variant="inline" />
          {open ? (
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
              <ErrorText>{failure}</ErrorText>
              <div {...stylex.props(styles.answers)}>
                <Button
                  disabled={busy}
                  onClick={() => {
                    void answer(true);
                  }}
                  size="sm"
                  variant="ink"
                >
                  {t({ message: "Approve", context: "a workflow's decision" })}
                </Button>
                <Button
                  disabled={busy}
                  onClick={() => {
                    void answer(false);
                  }}
                  size="sm"
                  variant="quiet"
                >
                  {t({ message: "Reject", context: "a workflow's decision" })}
                </Button>
              </div>
            </>
          ) : (
            <>
              {/* Why a confirmed answer wasn't taken, when the decision
                  closed meanwhile. */}
              <ErrorText>{failure}</ErrorText>
              <output>
                <Text element="span">{outcomeOf(current)}</Text>
              </output>
            </>
          )}
        </div>
      </SectionCard>
    </>
  );
};

/** A page of its own, for someone not signed in or when core is away. */
const OnItsOwn = ({ children }: { children: ReactNode }) => (
  <main {...stylex.props(styles.alone)}>
    <GraspMark className="size-6" />
    {children}
  </main>
);

/** The decision in the app's frame, under the crumbs to its workflow. */
const DecisionInFrame = ({
  identity,
  crumbs,
  children,
}: {
  identity: Identity;
  crumbs: readonly Crumb[];
  children: ReactNode;
}) => {
  const { core } = Route.useRouteContext();
  return (
    <AppFrame core={core} identity={identity}>
      <SiteHeader crumbs={crumbs} />
      <div {...stylex.props(styles.inFrame)}>{children}</div>
    </AppFrame>
  );
};

const Decision = () => {
  const page = Route.useLoaderData();
  const { error } = Route.useSearch();
  const { core } = Route.useRouteContext();
  const { t } = useLingui();
  if (page.state === "offline") {
    return (
      <OnItsOwn>
        <Heading level={1}>{t`Decision`}</Heading>
        <ErrorText>
          {t`Grasp can't be reached right now. Try again in a moment.`}
        </ErrorText>
      </OnItsOwn>
    );
  }
  if (page.state === "signed-out") {
    return (
      <OnItsOwn>
        <Heading level={1}>{t`Sign in to answer`}</Heading>
        <Text tone="muted">
          {t`Only the people this decision is from can answer it.`}
        </Text>
        <SignInOptions
          error={error}
          options={page.signInOptions}
          // Back to this page, without an earlier error.
          returnTo={window.location.pathname}
        />
      </OnItsOwn>
    );
  }
  const workflows: Crumb = { label: t`Workflows`, to: "/workflows" };
  if (page.state === "missing") {
    return (
      <AppFrame core={core} identity={page.identity}>
        <NotFound
          crumbs={[workflows, { label: t`Not found` }]}
          title={t`Decision not found`}
        />
      </AppFrame>
    );
  }
  if (page.state === "not-yours") {
    return (
      <DecisionInFrame
        crumbs={[workflows, { label: t`Decision` }]}
        identity={page.identity}
      >
        <Heading level={1}>{t`Decision`}</Heading>
        <Text tone="muted">{t`This decision is for someone else to answer.`}</Text>
        <Link render={<RouterLink to="/" />}>{t`Go to Grasp`}</Link>
      </DecisionInFrame>
    );
  }
  if (page.state === "refused") {
    return (
      <DecisionInFrame
        crumbs={[workflows, { label: t`Decision` }]}
        identity={page.identity}
      >
        <Heading level={1}>{t`Decision`}</Heading>
        <ErrorText>{page.message}</ErrorText>
        <Link render={<RouterLink to="/" />}>{t`Go to Grasp`}</Link>
      </DecisionInFrame>
    );
  }
  const { decision } = page;
  // From the App's workflow, or the independent workflow's own page.
  const source = decisionSource(decision);
  return (
    <DecisionInFrame
      crumbs={[workflows, source, { label: t`Decision` }]}
      identity={page.identity}
    >
      <DecisionCard decision={decision} />
    </DecisionInFrame>
  );
};

export const Route = createFileRoute("/decisions/$decision")({
  component: Decision,
  // A refused sign-in comes back as `error=<code>`.
  validateSearch: (search: Record<string, unknown>): { error?: string } =>
    signInErrorSearch(search),
  loader: async ({ context: { core }, params }) =>
    await loadDecision(core, params.decision),
});
