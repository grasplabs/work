import type { ModelEfforts } from "@grasp-os/shared/models";
import { Trans, useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";

import { GraspBuddy } from "../buddy/grasp-buddy.tsx";
import { Composer } from "../chat/composer.tsx";
import { useAsk } from "../chat/use-ask.ts";

// Making a new app (grasplabs/prototype `components/apps/apps-home.tsx`):
// Grasp's buddy and the question "What should the app show, and for whom?",
// centred, over the box to answer in. The answer starts an ordinary chat,
// which opens at its own address; its agent builds the app there, in the
// chat's studio. Below it, other ways to start (`children`), such as from
// a blueprint.

export const NewApp = ({
  models,
  efforts,
  children,
}: {
  models: string[];
  efforts: Record<string, ModelEfforts>;
  children?: ReactNode;
}) => {
  const { t } = useLingui();
  const { composer } = useAsk(undefined, models, efforts, "page");
  return (
    <section
      aria-labelledby="new-app"
      className="flex min-w-0 flex-1 flex-col overflow-y-auto"
    >
      <div className="flex min-h-full items-center justify-center px-6 py-12">
        <div className="flex w-full max-w-3xl flex-col gap-8 pb-10">
          <div className="flex flex-col items-center gap-6 text-center">
            <GraspBuddy />
            <h1
              className="text-2xl font-medium tracking-tight text-balance"
              id="new-app"
            >
              <Trans>What should the app show, and for whom?</Trans>
            </h1>
          </div>
          <Composer
            placeholder={t`Describe the app: what it shows, and for whom`}
            running={false}
            {...composer}
          />
          {children}
        </div>
      </div>
    </section>
  );
};
