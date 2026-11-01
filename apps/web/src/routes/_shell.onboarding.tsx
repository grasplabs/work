import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";

import { SiteHeader } from "../frame/site-header.tsx";

// What is left of Grasp's onboarding area in this deployment: the
// agreements, for Grasp's staff alone, until the admin's setup takes them.
// Everything else staff do to steer an onboarding is in Grasp's admin.
// Core checks it is staff on every call.

const agreements = msg({
  message: "Agreements",
  context: "onboarding area section",
});

const OnboardingArea = () => {
  const { t, i18n } = useLingui();
  return (
    <>
      <SiteHeader
        crumbs={[{ label: t`Onboarding` }, { label: i18n._(agreements) }]}
      />
      <div className="mx-auto flex w-full max-w-5xl min-w-0 flex-col gap-6 px-6 py-7 text-sm">
        <Outlet />
      </div>
    </>
  );
};

export const Route = createFileRoute("/_shell/onboarding")({
  // Staff's alone: anyone else is taken home rather than shown a refusal.
  beforeLoad: ({ context: { identity } }) => {
    if (!identity.staff) {
      // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
      throw redirect({ to: "/", replace: true });
    }
  },
  component: OnboardingArea,
});
