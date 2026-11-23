import type { SignInOption } from "@grasp-os/shared/rpc";
import { Button } from "@grasp-os/ui/components/button";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import { leaveToSignIn, signInAddress } from "./core.ts";
import { ErrorText } from "./error-text.tsx";
import { signInErrorMessage } from "./sign-in-errors.ts";
import { useGone } from "./use-gone.ts";

const styles = stylex.create({
  options: {
    display: "flex",
    flexDirection: "column",
    alignItems: "stretch",
    gap: space[2],
    width: "100%",
  },
});

/**
 * A button for each way to sign in here, the first the page's one action,
 * and why the last sign-in was refused, if it was. The IdP sends the
 * person back to `returnTo`.
 */
export const SignInOptions = ({
  options,
  error,
  returnTo,
}: {
  options: SignInOption[];
  error: string | undefined;
  returnTo?: string;
}) => {
  const { t } = useLingui();
  const gone = useGone();
  return (
    <div {...stylex.props(styles.options)}>
      <ErrorText>
        {error === undefined ? undefined : signInErrorMessage(error)}
      </ErrorText>
      {options.map(({ providerId, label }, index) => (
        <Button
          key={providerId}
          // The press works until the page leaves for the IdP; not once
          // the person has moved on from this page.
          onClick={async () => {
            const left = gone();
            const address = await signInAddress(providerId, returnTo);
            if (!left.aborted) {
              leaveToSignIn(address);
            }
          }}
          size="lg"
          variant={index === 0 ? "default" : "outline"}
        >
          {t`Sign in with ${label}`}
        </Button>
      ))}
    </div>
  );
};
