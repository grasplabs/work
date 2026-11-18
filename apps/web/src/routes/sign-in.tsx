import { useLingui } from "@lingui/react/macro";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useRef, useState } from "react";

import { forgetActiveChats } from "../chat/active-chat.ts";
import { loadCoreStatus } from "../core-connection.ts";
import { leaveToSignIn, signInAddress } from "../core.ts";
import { languageOptions } from "../frame/language-options.ts";
import { BrandGoogle, BrandMicrosoft, Lock } from "../grasp/icons/index.ts";
import type { IconData } from "../grasp/icons/index.ts";
import { LanguageSwitch } from "../grasp/language-switch/index.ts";
import { SignIn as SignInDoor } from "../grasp/sign-in/index.ts";
import type { SignInNotice } from "../grasp/sign-in/index.ts";
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
 * The library's sign-in page, the website's log-in: a button for each way
 * this deployment offers, Grasp staff's own way after them, why the last
 * sign-in was refused over them, and the language at its foot. A chosen way
 * asks core where to go at the press and leaves for its identity provider
 * once the door has opened, coming back to `returnTo`.
 */
const SignIn = () => {
  const { connected, signInOptions } = Route.useLoaderData();
  const { error, returnTo } = Route.useSearch();
  // The way being left for, so the others are out of use meanwhile.
  const [leaving, setLeaving] = useState<string>();
  // Where to leave for, asked of core at the press.
  const asked = useRef<Promise<string> | null>(null);
  const ask = async (id: string): Promise<string> =>
    await signInAddress(id === "staff" ? staffProvider : id, returnTo);
  const ways = connected ? signInOptions : [];
  const notice = noticeOf(connected, error);
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
      {...(leaving === undefined ? {} : { leaving })}
      {...(notice === undefined ? {} : { notice })}
    />
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
