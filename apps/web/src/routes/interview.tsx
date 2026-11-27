import { devInterviewLinkPath } from "@grasp-os/shared/dev-reset";
import { interviewPagePath } from "@grasp-os/shared/interview-links";
import type { SignInOption } from "@grasp-os/shared/rpc";
import { Button } from "@grasp-os/ui/components/button";
import { Heading } from "@grasp-os/ui/components/heading";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import { loadCoreStatus, signOut } from "../core-connection.ts";
import type { CoreConnection } from "../core-connection.ts";
import { TopError } from "../frame/top-error.tsx";
import {
  isRefused,
  keepWhileSigningIn,
  linkSecret,
  openSession,
} from "../interview/api.ts";
import type { OpenSession } from "../interview/api.ts";
import { Actions, Page as Calm, Words } from "../interview/calm.tsx";
import { jumpOnOpen } from "../interview/dev-jump.tsx";
import { Frame } from "../interview/frame.tsx";
import { holdInterview, releaseInterview } from "../interview/kept.ts";
import { InterviewPage } from "../interview/page.tsx";
import { resumed } from "../interview/progress.ts";
import { fromTheTop, gathering } from "../onboarding/field/poses.ts";
import { signInErrorMessage, signInErrorSearch } from "../sign-in-errors.ts";
import { SignInOptions } from "../sign-in-options.tsx";

// Where someone's own interview link leads (`/interview#<secret>`): their
// interview with Stephen, full screen, outside the app. They sign in with
// their company's sign-in first (GRA-1790): the interview belongs to the
// account whose address the link was sent to, from the first time it opens
// the link, and opens for that account alone. The secret after the `#`,
// which the browser sends nowhere but in the bodies of the link's own
// calls, names which interview; while they are away signing in, this tab
// alone keeps it (api.ts `keepWhileSigningIn`). Anyone else is told the
// link opens nothing, and nothing that was said (core's onboarding/links.ts).

/** What the page shows, and the secret it was opened with. */
type Page =
  | { state: "loading"; secret: string }
  | {
      state: "refused";
      secret: string;
      message: string;
      /**
       * Someone is signed in: core answered, as it does for a link that
       * opens nothing, for whoever asks (`interview.link_invalid`).
       */
      signedIn: boolean;
    }
  | { state: "sign_in"; secret: string; options: SignInOption[] }
  | { state: "open"; secret: string; session: OpenSession };

/**
 * Asks to sign in, keeping `secret` in this tab while they are away; or
 * says the link opens nothing when core can't say how to sign in.
 */
const askToSignIn = async (
  secret: string,
  core: CoreConnection
): Promise<Page> => {
  const { connected, signInOptions } = await loadCoreStatus(core);
  if (!connected) {
    return { state: "refused", secret, message: "", signedIn: false };
  }
  // Kept in this tab while they are away signing in, and taken back as
  // the page opens again (`linkSecret`).
  keepWhileSigningIn(secret);
  // Grasp's staff open nobody's interview: only the company's sign-in.
  return {
    state: "sign_in",
    secret,
    options: signInOptions.filter(({ staff }) => !staff),
  };
};

/**
 * On a local stack only (`vp run dev`): `/interview#dev` opens the link
 * of whoever is signed in, or else noor@acme.test's, as it is now, so one
 * address keeps working however often the onboarding starts over (core's
 * onboarding/dev-reset.ts). The address takes that link's secret, which
 * opens the page again; `?jump=` stays. A build for anywhere else has no
 * such alias: Vite leaves it out, and core has no such route there.
 */
const devAlias = "dev";

/**
 * The secret the alias last led to, in this tab: if even that one is
 * refused, the page says why instead of going round again.
 */
let devGiven: string | null = null;

/**
 * On a local stack, whether a refusal of `secret` goes to the alias
 * instead: a link from before the onboarding started over, one made up,
 * none at all, or one paused, closed or not yet open, all open the
 * interview that works now. Never the alias's own, nor in a build.
 */
const fallsBackToDev = (secret: string): boolean =>
  import.meta.env.DEV &&
  // Tests hold the page to how it is for everyone else.
  import.meta.env.MODE !== "test" &&
  secret !== devAlias &&
  secret !== devGiven;

const openDevAlias = async (core: CoreConnection): Promise<Page> => {
  const response = await fetch(devInterviewLinkPath, { method: "POST" });
  if (response.status === 401) {
    return await askToSignIn(devAlias, core);
  }
  const found: unknown = response.ok ? await response.json() : null;
  const path =
    typeof found === "object" && found !== null && "path" in found
      ? String(found.path)
      : "";
  const [, secret = ""] = path.split("#");
  if (secret === "") {
    return {
      state: "refused",
      secret: devAlias,
      message: "No interview link could be made on this local stack.",
      signedIn: false,
    };
  }
  devGiven = secret;
  window.location.replace(
    `${window.location.pathname}${window.location.search}#${secret}`
  );
  return { state: "loading", secret: devAlias };
};

/** Opens the link for whoever is signed in, or asks them to sign in. */
const opened = async (secret: string, core: CoreConnection): Promise<Page> => {
  if (import.meta.env.DEV && secret === devAlias) {
    return await openDevAlias(core);
  }
  if (secret === "" && fallsBackToDev(secret)) {
    return await openDevAlias(core);
  }
  if (secret === "") {
    return {
      state: "refused",
      secret,
      message: "",
      signedIn: false,
    };
  }
  const answer = await openSession(secret);
  if (isRefused(answer)) {
    if (answer.code !== "interview.sign_in" && fallsBackToDev(secret)) {
      return await openDevAlias(core);
    }
    if (answer.code !== "interview.sign_in") {
      return {
        state: "refused",
        secret,
        message: answer.message,
        signedIn: answer.code === "interview.link_invalid",
      };
    }
    return await askToSignIn(secret, core);
  }
  // Back on the link after stopping, it carries on where it was.
  holdInterview({
    secret,
    kind: answer.kind,
    version: answer.version,
    progress: answer.progress === null ? null : resumed(answer.progress),
  });
  // On a local stack, `?jump=` puts the interview where it asks first.
  await jumpOnOpen(secret);
  return { state: "open", secret, session: answer };
};

/**
 * Why the link opens no interview here, in the interview's own calm frame:
 * the serif title, one line under it, and what they can do about it.
 */
const Notice = ({
  title,
  message,
  failed = false,
  children,
}: {
  title: string;
  message: string;
  /** Core's refusal, with its reference for the person to quote. */
  failed?: boolean;
  /** What they can do about it, under what there is to say. */
  children?: ReactNode;
}) => (
  <Frame pose={fromTheTop}>
    <Calm>
      {/* A refusal is said in the bar at the top, as every error is; the page keeps its title. */}
      <Words line={failed ? undefined : message} title={title} />
      {failed ? <TopError>{message}</TopError> : null}
      {children === undefined ? null : <Actions>{children}</Actions>}
    </Calm>
  </Frame>
);

/** While the link opens: Stephen gathered round the words, in his serif, until the screen it opens takes him on. */
const Loading = () => {
  const { t } = useLingui();
  return (
    <Frame pose={gathering}>
      <Calm>
        <output>
          <Heading level={1} size="lg">
            {t`Opening your conversation…`}
          </Heading>
        </output>
      </Calm>
    </Frame>
  );
};

/**
 * Signs this browser out, and the page loads again, asking who signs in
 * (core-connection.ts `signOut`). A sign-out core didn't carry out leaves
 * the page as it is.
 */
const SignOut = ({ core }: { core: CoreConnection }) => {
  const { t } = useLingui();
  const signingOut = async (): Promise<void> => {
    try {
      await signOut(core);
    } catch {
      // Core didn't sign them out: the page stays as it is.
    }
  };
  return (
    <Button
      onClick={() => {
        void signingOut();
      }}
      variant="outline"
    >
      {t`Sign out`}
    </Button>
  );
};

/**
 * Why a sign-in on the way to an interview was refused: an account the
 * gate doesn't let in is one no link went to (core's auth.ts), so they are
 * told which account to use; anything else as anywhere.
 */
const signInRefusal = (error: string, wrongAccount: string): string =>
  error === "not_open_yet" ? wrongAccount : signInErrorMessage(error);

/**
 * Before the interview: the company's sign-in, and that it is recorded
 * there, said before the button (GRA-1790), in the line under the title.
 */
const SignIn = ({
  options,
  error,
}: {
  options: SignInOption[];
  error: string | undefined;
}) => {
  const { t } = useLingui();
  return (
    <Frame pose={fromTheTop}>
      <Calm>
        <Words
          line={
            // One sentence a line: which account, then that it is recorded.
            <>
              {t`Use the work account your link was sent to.`}
              <br />
              {t`Your company’s sign-in records it, like every sign-in.`}
            </>
          }
          title={t`Sign in to open your conversation`}
        />
        <Actions>
          <TopError>
            {error === undefined
              ? undefined
              : signInRefusal(
                  error,
                  t`That account can't open this interview. Sign in with the work account your link was sent to.`
                )}
          </TopError>
          <SignInOptions
            error={undefined}
            fit
            options={options}
            returnTo={interviewPagePath}
          />
        </Actions>
      </Calm>
    </Frame>
  );
};

const Interview = () => {
  const { t } = useLingui();
  const { core } = Route.useRouteContext();
  const { error } = Route.useSearch();
  // The link's secret, read from the URL once, and again only when its
  // fragment changes: what is shown, and where every call goes, is the
  // interview this opened.
  const [secret, setSecret] = useState(linkSecret);
  const [page, setPage] = useState<Page>({ state: "loading", secret });
  useEffect(() => {
    const changed = (): void => {
      setSecret(linkSecret());
    };
    window.addEventListener("hashchange", changed);
    return () => {
      window.removeEventListener("hashchange", changed);
    };
  }, []);
  useEffect(() => {
    let current = true;
    const load = async (): Promise<void> => {
      const next = await opened(secret, core);
      if (current) {
        setPage(next);
      }
    };
    void load();
    return () => {
      current = false;
      releaseInterview();
    };
  }, [secret, core]);
  // What was opened with another secret is never shown for this one.
  const shown: Page =
    page.secret === secret ? page : { state: "loading", secret };
  switch (shown.state) {
    case "loading": {
      return <Loading />;
    }
    case "refused": {
      return (
        <Notice
          failed
          message={
            shown.message === ""
              ? t`This link doesn't work. Ask whoever sent it for a new one.`
              : shown.message
          }
          title={t`This interview can't be opened`}
        >
          {/* Signed in with another account than the one the link went to:
              a way out to sign in again. The same for a link that never
              was, so it tells nothing about whose this is. */}
          {shown.signedIn ? <SignOut core={core} /> : null}
        </Notice>
      );
    }
    case "sign_in": {
      return <SignIn error={error} options={shown.options} />;
    }
    case "open": {
      return <InterviewPage key={shown.secret} session={shown.session} />;
    }
    default: {
      return shown satisfies never;
    }
  }
};

export const Route = createFileRoute("/interview")({
  validateSearch: (search: Record<string, unknown>): { error?: string } =>
    signInErrorSearch(search),
  component: Interview,
});
