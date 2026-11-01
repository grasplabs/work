import { GraspMark } from "@grasp-os/ui/components/grasp-mark";
import { PageHeaderTitle } from "@grasp-os/ui/components/page-header";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { ErrorText } from "../error-text.tsx";
import {
  isRefused,
  keepKey,
  keptKey,
  linkSecret,
  openSession,
} from "../interview/api.ts";
import type { OpenSession } from "../interview/api.ts";
import { holdInterview, releaseInterview } from "../interview/kept.ts";
import { InterviewPage } from "../interview/page.tsx";
import { resumed } from "../interview/progress.ts";

// Where someone's own interview link leads (`/interview#<secret>`): their
// interview with Stephen, full screen, outside the app. No sign-in, no
// session: the secret after the `#`, which the browser sends nowhere but in
// the bodies of the link's own calls, and the key this device was given the
// first time it opened the link, are all the page has. Another device
// holding the link is told the interview is open elsewhere, and nothing
// that was said (core's onboarding/links.ts).

/** What the page shows, and the secret it was opened with. */
type Page =
  | { state: "loading"; secret: string }
  | { state: "refused"; secret: string; message: string }
  | { state: "elsewhere"; secret: string }
  | { state: "open"; secret: string; session: OpenSession };

/** Opens the link on this device: the device's key is kept the one time it is given. */
const opened = async (secret: string): Promise<Page> => {
  if (secret === "") {
    return {
      state: "refused",
      secret,
      message: "",
    };
  }
  const kept = await keptKey(secret);
  const answer = await openSession(secret, kept);
  if (isRefused(answer)) {
    return { state: "refused", secret, message: answer.message };
  }
  if (answer.state === "elsewhere") {
    return { state: "elsewhere", secret };
  }
  const key = answer.key ?? kept;
  if (key === undefined) {
    return { state: "elsewhere", secret };
  }
  if (answer.key !== undefined) {
    await keepKey(secret, answer.key);
  }
  // Back on the link after stopping, it carries on where it was.
  holdInterview({
    secret,
    key,
    version: answer.version,
    progress: answer.progress === null ? null : resumed(answer.progress),
  });
  return { state: "open", secret, session: answer };
};

/**
 * Why the link opens no interview here, laid out as calm as the prototype's
 * (`routes/i/$code.tsx`): the mark, and what there is to say.
 */
const Notice = ({
  title,
  children,
  failed = false,
}: {
  title: string;
  children: string;
  /** Core's refusal, with its reference for the person to quote. */
  failed?: boolean;
}) => (
  <main className="bg-background flex min-h-svh flex-col items-center justify-center gap-6 px-4 text-center text-sm">
    <GraspMark className="size-6" />
    <div className="flex max-w-sm flex-col items-center gap-3">
      <PageHeaderTitle>{title}</PageHeaderTitle>
      {failed ? (
        <ErrorText>{children}</ErrorText>
      ) : (
        <p className="text-muted-foreground text-balance">{children}</p>
      )}
    </div>
  </main>
);

const Loading = () => {
  const { t } = useLingui();
  return (
    <main className="bg-background flex min-h-svh flex-col items-center justify-center gap-6 px-4 text-center text-sm">
      <GraspMark className="size-6" />
      <output className="text-muted-foreground">{t`Opening your interview…`}</output>
    </main>
  );
};

const Interview = () => {
  const { t } = useLingui();
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
      const next = await opened(secret);
      if (current) {
        setPage(next);
      }
    };
    void load();
    return () => {
      current = false;
      releaseInterview();
    };
  }, [secret]);
  // What was opened with another secret is never shown for this one.
  const shown: Page =
    page.secret === secret ? page : { state: "loading", secret };
  switch (shown.state) {
    case "loading": {
      return <Loading />;
    }
    case "refused": {
      return (
        <Notice failed title={t`This interview can't be opened`}>
          {shown.message === ""
            ? t`This link doesn't work. Ask whoever sent it for a new one.`
            : shown.message}
        </Notice>
      );
    }
    case "elsewhere": {
      return (
        <Notice title={t`This interview is open on another device`}>
          {t`Carry on there. Lost that device? Ask whoever sent you the link for a new start.`}
        </Notice>
      );
    }
    case "open": {
      return <InterviewPage key={shown.secret} session={shown.session} />;
    }
    default: {
      return shown satisfies never;
    }
  }
};

export const Route = createFileRoute("/interview")({ component: Interview });
