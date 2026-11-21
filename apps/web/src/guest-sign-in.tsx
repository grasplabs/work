import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";
import { z } from "zod";

import type { CoreConnection } from "./core-connection.ts";
import { signOut } from "./core-connection.ts";
import { ErrorText } from "./error-text.tsx";
import { Button } from "./grasp/button/index.ts";
import { Field, FieldLabel } from "./grasp/field/index.ts";
import { Heading } from "./grasp/heading/index.ts";
import { Input } from "./grasp/input/index.ts";
import { Text } from "./grasp/text/index.ts";
import { grasp } from "./grasp/tokens/tokens.stylex.ts";

// A guest's way in (core's auth/guest-codes.ts): someone outside the
// company, invited by address, asks for a code by email and signs in with
// it. Core answers asking alike for every address, so the page says the
// same whoever asks. Once in, a guest sees only that nothing is shared
// with them yet, until something is.

/** What core and Better Auth answer when they refuse. */
const refusalSchema = z.object({ code: z.string() }).loose();

/** What a refused code says, by the code core refuses it with. */
const codeRefusals: Readonly<Record<string, MessageDescriptor>> = {
  // Every refusal of a code alike: core answers them so (routes.ts).
  INVALID_OTP: msg`That code didn't work. Check it, or ask for a new one.`,
  not_open_yet: msg`Grasp isn't open yet. Try again later.`,
  "request.rate_limited": msg`Too many tries. Wait a minute, then try again.`,
};

const fallback = msg`That didn't work. Try again.`;

const styles = stylex.create({
  // The form's fields and buttons, one under the other, the column's width.
  form: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space3,
    width: "100%",
    textAlign: "start",
  },
  page: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: grasp.space4,
    width: "100%",
  },
  words: { display: "flex", flexDirection: "column", gap: grasp.space2 },
});

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

/**
 * Asking for a code by email, then signing in with it; `onBack` goes back
 * to the company's own ways of signing in.
 */
export const GuestCodeSignIn = ({ onBack }: { onBack: () => void }) => {
  const { i18n, t } = useLingui();
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
  return (
    <form
      {...stylex.props(styles.form)}
      onSubmit={(event) => {
        event.preventDefault();
        void (sent ? signIn() : ask());
      }}
    >
      <Field disabled={sent} name="email">
        <FieldLabel>
          <Trans>Your email address</Trans>
        </FieldLabel>
        <Input
          autoComplete="email"
          onValueChange={setEmail}
          required
          type="email"
          value={email}
        />
      </Field>
      {sent ? (
        <>
          <Text tone="muted">
            <Trans>
              If you were invited, a code is on its way to you. It works for
              five minutes.
            </Trans>
          </Text>
          <Field name="code">
            <FieldLabel>
              <Trans>Code</Trans>
            </FieldLabel>
            <Input
              autoComplete="one-time-code"
              inputMode="numeric"
              onValueChange={setCode}
              required
              value={code}
            />
          </Field>
        </>
      ) : null}
      <ErrorText>{failure}</ErrorText>
      <Button disabled={busy} size="lg" type="submit" variant="ink">
        {sent ? t`Sign in` : t`Email me a code`}
      </Button>
      <Button
        disabled={busy}
        onClick={() => {
          setFailure(undefined);
          if (sent) {
            setCode("");
            setSent(false);
          } else {
            onBack();
          }
        }}
        variant="ghost"
      >
        {sent ? t`Ask for a new code` : t`Back`}
      </Button>
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
    <div {...stylex.props(styles.page)}>
      <div {...stylex.props(styles.words)}>
        <Heading level={1}>
          <Trans>Nothing is shared with you yet</Trans>
        </Heading>
        <Text tone="muted">
          <Trans>
            You’re signed in as a guest with {email}. What someone shares with
            you shows here.
          </Trans>
        </Text>
      </div>
      <ErrorText>{failure}</ErrorText>
      <Button
        onClick={() => {
          void leave();
        }}
        variant="quiet"
      >
        {t`Sign out`}
      </Button>
    </div>
  );
};
