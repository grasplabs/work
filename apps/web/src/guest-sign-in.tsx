import { Button } from "@grasp-os/ui/components/button";
import { Field, FieldLabel } from "@grasp-os/ui/components/field";
import { Input } from "@grasp-os/ui/components/input";
import { PageHeaderTitle } from "@grasp-os/ui/components/page-header";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useId, useState } from "react";
import { z } from "zod";

import type { CoreConnection } from "./core-connection.ts";
import { signOut } from "./core-connection.ts";
import { ErrorText } from "./error-text.tsx";

// A guest's way in (core's auth/guest-codes.ts): someone outside the
// company, invited by address, asks for a code by email and signs in with
// it. Core answers asking alike for every address, so the page says the
// same whoever asks. Once in, a guest sees only that nothing is shared
// with them yet, until something is.

/** What core and Better Auth answer when they refuse. */
const refusalSchema = z.object({ code: z.string() }).loose();

/** What a refused code says, by the code Better Auth refuses it with. */
const codeRefusals: Readonly<Record<string, MessageDescriptor>> = {
  INVALID_OTP: msg`That code isn't right, or it was used up. Ask for a new one.`,
  TOO_MANY_ATTEMPTS: msg`That code was tried too often. Ask for a new one.`,
  OTP_EXPIRED: msg`That code ran out. Ask for a new one.`,
  not_open_yet: msg`Grasp isn't open yet. Try again later.`,
  "request.rate_limited": msg`Too many tries. Wait a minute, then try again.`,
};

const fallback = msg`That didn't work. Try again.`;

/** Posts `body` to core's sign-in route `path`: null when it went, else why not. */
const post = async (path: string, body: unknown): Promise<string | null> => {
  try {
    const response = await fetch(`/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.ok) {
      return null;
    }
    const refused = refusalSchema.safeParse(
      await response.json().catch(() => null)
    );
    return refused.success ? refused.data.code : "";
  } catch {
    return "";
  }
};

/** Asking for a code by email, then signing in with it. */
export const GuestCodeSignIn = () => {
  const { i18n, t } = useLingui();
  const emailId = useId();
  const codeId = useId();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | undefined>();
  const say = (refusal: string): string =>
    i18n._(codeRefusals[refusal] ?? fallback);
  const ask = async (): Promise<void> => {
    setBusy(true);
    setFailure(undefined);
    const refusal = await post("/email-otp/send-verification-otp", {
      email: email.trim(),
      type: "sign-in",
    });
    setBusy(false);
    if (refusal === null) {
      setSent(true);
    } else {
      setFailure(say(refusal));
    }
  };
  const signIn = async (): Promise<void> => {
    setBusy(true);
    setFailure(undefined);
    const refusal = await post("/sign-in/email-otp", {
      email: email.trim(),
      otp: code.replaceAll(/\s/gu, ""),
    });
    if (refusal === null) {
      // Loaded again, signed in: the start page sends a guest here, to
      // what is shared with them.
      window.location.assign("/");
      return;
    }
    setBusy(false);
    setFailure(say(refusal));
  };
  if (!open) {
    return (
      <Button
        className="w-full"
        onClick={() => {
          setOpen(true);
        }}
        variant="ghost"
      >
        <Trans>Invited as a guest? Sign in with a code</Trans>
      </Button>
    );
  }
  return (
    <form
      className="flex w-full flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void (sent ? signIn() : ask());
      }}
    >
      <Field>
        <FieldLabel htmlFor={emailId}>
          <Trans>Your email address</Trans>
        </FieldLabel>
        <Input
          autoComplete="email"
          disabled={sent}
          id={emailId}
          onChange={(event) => {
            setEmail(event.target.value);
          }}
          required
          type="email"
          value={email}
        />
      </Field>
      {sent ? (
        <>
          <p className="text-muted-foreground text-balance">
            <Trans>
              If you were invited, a code is on its way to you. It works for
              five minutes.
            </Trans>
          </p>
          <Field>
            <FieldLabel htmlFor={codeId}>
              <Trans>Code</Trans>
            </FieldLabel>
            <Input
              autoComplete="one-time-code"
              id={codeId}
              inputMode="numeric"
              onChange={(event) => {
                setCode(event.target.value);
              }}
              required
              value={code}
            />
          </Field>
        </>
      ) : null}
      <ErrorText>{failure}</ErrorText>
      <Button disabled={busy} size="xl" type="submit">
        {sent ? t`Sign in` : t`Email me a code`}
      </Button>
      {sent ? (
        <Button
          disabled={busy}
          onClick={() => {
            setCode("");
            setSent(false);
            setFailure(undefined);
          }}
          variant="ghost"
        >
          <Trans>Ask for a new code</Trans>
        </Button>
      ) : null}
    </form>
  );
};

/** A guest, signed in, with nothing shared with them yet. */
export const NothingShared = ({
  core,
  email,
}: {
  core: CoreConnection;
  email: string;
}) => {
  const { t } = useLingui();
  const [failure, setFailure] = useState<string | undefined>();
  const leave = async (): Promise<void> => {
    try {
      await signOut(core);
    } catch {
      setFailure(t`Signing out didn't work. Try again.`);
    }
  };
  return (
    <div className="flex w-full flex-col items-center gap-4">
      <div className="flex flex-col gap-2">
        <PageHeaderTitle>
          <Trans>Nothing is shared with you yet</Trans>
        </PageHeaderTitle>
        <p className="text-muted-foreground text-balance">
          <Trans>
            You’re signed in as a guest with {email}. What someone shares with
            you shows here.
          </Trans>
        </p>
      </div>
      <ErrorText>{failure}</ErrorText>
      <Button
        onClick={() => {
          void leave();
        }}
        variant="outline"
      >
        <Trans>Sign out</Trans>
      </Button>
    </div>
  );
};
