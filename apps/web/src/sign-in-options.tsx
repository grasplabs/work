import type { SignInOption } from "@grasp-os/shared/rpc";
import { Button } from "@grasp-os/ui/components/button";
import { GraspMark } from "@grasp-os/ui/components/grasp-mark";
import { Trans } from "@lingui/react/macro";

import { signIn } from "./core.ts";
import { ErrorText } from "./error-text.tsx";
import { signInErrorMessage } from "./sign-in-errors.ts";

/**
 * Each IdP's mark on its button, by its provider id (core's
 * auth/config.ts), as joingrasp.com's log-in page shows them: Microsoft's
 * and Google's from their own sign-in guidelines (public/logos). Grasp's
 * staff sign in with Grasp's mark.
 */
const providerLogos: Readonly<Record<string, string>> = {
  microsoft: "/logos/microsoft.svg",
  google: "/logos/google.svg",
};

const ProviderMark = ({ providerId }: { providerId: string }) => {
  const logo = providerLogos[providerId];
  return logo === undefined ? (
    <GraspMark className="size-4" data-icon="inline-start" />
  ) : (
    <img alt="" className="size-4" data-icon="inline-start" src={logo} />
  );
};

/**
 * A button for each way to sign in here, in joingrasp.com's log-in style
 * (grasplabs/grasp `apps/marketing/src/pages/login.astro`): one alike for
 * each work account, its mark beside its name. Above them, why the last
 * sign-in was refused, if it was. The IdP sends the person back to
 * `returnTo`.
 */
export const SignInOptions = ({
  options,
  error,
  returnTo,
}: {
  options: SignInOption[];
  error: string | undefined;
  returnTo?: string;
}) => (
  <div className="flex w-full flex-col gap-2.5">
    <ErrorText>
      {error === undefined ? undefined : signInErrorMessage(error)}
    </ErrorText>
    {options.map(({ providerId, label }) => (
      <Button
        className="w-full"
        key={providerId}
        onClick={() => {
          void signIn(providerId, returnTo);
        }}
        size="xl"
        variant="outline"
      >
        <ProviderMark providerId={providerId} />
        <Trans>Continue with {label}</Trans>
      </Button>
    ))}
  </div>
);
