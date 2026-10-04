import { guestMessageMaxLength } from "@grasp-os/shared/guests";
import type { GuestView } from "@grasp-os/shared/guests";
import { Button } from "@grasp-os/ui/components/button";
import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { GraspBuddy } from "../buddy/grasp-buddy.tsx";
import { Composer } from "../chat/composer.tsx";
import { GraspEyes } from "../chat/grasp-eyes.tsx";
import { ErrorText } from "../error-text.tsx";
import { formatDateTime } from "../format.ts";
import { OnboardingFrame } from "../frame/onboarding-frame.tsx";
import { guestCall, linkSecret } from "../guest/api.ts";

// Where a guest link leads (`/guest#<secret>`): someone who isn't a member,
// invited to a short chat about their work. No sign-in, no session: the
// secret after the `#`, which the browser never sends anywhere but in the
// requests below, is all the page has, and all it can do is this chat.
// What the model answers is shown as plain text.

/** What the page shows, and the link's secret it was opened with. */
type Page =
  | { state: "loading"; secret: string }
  | { state: "refused"; secret: string; message: string }
  | { state: "ready"; secret: string; view: GuestView };

/** What the chat says once it can take no more. */
const endedText = (view: GuestView): string | undefined => {
  switch (view.status) {
    case "finished": {
      return i18n._(msg`You finished this chat. Thank you for your time.`);
    }
    case "revoked": {
      return i18n._(
        msg`This chat has been closed by whoever sent you the link.`
      );
    }
    case "expired": {
      return i18n._(
        msg`This link has expired. Ask whoever sent it for a new one.`
      );
    }
    case "open": {
      return view.turnsLeft === 0
        ? i18n._(msg`This chat has reached its length. Press Finish to end it.`)
        : undefined;
    }
    default: {
      return view.status satisfies never;
    }
  }
};

/**
 * The messages so far in the chat's look (chat/thread.tsx): theirs on the
 * right, the answers beside Grasp's eyes, as plain text, never Markdown.
 */
const Messages = ({
  view,
  reading,
}: {
  view: GuestView;
  /** Whether a message is on its way, to be answered. */
  reading: boolean;
}) => {
  const { t } = useLingui();
  const last = view.messages.at(-1);
  return (
    <ol aria-label={t`Messages`} className="flex w-full flex-col gap-8">
      {view.messages.map((message) =>
        message.role === "guest" ? (
          <li
            className="bg-secondary text-foreground ml-auto w-fit max-w-11/12 rounded-lg px-4 py-3 whitespace-pre-wrap"
            key={`${message.at}-${message.role}`}
          >
            <span className="sr-only">{t`You:`} </span>
            {message.text}
          </li>
        ) : (
          <li
            className="flex items-start gap-3"
            key={`${message.at}-${message.role}`}
          >
            <GraspEyes live={message === last} state="idle" />
            <p className="min-w-0 flex-1 whitespace-pre-wrap">
              <span className="sr-only">Grasp: </span>
              {message.text}
            </p>
          </li>
        )
      )}
      {reading ? (
        <li aria-busy="true" className="flex items-start gap-3">
          <GraspEyes live state="thinking" />
          <output className="shimmer-text">{t`Reading what you wrote`}</output>
        </li>
      ) : null}
    </ol>
  );
};

/**
 * The chat `secret` opened, open for the guest's next message until it
 * ends. Every message and the finish go with that same secret, never
 * with whatever the URL holds by then.
 */
const Chat = ({ secret, first }: { secret: string; first: GuestView }) => {
  const [view, setView] = useState(first);
  const [text, setText] = useState("");
  // What is on its way to core: a message, or the finish.
  const [pending, setPending] = useState<"send" | "finish">();
  const [failure, setFailure] = useState<string | undefined>();
  const ended = endedText(view);
  const open = view.status === "open";
  const { t } = useLingui();
  const { name } = view;
  const until = formatDateTime(view.expiresAt);

  const call = async (
    request: { action: "send"; text: string } | { action: "finish" }
  ): Promise<boolean> => {
    setPending(request.action);
    const answer = await guestCall({ ...request, token: secret });
    setPending(undefined);
    if ("error" in answer) {
      setFailure(answer.error);
      return false;
    }
    setFailure(undefined);
    setView(answer.ok);
    return true;
  };

  return (
    <>
      <GraspBuddy />
      <div className="flex flex-col gap-2 text-center">
        <h1 className="text-2xl font-medium tracking-tight text-balance">
          <Trans>Hi {name}</Trans>
        </h1>
        <p className="text-muted-foreground text-balance">
          <Trans>
            This chat asks how your work is done. Everything you write is kept
            and read by the people who invited you, who may copy it into their
            own records and keep it there. Please don&apos;t share passwords,
            bank details or anything you wouldn&apos;t put in an email.
          </Trans>
          {open ? ` ${t`The link works until ${until}.`}` : ""}
        </p>
      </div>
      <Messages reading={pending === "send"} view={view} />
      {ended === undefined ? null : (
        <output className="text-muted-foreground self-start">{ended}</output>
      )}
      {open ? (
        <div className="flex w-full flex-col gap-2">
          {view.turnsLeft > 0 ? (
            <Composer
              busy={pending === "send"}
              // Not while the chat is being finished.
              disabled={pending === "finish"}
              failure={failure}
              label={t`Your message`}
              maxLength={guestMessageMaxLength}
              onSend={() => {
                void (async () => {
                  if (await call({ action: "send", text })) {
                    setText("");
                  }
                })();
              }}
              onText={setText}
              placeholder={t`Write your answer`}
              running={false}
              text={text}
            />
          ) : (
            <ErrorText>{failure}</ErrorText>
          )}
          <Button
            className="self-end"
            disabled={pending !== undefined}
            onClick={() => {
              void call({ action: "finish" });
            }}
            variant="outline"
          >
            <Trans>Finish</Trans>
          </Button>
        </div>
      ) : null}
    </>
  );
};

const Guest = () => {
  // The link's secret, read from the URL once, and again only when the
  // URL's fragment changes (another link pasted over this one): the chat
  // shown, and the one every message goes to, are the one this opened.
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
      const answer =
        secret === ""
          ? {
              error: i18n._(
                msg`This link doesn't work. Ask whoever sent it for a new one.`
              ),
            }
          : await guestCall({ action: "open", token: secret });
      if (!current) {
        return;
      }
      setPage(
        "error" in answer
          ? { state: "refused", secret, message: answer.error }
          : { state: "ready", secret, view: answer.ok }
      );
    };
    void load();
    return () => {
      current = false;
    };
  }, [secret]);
  // What was opened with another secret is never shown for this one.
  const shown: Page =
    page.secret === secret ? page : { state: "loading", secret };
  return (
    <OnboardingFrame wide>
      {shown.state === "loading" ? (
        <>
          <GraspBuddy />
          <output className="text-muted-foreground">
            <Trans>Opening the chat…</Trans>
          </output>
        </>
      ) : null}
      {shown.state === "refused" ? (
        <>
          <GraspBuddy />
          <div className="flex flex-col items-center gap-2 text-center">
            <h1 className="text-2xl font-medium tracking-tight">
              <Trans>This chat can&apos;t be opened</Trans>
            </h1>
            <ErrorText>{shown.message}</ErrorText>
          </div>
        </>
      ) : null}
      {shown.state === "ready" ? (
        <Chat key={shown.secret} secret={shown.secret} first={shown.view} />
      ) : null}
    </OnboardingFrame>
  );
};

export const Route = createFileRoute("/guest")({ component: Guest });
