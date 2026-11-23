import { Link } from "@grasp-os/ui/components/link";
import { Text } from "@grasp-os/ui/components/text";
import { LockIcon } from "@grasp-os/ui/lib/icons";
import type { IconData } from "@grasp-os/ui/lib/icons";
import { visuallyHidden } from "@grasp-os/ui/lib/styles";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { z } from "zod";

import { forgetActiveChats } from "../chat/active-chat.ts";
import { GoogleLogo, MicrosoftLogo } from "../connections/brand-logos.ts";
import { loadCoreStatus } from "../core-connection.ts";
import { leaveToSignIn, signInAddress } from "../core.ts";
import { LanguageButton } from "../frame/language-button.tsx";
import { OnboardingFrame } from "../frame/onboarding-frame.tsx";
import { SignIn as SignInPage } from "../frame/sign-in/sign-in.tsx";
import type { SignInNotice } from "../frame/sign-in/sign-in.tsx";
import { GuestCodeSignIn, NothingShared } from "../guest-sign-in.tsx";
import { signInErrorMessage, signInErrorSearch } from "../sign-in-errors.ts";

// Where the product sends whoever isn't signed in (routes/_shell.tsx),
// with the page to go back to. Someone already signed in goes straight
// back there.

const signInPath = "/sign-in";

/** Grasp staff's own way in, as core names it. */
const staffProvider = "grasp-staff";

/** A provider's own mark, by the key core gives it; a lock for one with no mark here. */
const marks: Readonly<Record<string, IconData>> = {
  microsoft: MicrosoftLogo,
  google: GoogleLogo,
};

/** Refusals that are no fault of the person's: said plainly, not as a refusal. */
const plainCodes = new Set(["not_open_yet"]);

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
 * Where the page leaves for at a press, asked of core then, so it answers
 * while the door opens; null when core would not start the sign-in.
 */
const useLeave = (returnTo: string) => {
  const asked = useRef<Promise<string | null> | null>(null);
  const ask = (id: string): void => {
    const provider = id === "staff" ? staffProvider : id;
    asked.current = (async () => {
      try {
        return await signInAddress(provider, returnTo);
      } catch {
        return null;
      }
    })();
  };
  /** Leaves for the identity provider; false when the sign-in didn't start. */
  const leave = async (): Promise<boolean> => {
    const address = await asked.current;
    if (address === null) {
      return false;
    }
    leaveToSignIn(address);
    return true;
  };
  return { ask, leave };
};

/**
 * The website's log-in (frame/sign-in): a button for each way this
 * deployment offers, Grasp staff's own way after them, why the last sign-in
 * was refused over them, and the language at its foot. A chosen way asks
 * core where to go at the press and leaves for its identity provider once
 * the door has opened, coming back to `returnTo`. A guest, from outside the
 * company, signs in with an emailed code (guest-sign-in.tsx), or is in with
 * nothing of theirs to see yet.
 */
const SignIn = () => {
  const { connected, signInOptions, interviewOnly, guest } =
    Route.useLoaderData();
  const { error, returnTo, by } = Route.useSearch();
  const { core } = Route.useRouteContext();
  const navigate = Route.useNavigate();
  const { t } = useLingui();
  // The way being left for, so the others are out of use meanwhile.
  const [leaving, setLeaving] = useState<string>();
  // A press whose sign-in didn't start: the page again, from the start, saying so.
  const [tries, setTries] = useState(0);
  const [failed, setFailed] = useState(false);
  const { ask, leave } = useLeave(returnTo);
  if (guest !== null) {
    return (
      <OnboardingFrame>
        <NothingShared core={core} email={guest} />
      </OnboardingFrame>
    );
  }
  if (by === "code" && connected) {
    return (
      <OnboardingFrame>
        {/* The page's title, heard and not shown: the form is the whole page. */}
        <h1 {...stylex.props(visuallyHidden)}>
          <Trans>Sign in to Grasp</Trans>
        </h1>
        <GuestCodeSignIn
          onBack={() => {
            void navigate({ search: { returnTo } });
          }}
        />
      </OnboardingFrame>
    );
  }
  const code = error ?? (interviewOnly ? "not_open_yet" : undefined);
  const notice = ((): SignInNotice | undefined => {
    if (!connected) {
      return {
        plain: false,
        words: t`Grasp can't be reached right now. Try again in a moment.`,
      };
    }
    if (failed) {
      return { plain: false, words: signInErrorMessage("") };
    }
    return code === undefined
      ? undefined
      : { plain: plainCodes.has(code), words: signInErrorMessage(code) };
  })();
  const ways = connected ? signInOptions : [];
  const codePath = `${signInPath}?by=code&returnTo=${encodeURIComponent(returnTo)}`;
  return (
    <SignInPage
      again={failed}
      foot={
        <>
          {connected ? (
            <Text as="p" color="muted" size="sm">
              {t`Invited as a guest?`}{" "}
              <Link href={codePath}>{t`Sign in with a code`}</Link>
            </Text>
          ) : null}
          <LanguageButton />
        </>
      }
      key={tries}
      leaving={leaving}
      notice={notice}
      // The door has opened: leave as soon as core has said where to.
      onChoose={(id) => {
        setLeaving(id);
        void (async () => {
          if (!(await leave())) {
            setLeaving(undefined);
            setFailed(true);
            setTries((count) => count + 1);
          }
        })();
      }}
      // Asked at the press, so core answers while the door opens.
      onPress={ask}
      providers={ways
        .filter(({ providerId }) => providerId !== staffProvider)
        .map(({ providerId, label }) => ({
          id: providerId,
          name: label,
          icon: marks[providerId] ?? LockIcon,
        }))}
      staff={ways.some(({ providerId }) => providerId === staffProvider)}
    />
  );
};

export const Route = createFileRoute("/sign-in")({
  validateSearch: (
    search: Record<string, unknown>
  ): { returnTo: string; error?: string; by?: "code" } => ({
    returnTo: returnPathOf(search.returnTo),
    ...(search.by === "code" ? { by: "code" as const } : {}),
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
