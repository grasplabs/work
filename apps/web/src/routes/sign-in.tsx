import { useLingui } from "@lingui/react/macro";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { z } from "zod";

import { forgetActiveChats } from "../chat/active-chat.ts";
import { loadCoreStatus } from "../core-connection.ts";
import { leaveToSignIn, signInAddress } from "../core.ts";
import { languageOptions } from "../frame/language-options.ts";
import { OnboardingFrame } from "../frame/onboarding-frame.tsx";
import { BrandGoogle, BrandMicrosoft, Lock } from "../grasp/icons/index.ts";
import type { IconData } from "../grasp/icons/index.ts";
import { LanguageSwitch } from "../grasp/language-switch/index.ts";
import { SignIn as SignInDoor } from "../grasp/sign-in/index.ts";
import type { SignInNotice } from "../grasp/sign-in/index.ts";
import { GuestCodeSignIn, NothingShared } from "../guest-sign-in.tsx";
import { chooseLocale, isLocale } from "../i18n.ts";
import { signInErrorMessage, signInErrorSearch } from "../sign-in-errors.ts";

// Where the product sends whoever isn't signed in (routes/_shell.tsx),
// with the page to go back to. Someone already signed in goes straight
// back there.

const signInPath = "/sign-in";

/** Grasp staff's own way in, as core names it. */
const staffProvider = "grasp-staff";

/** A provider's own mark, by the key core gives it; a lock for one the library has no mark for. */
const marks: Readonly<Record<string, IconData>> = {
  microsoft: BrandMicrosoft,
  google: BrandGoogle,
};

/** Refusals that are no fault of the person's: said plainly, not as a refusal. */
const plainCodes = new Set(["not_open_yet"]);

/**
 * Why someone is back on this page, as the door says it over the buttons:
 * the fixed message for the code core sent back, or that Grasp can't be
 * reached.
 */
const noticeOf = (
  connected: boolean,
  error: string | undefined
): SignInNotice | undefined => {
  if (!connected) {
    return "unreachable";
  }
  if (error === undefined) {
    return undefined;
  }
  return {
    tone: plainCodes.has(error) ? "plain" : "refusal",
    words: signInErrorMessage(error),
  };
};

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

/** The language at the page's foot, chosen as it is picked. */
const Language = () => {
  const { i18n } = useLingui();
  return (
    <LanguageSwitch
      onValueChange={(code) => {
        if (isLocale(code)) {
          void chooseLocale(code);
        }
      }}
      options={languageOptions}
      size="sm"
      value={i18n.locale}
    />
  );
};

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
 * The library's sign-in page, the website's log-in: a button for each way
 * this deployment offers, Grasp staff's own way after them, why the last
 * sign-in was refused over them, and the language at its foot. A chosen way
 * asks core where to go at the press and leaves for its identity provider
 * once the door has opened, coming back to `returnTo`.
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
  // Where to leave for, asked of core at the press.
  const asked = useRef<Promise<string> | null>(null);
  // A guest, from outside the company, is in with nothing of theirs to see
  // yet, or signs in with an emailed code: main's own pages (guest-sign-in.tsx).
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
        <GuestCodeSignIn
          onBack={() => {
            void navigate({ search: { returnTo } });
          }}
        />
      </OnboardingFrame>
    );
  }
  const ask = async (id: string): Promise<string> =>
    await signInAddress(id === "staff" ? staffProvider : id, returnTo);
  const ways = connected ? signInOptions : [];
  const notice = noticeOf(
    connected,
    error ?? (interviewOnly ? "not_open_yet" : undefined)
  );
  return (
    <SignInDoor
      language={<Language />}
      // The door has opened: leave as soon as core has said where to.
      onChoose={(id) => {
        setLeaving(id);
        void (async () => {
          leaveToSignIn(await (asked.current ?? ask(id)));
        })();
      }}
      // Asked at the press, so core answers while the door opens.
      onPress={(id) => {
        asked.current = ask(id);
      }}
      providers={ways
        .filter(({ providerId }) => providerId !== staffProvider)
        .map(({ providerId, label }) => ({
          id: providerId,
          name: label,
          icon: marks[providerId] ?? Lock,
        }))}
      staff={ways.some(({ providerId }) => providerId === staffProvider)}
      {...(connected
        ? {
            footHref: `${signInPath}?by=code&returnTo=${encodeURIComponent(returnTo)}`,
            words: {
              foot: t`Invited as a guest?`,
              footAction: t`Sign in with a code`,
            },
          }
        : {})}
      {...(leaving === undefined ? {} : { leaving })}
      {...(notice === undefined ? {} : { notice })}
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
