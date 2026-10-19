import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@grasp-os/ui/components/alert";
import { Button } from "@grasp-os/ui/components/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import { Spinner } from "@grasp-os/ui/components/spinner";
import type { MessageDescriptor } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, Link } from "@tanstack/react-router";

import { formatDate } from "../format.ts";
import { PageLoading } from "../frame/page-states.tsx";
import { Page, PageHeading, SectionTitle } from "../frame/page.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { loadLandscape } from "../landscape/landscape-data.ts";
import type { LandscapeApp } from "../landscape/landscape.ts";
import { policyBook } from "../policies/policies-data.ts";
import {
  ConditionChips,
  PolicyExcerpt,
  RuleStatusBadge,
} from "../policies/policy-parts.tsx";
import { effectLabel, matchingApps } from "../policies/policy.ts";
import type {
  PolicyDocument,
  PolicyReadingProblem,
  RuleProposal,
} from "../policies/policy.ts";

// One of the company's policies, as in the prototype
// (`routes/policies/documents/$policyId.tsx`): while Grasp reads it, the
// page says so; then each proposed rule waits for a decision, and its
// published rules are listed. The prototype keeps, edits and leaves out a
// proposal, publishes and removes the policy here; Grasp keeps no
// policies yet (policies/policies-data.ts), so every link to one finds the
// prototype's state for a policy that isn't there.

const readingProblem: Record<PolicyReadingProblem, MessageDescriptor> = {
  notSetUp: msg`Reading policies is not set up yet. Add your own Anthropic key in Settings, under Models, and upload the policy again.`,
  busy: msg`Grasp is busy right now. Remove this policy and upload it again in a minute.`,
  badKey: msg`The model key does not work. Check it in Settings, under Models.`,
  unreadable: msg`The file could not be read. Try a PDF or a text file.`,
  offline: msg`Grasp could not be reached. Check the connection and upload the policy again.`,
};

/** One proposed rule: what it checks, the passage it comes from, and what was decided. */
const ProposalCard = ({
  proposal,
  apps,
}: {
  proposal: RuleProposal;
  apps: readonly LandscapeApp[];
}) => {
  const { t, i18n } = useLingui();
  const caught = matchingApps(proposal, apps).length;
  return (
    <article
      className={
        proposal.decision === "rejected"
          ? "bg-card flex flex-col gap-3 rounded-xl border p-4 opacity-60"
          : "bg-card flex flex-col gap-3 rounded-xl border p-4"
      }
    >
      <div className="flex min-w-0 flex-col gap-1">
        <h3 className="font-medium">{proposal.name}</h3>
        {proposal.description === "" ? null : (
          <p className="text-muted-foreground">{proposal.description}</p>
        )}
      </div>
      <ConditionChips conditions={proposal.conditions} />
      <p className="text-muted-foreground">
        <span className="text-foreground font-medium">
          {i18n._(effectLabel[proposal.effect])}
        </span>{" "}
        ·{" "}
        {caught === 0
          ? t`No app in the landscape breaks it today.`
          : plural(caught, {
              one: "Would catch # app today.",
              other: "Would catch # apps today.",
            })}
      </p>
      {proposal.excerpt === "" ? null : (
        <PolicyExcerpt text={proposal.excerpt} />
      )}
    </article>
  );
};

const PolicyDetail = ({
  policy,
  apps,
}: {
  policy: PolicyDocument;
  apps: readonly LandscapeApp[];
}) => {
  const { t, i18n } = useLingui();
  const uploadedOn = formatDate(policy.uploadedAt);
  const { uploadedBy, fileName } = policy;
  const rules = policyBook.rules.filter((rule) => rule.policyId === policy.id);
  return (
    <>
      <SiteHeader
        crumbs={[
          { label: t`Policies`, to: "/policies" },
          { label: policy.title },
        ]}
      />
      <Page>
        <PageHeading
          description={policy.summary}
          meta={
            <span className="text-muted-foreground">
              <Trans>
                {fileName} · uploaded by {uploadedBy} on {uploadedOn}
              </Trans>
            </span>
          }
          title={policy.title}
        />

        {policy.status === "reading" ? (
          <div className="rounded-xl border">
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Spinner />
                </EmptyMedia>
                <EmptyTitle>
                  <Trans>Grasp is reading the policy</Trans>
                </EmptyTitle>
                <EmptyDescription>
                  <Trans>
                    It looks for the requirements about apps and AI tools, and
                    proposes a rule for each. This takes up to a minute.
                  </Trans>
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          </div>
        ) : null}

        {policy.status === "failed" ? (
          <Alert variant="destructive">
            <AlertTitle>
              <Trans>Grasp could not read this policy</Trans>
            </AlertTitle>
            <AlertDescription>
              {policy.error === undefined
                ? null
                : i18n._(readingProblem[policy.error])}
            </AlertDescription>
          </Alert>
        ) : null}

        {policy.status === "review" ? (
          <section className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <SectionTitle>
                <Trans>Proposed rules</Trans>
              </SectionTitle>
              <p className="text-muted-foreground">
                <Trans>
                  Keep the rules that say what your policy means, edit them
                  where needed, and leave out the rest.
                </Trans>
              </p>
            </div>
            {policy.proposals.length === 0 ? (
              <p className="bg-card text-muted-foreground rounded-xl border p-4">
                <Trans>
                  Grasp found no requirement in this policy that a rule can
                  check.
                </Trans>
              </p>
            ) : (
              policy.proposals.map((proposal) => (
                <ProposalCard
                  apps={apps}
                  key={proposal.id}
                  proposal={proposal}
                />
              ))
            )}
            <p className="text-muted-foreground">
              <Trans>
                Published rules start by watching: they show what they would
                flag or block, and you turn them on when you are ready.
              </Trans>
            </p>
          </section>
        ) : null}

        {policy.status === "published" ? (
          <section className="flex flex-col gap-3">
            <SectionTitle>
              <Trans>Rules from this policy</Trans>
            </SectionTitle>
            {rules.length === 0 ? (
              <p className="bg-card text-muted-foreground rounded-xl border p-4">
                <Trans>None of its rules are in use any more.</Trans>
              </p>
            ) : (
              <ul className="bg-card flex flex-col divide-y rounded-xl border">
                {rules.map((rule) => (
                  <li className="flex flex-col gap-2 p-4" key={rule.id}>
                    <div className="flex items-center justify-between gap-3">
                      <Link
                        className="font-medium hover:underline"
                        params={{ ruleId: rule.id }}
                        to="/policies/rules/$ruleId"
                      >
                        {rule.name}
                      </Link>
                      <RuleStatusBadge status={rule.status} />
                    </div>
                    <ConditionChips conditions={rule.conditions} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}

        {policy.unchecked.length > 0 ? (
          <section className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <SectionTitle>
                <Trans>What Grasp cannot check yet</Trans>
              </SectionTitle>
              <p className="text-muted-foreground">
                <Trans>
                  These requirements are about how people work, not which apps
                  they use. They stay in your policy; no rule watches them.
                </Trans>
              </p>
            </div>
            <ul className="bg-card flex flex-col divide-y rounded-xl border">
              {policy.unchecked.map((item) => (
                <li className="flex flex-col gap-2 p-4" key={item.requirement}>
                  <span>{item.requirement}</span>
                  {item.excerpt === "" ? null : (
                    <PolicyExcerpt text={item.excerpt} />
                  )}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </Page>
    </>
  );
};

const PolicyPage = () => {
  const { t } = useLingui();
  const { policyId } = Route.useParams();
  const { apps } = Route.useLoaderData();
  const policy = policyBook.policies.find(({ id }) => id === policyId);
  if (policy === undefined) {
    return (
      <>
        <SiteHeader
          crumbs={[
            { label: t`Policies`, to: "/policies" },
            { label: t`Policy not found` },
          ]}
        />
        <Empty>
          <EmptyHeader>
            <EmptyTitle>
              <h1>
                <Trans>This policy is not here any more</Trans>
              </h1>
            </EmptyTitle>
            <EmptyDescription>
              <Trans>It may have been removed.</Trans>
            </EmptyDescription>
          </EmptyHeader>
          <Button
            nativeButton={false}
            render={<Link search={{ tab: "policies" }} to="/policies" />}
            variant="outline"
          >
            <Trans>Back to policies</Trans>
          </Button>
        </Empty>
      </>
    );
  }
  return (
    <PolicyDetail
      apps={apps.state === "ready" ? apps.data : []}
      policy={policy}
    />
  );
};

export const Route = createFileRoute("/_shell/policies/documents/$policyId")({
  loader: async ({ context: { core, identity } }) =>
    await loadLandscape(core, identity),
  pendingComponent: PageLoading,
  component: PolicyPage,
});
