import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@grasp-os/ui/components/tabs";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@grasp-os/ui/components/toggle-group";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { formatNumber } from "../format.ts";
import { PageLoading } from "../frame/page-states.tsx";
import { Page, PageHeading } from "../frame/page.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { loadLandscape } from "../landscape/landscape-data.ts";
import { NotLoaded } from "../load-from-core.tsx";
import { FindingsTable } from "../policies/findings-table.tsx";
import { policyBook, policyToday } from "../policies/policies-data.ts";
import { PoliciesTable } from "../policies/policies-table.tsx";
import { findings, inForce, peopleAffected } from "../policies/policy.ts";
import type { Finding } from "../policies/policy.ts";
import { RulesTable } from "../policies/rules-table.tsx";

// The policy manager, as in the prototype (`routes/policies/index.tsx`):
// the rules the company set for the apps its people use, the apps that
// break them, and the policies the rules come from. The rules are tested
// against the Landscape's apps (landscape/landscape-data.ts). Grasp keeps
// no policies, rules or exceptions yet (policies/policies-data.ts), so the
// figures are zero and each tab is the prototype's empty state; uploading
// a policy and making a rule, which the prototype offers here, wait for
// core to keep them.

type Tab = "rules" | "apps" | "policies";

type Show = "inForce" | "watching" | "excepted";

const shows: {
  value: Show;
  label: MessageDescriptor;
  match: (finding: Finding) => boolean;
}[] = [
  {
    value: "inForce",
    label: msg({
      message: "Flagged or blocked",
      context: "filter: apps a rule acts on",
    }),
    match: ({ state }) => state === "blocked" || state === "flagged",
  },
  {
    value: "watching",
    label: msg({
      message: "Would apply",
      context: "filter: apps a watching rule would act on",
    }),
    match: ({ state }) => state === "watching",
  },
  {
    value: "excepted",
    label: msg({
      message: "Exceptions",
      context: "filter: apps allowed to break a rule",
    }),
    match: ({ state }) => state === "excepted",
  },
];

const isShow = (value: unknown): value is Show =>
  shows.some((each) => each.value === value);

const Figure = ({
  label,
  value,
  attention = false,
}: {
  label: string;
  value: number;
  attention?: boolean;
}) => (
  <div className="bg-card flex flex-col gap-1 px-4 py-3">
    <dt className="text-muted-foreground">{label}</dt>
    <dd
      className={
        attention
          ? "text-status-attention text-2xl font-medium tabular-nums"
          : "text-2xl font-medium tabular-nums"
      }
    >
      {formatNumber(value)}
    </dd>
  </div>
);

const PoliciesPage = () => {
  const { t, i18n } = useLingui();
  const { apps } = Route.useLoaderData();
  const navigate = useNavigate();
  const tab = Route.useSearch().tab ?? "rules";
  const [show, setShow] = useState<Show>("inForce");
  const { rules, policies, exceptions } = policyBook;

  const found = findings(
    rules,
    apps.state === "ready" ? apps.data : [],
    exceptions,
    policyToday()
  );
  const acting = inForce(found);
  // An app a rule blocks counts as blocked only, even when another rule flags it too.
  const blockedIds = new Set(
    acting.filter(({ state }) => state === "blocked").map(({ app }) => app.id)
  );
  const blocked = blockedIds.size;
  const flagged = new Set(
    acting
      .filter(
        ({ state, app }) => state === "flagged" && !blockedIds.has(app.id)
      )
      .map(({ app }) => app.id)
  ).size;
  const active = rules.filter(({ status }) => status === "active").length;
  const people = peopleAffected(acting);
  const toReview = policies.filter(({ status }) => status === "review").length;
  const matchShow =
    shows.find((each) => each.value === show)?.match ?? (() => true);
  const emptyText = {
    inForce: t`No app breaks an active rule.`,
    watching: t`No watching rule catches an app.`,
    excepted: t`No exceptions.`,
  }[show];

  return (
    <>
      <SiteHeader crumbs={[{ label: t`Policies` }]} />
      <Page wide>
        <PageHeading
          description={t`Rules for the apps and AI tools your people use, drawn from your own policies.`}
          title={t`Policies`}
        />
        <NotLoaded page={apps} />

        <dl className="bg-border grid grid-cols-2 gap-px overflow-hidden rounded-xl border md:grid-cols-4">
          <Figure label={t`Active rules`} value={active} />
          <Figure
            attention={blocked > 0}
            label={t`Apps blocked`}
            value={blocked}
          />
          <Figure
            attention={flagged > 0}
            label={t`Apps flagged`}
            value={flagged}
          />
          <Figure label={t`People using them`} value={people} />
        </dl>

        {/* The prototype's tabs keep 1rem above their content: the tabs' own gap and a margin. */}
        <Tabs
          onValueChange={(value: Tab) => {
            void navigate({
              to: "/policies",
              search: value === "rules" ? {} : { tab: value },
              replace: true,
            });
          }}
          value={tab}
        >
          <TabsList>
            <TabsTrigger value="rules">
              <Trans context="tab: the rules in the policy manager">
                Rules
              </Trans>
            </TabsTrigger>
            <TabsTrigger value="apps">
              <Trans context="tab: apps that break a rule">
                Apps that break them
              </Trans>
            </TabsTrigger>
            <TabsTrigger value="policies">
              <Trans context="tab: the company's own policy documents">
                Your policies
              </Trans>
              {toReview > 0 ? (
                <>
                  <span
                    aria-hidden="true"
                    className="bg-status-attention size-1.75 rounded-full"
                  />
                  <span className="sr-only">{t`${toReview} to review`}</span>
                </>
              ) : null}
            </TabsTrigger>
          </TabsList>

          <TabsContent className="mt-2" value="rules">
            <RulesTable found={found} policies={policies} rules={rules} />
          </TabsContent>

          <TabsContent className="mt-2" value="apps">
            <div className="flex flex-col gap-4">
              <ToggleGroup
                aria-label={t`Show apps`}
                className="flex-wrap"
                onValueChange={(value) => {
                  const [next] = value;
                  setShow(isShow(next) ? next : "inForce");
                }}
                size="sm"
                value={[show]}
                variant="outline"
              >
                {shows.map((each) => (
                  <ToggleGroupItem key={each.value} value={each.value}>
                    {i18n._(each.label)}{" "}
                    <span className="text-muted-foreground tabular-nums">
                      {found.filter(each.match).length}
                    </span>
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              <FindingsTable
                empty={emptyText}
                found={found.filter(matchShow)}
              />
            </div>
          </TabsContent>

          <TabsContent className="mt-2" value="policies">
            <PoliciesTable policies={policies} rules={rules} />
          </TabsContent>
        </Tabs>
      </Page>
    </>
  );
};

export const Route = createFileRoute("/_shell/policies/")({
  validateSearch: (search: Record<string, unknown>): { tab?: Tab } =>
    search.tab === "apps" || search.tab === "policies"
      ? { tab: search.tab }
      : {},
  // The tab is in the address; the apps are read once.
  shouldReload: false,
  loader: async ({ context: { core, identity } }) =>
    await loadLandscape(core, identity),
  pendingComponent: PageLoading,
  component: PoliciesPage,
});
