import type { DecisionView } from "@grasp-os/shared/decisions";
import { failureText, isExpectedError } from "@grasp-os/shared/errors";
import type { Identity, SignInOption } from "@grasp-os/shared/rpc";
import { Button } from "@grasp-os/ui/components/button";
import { Card, CardContent } from "@grasp-os/ui/components/card";
import { Label } from "@grasp-os/ui/components/label";
import { Textarea } from "@grasp-os/ui/components/textarea";
import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, Link } from "@tanstack/react-router";
import { CircleDotIcon } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";

import { loadCoreStatus, readWithin } from "../core-connection.ts";
import type { CoreConnection } from "../core-connection.ts";
import { CoreTimeoutError } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { formatDateTime } from "../format.ts";
import { AppFrame } from "../frame/app-frame.tsx";
import { NotFound } from "../frame/page-states.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import type { Crumb } from "../frame/site-header.tsx";
import { GraspMark } from "../grasp-mark.tsx";
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

type DecisionPage =
  | { state: "offline" }
  | { state: "signed-out"; signInOptions: SignInOption[] }
  | { state: "missing"; identity: Identity }
  | { state: "refused"; identity: Identity; message: string }
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
    if (isExpectedError(error) && error.code === "decision.not_found") {
      return { state: "missing", identity };
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
  if (decision.status === "timed_out" || decided === undefined) {
    return i18n._(msg`Nobody answered in time, so this decision has closed.`);
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
const DecisionCard = ({ decision }: { decision: DecisionView }) => {
  const [current, setCurrent] = useState(decision);
  const [comment, setComment] = useState("");
  const { busy, failure, run } = useCoreAction();
  const open = current.status === "open";
  const answer = async (approved: boolean): Promise<void> => {
    const note = comment.trim();
    const answered = await run(
      async (session) =>
        await session.decisions.answer(
          current.id,
          note === "" ? { approved } : { approved, payload: { comment: note } }
        )
    );
    if (answered !== undefined) {
      setCurrent(answered);
    }
  };
  return (
    <Card className="w-full max-w-xl">
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
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5">
              <dt className="text-muted-foreground">
                <Trans context="where a decision comes from">From</Trans>
              </dt>
              <dd className="min-w-0 truncate">
                {current.app.name} · {current.workflow}
              </dd>
              <dt className="text-muted-foreground">
                <Trans context="the run of a workflow a decision is for">
                  Run
                </Trans>
              </dt>
              <dd className="min-w-0 truncate font-mono text-xs leading-5">
                {current.run}
              </dd>
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
            {open ? (
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
                <div className="flex gap-2">
                  <Button
                    disabled={busy}
                    onClick={() => {
                      void answer(true);
                    }}
                    size="sm"
                  >
                    <Trans>Approve</Trans>
                  </Button>
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
            ) : (
              <output>{outcomeOf(current)}</output>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
};

/** A page of its own, for someone not signed in or when core is away. */
const OnItsOwn = ({ children }: { children: ReactNode }) => (
  <main className="bg-background flex min-h-svh flex-col items-center justify-center gap-4 p-6 text-center text-sm">
    <GraspMark className="text-foreground size-6" />
    {children}
  </main>
);

/** The decision in the app's frame, under the crumbs to its workflow. */
const InFrame = ({
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
      <div className="flex flex-col items-center gap-4 p-6 text-sm">
        {children}
      </div>
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
        <h1 className="text-2xl font-medium tracking-tight">
          <Trans>Decision</Trans>
        </h1>
        <ErrorText>
          {t`Grasp can't be reached right now. Try again in a moment.`}
        </ErrorText>
      </OnItsOwn>
    );
  }
  if (page.state === "signed-out") {
    return (
      <OnItsOwn>
        <h1 className="text-2xl font-medium tracking-tight">
          <Trans>Sign in to answer</Trans>
        </h1>
        <p className="text-muted-foreground">
          <Trans>Only the people this decision is from can answer it.</Trans>
        </p>
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
  if (page.state === "refused") {
    return (
      <InFrame
        crumbs={[workflows, { label: t`Decision` }]}
        identity={page.identity}
      >
        <h1 className="text-2xl font-medium tracking-tight">
          <Trans>Decision</Trans>
        </h1>
        <ErrorText>{page.message}</ErrorText>
        <Link className="underline-offset-4 hover:underline" to="/">
          <Trans>Go to Grasp</Trans>
        </Link>
      </InFrame>
    );
  }
  const { decision } = page;
  return (
    <InFrame
      crumbs={[
        workflows,
        {
          label: decision.workflow,
          to: "/workflows/$app/$workflow",
          params: { app: decision.app.id, workflow: decision.workflow },
        },
        { label: t`Decision` },
      ]}
      identity={page.identity}
    >
      <DecisionCard decision={decision} />
    </InFrame>
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
