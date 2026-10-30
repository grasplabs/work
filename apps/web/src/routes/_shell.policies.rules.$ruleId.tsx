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
import {
  bookOf,
  findingsOfLoaded,
  readPeopleOf,
} from "../policies/policies-data.ts";
import {
  editsPolicies,
  RuleActions,
  RuleExceptions,
  RuleStatusControl,
} from "../policies/policy-editing.tsx";
import {
  ConditionChips,
  PolicyExcerpt,
  RuleStatusBadge,
} from "../policies/policy-parts.tsx";
import {
  effectDescription,
  effectLabel,
  findingsWith,
  ruleStatusDescription,
} from "../policies/policy.ts";
import type {
  PolicyBook,
  PolicyFinding,
  PolicyRule,
} from "../policies/policy.ts";

// One rule, as in the prototype (`routes/policies/rules/$ruleId.tsx`):
// what it checks and why, whether it is on, and the apps it catches now.
// Core keeps the rules (policies/policies-data.ts); the organization's own
// admins edit, delete and turn a rule on or off here, and let an app break
// it until a day (policies/policy-editing.tsx). A link to a rule that
// isn't there finds the prototype's state for one.

const RuleDetail = ({
  rule,
  found: all,
  apps,
  book,
  edits,
  people,
}: {
  /** People's names by ID. */
  people: ReadonlyMap<string, string>;
  rule: PolicyRule;
  found: readonly PolicyFinding[];
  /** The Landscape's apps, an exception is granted to one of. */
  apps: readonly LandscapeApp[];
  book: PolicyBook;
  /** Whether the reader may change it. */
  edits: boolean;
}) => {
  const { t, i18n } = useLingui();
  const policy =
    rule.policyId === null
      ? undefined
      : book.policies.find(({ id }) => id === rule.policyId);
  const found = findingsWith(
    book,
    all.filter(({ ruleId }) => ruleId === rule.id)
  );
  const madeOn = formatDate(rule.createdAt);
  // By name, never by ID: unknown when the member list can't be read.
  const maker = people.get(rule.createdBy);
  return (
    <>
      <SiteHeader
        crumbs={[{ label: t`Policies`, to: "/policies" }, { label: rule.name }]}
      />
      <Page>
        <PageHeading
          action={
            edits ? (
              <RuleActions policies={book.policies} rule={rule} />
            ) : undefined
          }
          description={rule.description === "" ? undefined : rule.description}
          meta={<RuleStatusBadge status={rule.status} />}
          title={rule.name}
        />

        <section className="bg-card flex flex-col gap-3 rounded-xl border p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <SectionTitle>
              <Trans>Status</Trans>
            </SectionTitle>
            {edits ? <RuleStatusControl rule={rule} /> : null}
          </div>
          <p className="text-muted-foreground text-base">
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
            {policy === undefined && maker === undefined ? (
              <p>
                <Trans>Made by hand on {madeOn}.</Trans>
              </p>
            ) : null}
            {policy === undefined && maker !== undefined ? (
              <p>
                <Trans>
                  Made by hand by {maker} on {madeOn}.
                </Trans>
              </p>
            ) : null}
            {policy === undefined ? null : (
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

        <RuleExceptions
          apps={apps}
          edits={edits}
          exceptions={book.exceptions}
          rule={rule}
        />
      </Page>
    </>
  );
};

const RulePage = () => {
  const { t } = useLingui();
  const { ruleId } = Route.useParams();
  const { apps, found, book: loaded, people } = Route.useLoaderData();
  const { identity } = Route.useRouteContext();
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
      book={book}
      apps={apps.state === "ready" ? apps.data : []}
      edits={editsPolicies(identity)}
      found={findingsOfLoaded(found).findings}
      people={people}
      rule={rule}
    />
  );
};

export const Route = createFileRoute("/_shell/policies/rules/$ruleId")({
  // The Landscape's apps too: an exception is granted to one of them.
  loader: async ({ context: { core, identity } }) => {
    const [landscape, people] = await Promise.all([
      loadLandscape(core, identity),
      readPeopleOf(core),
    ]);
    return { ...landscape, people };
  },
  pendingComponent: PageLoading,
  component: RulePage,
});
