import { decisionErrors } from "@grasp-os/shared/decisions";
import type { DecisionView } from "@grasp-os/shared/decisions";
import { failureText } from "@grasp-os/shared/errors";
import type { Identity, SignInOption } from "@grasp-os/shared/rpc";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { createFileRoute, Link as RouterLink } from "@tanstack/react-router";
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
import { Heading } from "../grasp/heading/index.ts";
import { iconVars } from "../grasp/icons/icon.stylex.ts";
import { BrandGrasp, Icon } from "../grasp/icons/index.ts";
import { Link } from "../grasp/link/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { signInErrorSearch } from "../sign-in-errors.ts";
import { SignInOptions } from "../sign-in-options.tsx";
import { readWorkflowTitles, titledDecision } from "../workflows/reads.ts";

// Where a decision link leads (`/decisions/<id>`), from notifications, the
// runs log or mail. Opening it answers nothing (threat model R8): the
// person signs in, sees what is asked, and answers with a button. Core
// checks on every call that they may answer; this page only shows what
// core says. Someone signed in sees it in the app's frame; anyone else
// on a page of its own, asked to sign in. The card is decision-card.tsx.

const styles = stylex.create({
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
    // The mark as wide as before: the library's sits in the icon's square.
    [iconVars.size]: grasp.avatarXs,
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
    const found = await readWithin(core, async (session) => {
      const [read, titles] = await Promise.all([
        session.decisions.get(decision),
        readWorkflowTitles(session),
      ]);
      return titledDecision(read, titles);
    });
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
  <main {...stylex.props(styles.alone)}>
    <Icon icon={BrandGrasp} />
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
      <DecisionCard decision={decision} where="page" />
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
