import { Button } from "@grasp-os/ui/components/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, Link } from "@tanstack/react-router";

import { formatDate } from "../format.ts";
import { PageLoading } from "../frame/page-states.tsx";
import { Page, PageHeading, SectionTitle } from "../frame/page.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { loadLandscape } from "../landscape/landscape-data.ts";
import type { LandscapeApp } from "../landscape/landscape.ts";
import { FindingsTable } from "../policies/findings-table.tsx";
import { bookOf, policyToday } from "../policies/policies-data.ts";
import {
  ConditionChips,
  PolicyExcerpt,
  RuleStatusBadge,
} from "../policies/policy-parts.tsx";
import {
  effectDescription,
  effectLabel,
  findings,
  ruleStatusDescription,
} from "../policies/policy.ts";
import type { PolicyBook, PolicyRule } from "../policies/policy.ts";

// One rule, as in the prototype (`routes/policies/rules/$ruleId.tsx`):
// what it checks and why, whether it is on, and the apps it catches now.
// Core keeps the rules (policies/policies-data.ts); editing, deleting and
// turning a rule on or off here, as the prototype does, come with the
// policy pages' port. A link to a rule that isn't there finds the
// prototype's state for one.

const RuleDetail = ({
  rule,
  apps,
  book,
}: {
  rule: PolicyRule;
  apps: readonly LandscapeApp[];
  book: PolicyBook;
}) => {
  const { t, i18n } = useLingui();
  const policy =
    rule.policyId === null
      ? undefined
      : book.policies.find(({ id }) => id === rule.policyId);
  const found = findings([rule], apps, book.exceptions, policyToday());
  const madeOn = formatDate(rule.createdAt);
  const { createdBy } = rule;
  return (
    <>
      <SiteHeader
        crumbs={[{ label: t`Policies`, to: "/policies" }, { label: rule.name }]}
      />
      <Page>
        <PageHeading
          description={rule.description === "" ? undefined : rule.description}
          meta={<RuleStatusBadge status={rule.status} />}
          title={rule.name}
        />

        <section className="bg-card flex flex-col gap-3 rounded-xl border p-4">
          <SectionTitle>
            <Trans>Status</Trans>
          </SectionTitle>
          <p className="text-muted-foreground">
            {i18n._(ruleStatusDescription[rule.status])}
          </p>
        </section>

        <section className="flex flex-col gap-3">
          <SectionTitle>
            <Trans>What it checks</Trans>
          </SectionTitle>
          <div className="bg-card flex flex-col gap-3 rounded-xl border p-4">
            <ConditionChips conditions={rule.conditions} />
            <p>
              <span className="font-medium">
                {i18n._(effectLabel[rule.effect])}
              </span>
              <span className="text-muted-foreground">
                {" "}
                · {i18n._(effectDescription[rule.effect])}
              </span>
            </p>
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <SectionTitle>
            <Trans>Where it comes from</Trans>
          </SectionTitle>
          <div className="bg-card flex flex-col gap-3 rounded-xl border p-4">
            {policy === undefined ? (
              <p>
                <Trans>
                  Made by hand by {createdBy} on {madeOn}.
                </Trans>
              </p>
            ) : (
              <>
                <p>
                  <Link
                    className="font-medium hover:underline"
                    params={{ policyId: policy.id }}
                    to="/policies/documents/$policyId"
                  >
                    {policy.title}
                  </Link>
                </p>
                {rule.excerpt === undefined ? null : (
                  <PolicyExcerpt text={rule.excerpt} />
                )}
              </>
            )}
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <SectionTitle>
            <Trans>Apps it catches</Trans>
          </SectionTitle>
          <FindingsTable
            empty={
              rule.status === "paused"
                ? t`The rule is paused, so it catches nothing.`
                : t`No app in the landscape breaks this rule.`
            }
            found={found}
            showRule={false}
          />
        </section>
      </Page>
    </>
  );
};

const RulePage = () => {
  const { t } = useLingui();
  const { ruleId } = Route.useParams();
  const { apps, book: loaded } = Route.useLoaderData();
  const book = bookOf(loaded);
  const rule = book.rules.find(({ id }) => id === ruleId);
  if (rule === undefined) {
    return (
      <>
        <SiteHeader
          crumbs={[
            { label: t`Policies`, to: "/policies" },
            { label: t`Rule not found` },
          ]}
        />
        <Empty>
          <EmptyHeader>
            <EmptyTitle>
              <h1>
                <Trans>This rule is not here any more</Trans>
              </h1>
            </EmptyTitle>
            <EmptyDescription>
              <Trans>
                It may have been deleted, or removed with its policy.
              </Trans>
            </EmptyDescription>
          </EmptyHeader>
          <Button
            nativeButton={false}
            render={<Link to="/policies" />}
            variant="outline"
          >
            <Trans>Back to policies</Trans>
          </Button>
        </Empty>
      </>
    );
  }
  return (
    <RuleDetail
      apps={apps.state === "ready" ? apps.data : []}
      book={book}
      rule={rule}
    />
  );
};

export const Route = createFileRoute("/_shell/policies/rules/$ruleId")({
  loader: async ({ context: { core, identity } }) =>
    await loadLandscape(core, identity),
  pendingComponent: PageLoading,
  component: RulePage,
});
