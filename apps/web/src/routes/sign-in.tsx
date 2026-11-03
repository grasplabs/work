import { GraspMark } from "@grasp-os/ui/components/grasp-mark";
import { PaintedField } from "@grasp-os/ui/components/painted-field";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, redirect } from "@tanstack/react-router";

import { forgetActiveChats } from "../chat/active-chat.ts";
import { loadCoreStatus } from "../core-connection.ts";
import { ErrorText } from "../error-text.tsx";
import { LanguageButton } from "../language-picker.tsx";
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

/** Where Grasp's terms and privacy policy are published. */
const graspSite = "https://joingrasp.com";

/**
 * The page as joingrasp.com's log-in page is (grasplabs/grasp
 * `apps/marketing/src/pages/login.astro`), so there is one way in to
 * Grasp: its painted dawn with light falling down the columns and Grasp's
 * line on one side, the card with a button per work account on the
 * other, stacked on a phone. Only the buttons differ: they start this
 * deployment's own sign-in, with the IdPs it is set up with. Its "New to
 * Grasp? Talk to us" is left out, as everyone here is already in.
 */
const SignIn = () => {
  const { connected, signInOptions } = Route.useLoaderData();
  const { error, returnTo } = Route.useSearch();
  const { t } = useLingui();
  return (
    <div className="bg-background grid min-h-svh text-sm lg:grid-cols-2">
      <PaintedField
        className="m-2 flex min-h-96 flex-col justify-between gap-10 p-7 sm:p-10 lg:m-3"
        painting="dawn"
        pattern="columns"
      >
        <span aria-hidden="true" className="sign-in-beams">
          <span />
          <span />
          <span />
        </span>
        <span className="flex items-center gap-2 text-lg font-medium">
          <GraspMark className="size-5" />
          Grasp
        </span>
        <p className="type-display sign-in-rise max-w-sm lg:text-5xl">
          <Trans>Find the work AI should be doing.</Trans>
        </p>
      </PaintedField>
      <div className="flex flex-col">
        <main className="flex flex-1 items-center justify-center px-6 py-12 sm:px-10">
          <div className="sign-in-float flex w-full max-w-sm flex-col gap-7">
            <div className="flex flex-col gap-2.5">
              <h1 className="type-display">
                <Trans>Welcome back.</Trans>
              </h1>
              {connected ? (
                <p className="text-muted-foreground text-base">
                  <Trans>Log in with your work account.</Trans>
                </p>
              ) : null}
            </div>
            {connected ? (
              <SignInOptions
                error={error}
                options={signInOptions}
                returnTo={returnTo}
              />
            ) : (
              <ErrorText>
                {t`Grasp can't be reached right now. Try again in a moment.`}
              </ErrorText>
            )}
            <p className="text-muted-foreground">
              <Trans>
                By continuing, you agree to Grasp’s{" "}
                <a
                  className="text-foreground underline underline-offset-3"
                  href={`${graspSite}/terms-of-service`}
                  rel="noopener"
                  target="_blank"
                >
                  terms
                </a>{" "}
                and{" "}
                <a
                  className="text-foreground underline underline-offset-3"
                  href={`${graspSite}/privacy-policy`}
                  rel="noopener"
                  target="_blank"
                >
                  privacy policy
                </a>
                .
              </Trans>
            </p>
          </div>
        </main>
        <footer className="flex h-18 flex-none items-center justify-end px-4 sm:px-10">
          <LanguageButton />
        </footer>
      </div>
    </div>
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
    return status;
  },
  component: SignIn,
});
