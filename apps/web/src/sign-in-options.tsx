import type { SignInOption } from "@grasp-os/shared/rpc";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import { signIn } from "./core.ts";
import { ErrorText } from "./error-text.tsx";
import { Button } from "./grasp/button/index.ts";
import { grasp } from "./grasp/tokens/tokens.stylex.ts";
import { signInErrorMessage } from "./sign-in-errors.ts";

const styles = stylex.create({
  options: {
    display: "flex",
    flexDirection: "column",
    alignItems: "stretch",
    gap: grasp.space2,
    width: "100%",
  },
  wide: { width: "100%" },
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
  return (
    <div {...stylex.props(styles.options)}>
      <ErrorText>
        {error === undefined ? undefined : signInErrorMessage(error)}
      </ErrorText>
      {options.map(({ providerId, label }, index) => (
        <Button
          key={providerId}
          layout={styles.wide}
          onClick={() => {
            void signIn(providerId, returnTo);
          }}
          size="lg"
          variant={index === 0 ? "ink" : "quiet"}
        >
          {t`Sign in with ${label}`}
        </Button>
      ))}
    </div>
  );
};
