import { decisionErrors } from "@grasp-os/shared/decisions";
import type { DecisionView } from "@grasp-os/shared/decisions";
import { failureText } from "@grasp-os/shared/errors";
import type { Identity, SignInOption } from "@grasp-os/shared/rpc";
import { GraspMark } from "@grasp-os/ui/components/grasp-mark";
import { PageHeaderTitle } from "@grasp-os/ui/components/page-header";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { loadCoreStatus, readWithin } from "../core-connection.ts";
import type { CoreConnection } from "../core-connection.ts";
import { CoreTimeoutError } from "../core.ts";
import { DecisionCard } from "../decision-card.tsx";
import { decisionSource } from "../decision-source.ts";
import { ErrorText } from "../error-text.tsx";
import { AppFrame } from "../frame/app-frame.tsx";
import { NotFound } from "../frame/page-states.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import type { Crumb } from "../frame/site-header.tsx";
import { signInErrorSearch } from "../sign-in-errors.ts";
import { SignInOptions } from "../sign-in-options.tsx";

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

/** A page of its own, for someone not signed in or when core is away. */
const OnItsOwn = ({ children }: { children: ReactNode }) => (
  <main className="bg-background flex min-h-svh flex-col items-center justify-center gap-4 p-6 text-center text-sm">
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
      <div className="pb-chat flex flex-col items-center gap-4 px-6 pt-7 text-sm">
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
        <PageHeaderTitle>
          <Trans>Decision</Trans>
        </PageHeaderTitle>
        <ErrorText>
          {t`Grasp can't be reached right now. Try again in a moment.`}
        </ErrorText>
      </OnItsOwn>
    );
  }
  if (page.state === "signed-out") {
    return (
      <OnItsOwn>
        <PageHeaderTitle>
          <Trans>Sign in to answer</Trans>
        </PageHeaderTitle>
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
  if (page.state === "not-yours") {
    return (
      <DecisionInFrame
        crumbs={[workflows, { label: t`Decision` }]}
        identity={page.identity}
      >
        <PageHeaderTitle>
          <Trans>Decision</Trans>
        </PageHeaderTitle>
        <p className="text-muted-foreground">
          <Trans>This decision is for someone else to answer.</Trans>
        </p>
        <Link className="underline-offset-4 hover:underline" to="/">
          <Trans>Go to Grasp</Trans>
        </Link>
      </DecisionInFrame>
    );
  }
  if (page.state === "refused") {
    return (
      <DecisionInFrame
        crumbs={[workflows, { label: t`Decision` }]}
        identity={page.identity}
      >
        <PageHeaderTitle>
          <Trans>Decision</Trans>
        </PageHeaderTitle>
        <ErrorText>{page.message}</ErrorText>
        <Link className="underline-offset-4 hover:underline" to="/">
          <Trans>Go to Grasp</Trans>
        </Link>
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
