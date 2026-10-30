import { useLingui } from "@lingui/react/macro";
import { createFileRoute, redirect } from "@tanstack/react-router";

import { PageLoading } from "../frame/page-states.tsx";
import { Page } from "../frame/page.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { NotLoaded } from "../load-from-core.tsx";
import { bookOf, readPolicyBook } from "../policies/policies-data.ts";
import { editsPolicies, NewRule } from "../policies/policy-editing.tsx";

// A rule made by hand, on a page of its own, as in the prototype
// (`routes/policies/rules/new.tsx`); `?policy=<id>` makes it from that
// policy. Only the organization's own admins make rules: anyone else is
// sent back to the policy manager.

const NewRulePage = () => {
  const { t } = useLingui();
  const book = Route.useLoaderData();
  const { policy } = Route.useSearch();
  const { policies } = bookOf(book);
  // Only a policy the book holds: anyone can put an ID in a link.
  const from = policies.some(({ id }) => id === policy) ? policy : undefined;
  return (
    <>
      <SiteHeader
        crumbs={[
          { label: t`Policies`, to: "/policies" },
          { label: t`New rule` },
        ]}
      />
      <Page wide>
        <NotLoaded page={book} />
        <NewRule policies={policies} policyId={from ?? null} />
      </Page>
    </>
  );
};

export const Route = createFileRoute("/_shell/policies/rules/new")({
  validateSearch: (search: Record<string, unknown>): { policy?: string } =>
    typeof search.policy === "string" && search.policy !== ""
      ? { policy: search.policy }
      : {},
  beforeLoad: ({ context: { identity } }) => {
    if (!editsPolicies(identity)) {
      // oxlint-disable-next-line typescript/only-throw-error -- the router's redirect is thrown
      throw redirect({ to: "/policies" });
    }
  },
  loader: async ({ context: { core } }) => await readPolicyBook(core),
  pendingComponent: PageLoading,
  component: NewRulePage,
});
