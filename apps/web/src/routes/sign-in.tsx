import { Button } from "@grasp-os/app-kit/components/button";
import { PageHeaderTitle } from "@grasp-os/app-kit/components/page-header";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";

import { GraspBuddy } from "../buddy/grasp-buddy.tsx";
import { forgetActiveChats } from "../chat/active-chat.ts";
import { loadCoreStatus } from "../core-connection.ts";
import { ErrorText } from "../error-text.tsx";
import { OnboardingFrame } from "../frame/onboarding-frame.tsx";
import { GuestCodeSignIn, NothingShared } from "../guest-sign-in.tsx";
import { signInErrorSearch } from "../sign-in-errors.ts";
import { SignInOptions } from "../sign-in-options.tsx";

// Where the product sends whoever isn't signed in (routes/_shell.tsx),
// with the page to go back to. Someone already signed in goes straight
// back there.

const signInPath = "/sign-in";

/**
 * What no path of this site holds: control characters and spaces, which
 * browsers drop from an address (`/\t/evil.test` is `//evil.test`), and
 * backslashes, which they read as `/` (`/\evil.test`).
 */
// oxlint-disable-next-line no-control-regex -- control characters are what it looks for
const unsafeInPath = /[\u0000- \u007F\\]/u;

/**
 * The page to go back to: a path of this site, never another site's
 * address (`//evil.test`) and never this page, which would send a signed-in
 * person round in circles. Anyone can put anything in a link.
 */
const returnPathOf = (value: unknown): string =>
  typeof value === "string" &&
  value.startsWith("/") &&
  !value.startsWith("//") &&
  !unsafeInPath.test(value) &&
  !value.startsWith(signInPath)
    ? value
    : "/";

/**
 * A session core made that is no member's, as Better Auth tells it: for
 * someone's interview alone (GRA-1790), or a guest's (GRA-2235).
 */
const otherSessionSchema = z.object({
  session: z
    .object({
      interview: z.boolean().optional(),
      guest: z.boolean().optional(),
    })
    .loose(),
  user: z.object({ email: z.string() }).loose(),
});

/**
 * Whom this browser is signed in for, when not a member. While the gate is
 * closed, someone a link went to who signed in here gets a session for
 * their interview alone: they are told Grasp isn't open yet, as anyone the
 * gate turns away is, and where their link is, rather than asked to sign
 * in again and again. A guest is told nothing is shared with them yet.
 */
const otherSession = async (): Promise<{
  interviewOnly: boolean;
  guest: string | null;
}> => {
  try {
    const response = await fetch("/api/auth/get-session");
    const body: unknown = response.ok ? await response.json() : null;
    const parsed = otherSessionSchema.safeParse(body);
    return {
      interviewOnly: parsed.success && parsed.data.session.interview === true,
      guest:
        parsed.success && parsed.data.session.guest === true
          ? parsed.data.user.email
          : null,
    };
  } catch {
    return { interviewOnly: false, guest: null };
  }
};

/**
 * The page in the onboarding's frame (frame/onboarding-frame.tsx), with
 * Grasp's buddy.
 */
const SignIn = () => {
  const { connected, signInOptions, interviewOnly, guest } =
    Route.useLoaderData();
  const { error, returnTo } = Route.useSearch();
  const { core } = Route.useRouteContext();
  const { t } = useLingui();
  const [byCode, setByCode] = useState(false);
  if (guest !== null) {
    return (
      <OnboardingFrame>
        <GraspBuddy />
        <NothingShared core={core} email={guest} />
      </OnboardingFrame>
    );
  }
  return (
    <OnboardingFrame>
      <GraspBuddy />
      <div className="flex flex-col gap-2">
        <PageHeaderTitle>
          <Trans>Sign in to Grasp</Trans>
        </PageHeaderTitle>
        {connected && !byCode ? (
          <p className="text-muted-foreground text-balance">
            <Trans>Use your organization’s account to go on.</Trans>
          </p>
        ) : null}
      </div>
      {connected && byCode ? (
        <GuestCodeSignIn
          onBack={() => {
            setByCode(false);
          }}
        />
      ) : null}
      {connected && !byCode ? (
        <>
          <SignInOptions
            error={error ?? (interviewOnly ? "not_open_yet" : undefined)}
            options={signInOptions}
            returnTo={returnTo}
          />
          <Button
            className="w-full"
            onClick={() => {
              setByCode(true);
            }}
            variant="ghost"
          >
            <Trans>Invited as a guest? Sign in with a code</Trans>
          </Button>
        </>
      ) : null}
      {connected ? null : (
        <ErrorText>
          {t`Grasp can't be reached right now. Try again in a moment.`}
        </ErrorText>
      )}
    </OnboardingFrame>
  );
};

export const Route = createFileRoute("/sign-in")({
  validateSearch: (
    search: Record<string, unknown>
  ): { returnTo: string; error?: string } => ({
    returnTo: returnPathOf(search.returnTo),
    ...signInErrorSearch(search),
  }),
  loaderDeps: ({ search }) => ({ returnTo: search.returnTo }),
  loader: async ({ context: { core }, deps }) => {
    const status = await loadCoreStatus(core);
    if (status.identity !== undefined) {
      // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
      throw redirect({ href: deps.returnTo });
    }
    // Signed out, as core says it: whoever signs in next in this tab
    // starts without the last person's open chat, which isn't theirs to
    // open. Not while core can't be reached, when nobody knows who is in.
    if (status.connected) {
      forgetActiveChats();
    }
    return { ...status, ...(await otherSession()) };
  },
  component: SignIn,
});
