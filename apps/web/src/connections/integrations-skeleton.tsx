import { useLingui } from "@lingui/react/macro";
import { useNavigate, useSearch } from "@tanstack/react-router";

import { Page } from "../frame/page.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { appIntegrationWords } from "../grasp/blocks/app-integration/app-integration.tsx";
import {
  PageSkeletonAppPanel,
  PageSkeletonIntegrations,
} from "../grasp/blocks/page-skeleton-integrations/page-skeleton-integrations.tsx";
import { PageSkeletonRecord } from "../grasp/blocks/page-skeleton-record/page-skeleton-record.tsx";
import { Sheet, SheetContent, SheetTitle } from "../grasp/sheet/index.ts";
import { useWords } from "../grasp/words/words.tsx";

// The Integrations overview before it arrives, as the library's skeleton
// stands it, so nothing moves when it does; with an app's panel waiting
// over it too, when the address opens one (`?app=`).

/** The overview, waiting, and the panel of the app the address names. */
export const IntegrationsSkeleton = () => {
  const { t } = useLingui();
  const words = useWords("appIntegration", appIntegrationWords);
  const { app } = useSearch({ strict: false });
  const navigate = useNavigate({ from: "/integrations/" });
  const close = (): void => {
    void navigate({
      search: (last) => ({ ...last, app: undefined }),
    });
  };
  return (
    <>
      <SiteHeader crumbs={[{ label: t`Integrations` }]} />
      <Page>
        <PageSkeletonIntegrations label={t`Loading integrations`} />
      </Page>
      {app === undefined ? null : (
        <Sheet
          modal={false}
          onOpenChange={(open) => {
            if (!open) {
              close();
            }
          }}
          open
        >
          <SheetContent close="none" initialFocus="content">
            <SheetTitle hidden>{t`Loading the app`}</SheetTitle>
            <PageSkeletonAppPanel
              label={t`Loading the app`}
              onClose={close}
              words={{
                account: words.account,
                mayDo: words.mayDo,
                usedBy: words.usedBy,
                signedInAs: words.signedInAs,
                forWhom: words.forWhom,
              }}
            />
          </SheetContent>
        </Sheet>
      )}
    </>
  );
};

/** An app's own page, waiting: the library's record page, with no panel. */
export const IntegrationSkeleton = () => {
  const { t } = useLingui();
  return (
    <>
      <SiteHeader crumbs={[{ label: t`Integrations`, to: "/integrations" }]} />
      <Page>
        <PageSkeletonRecord descriptionLines={2} icons={false} rows={3} />
      </Page>
    </>
  );
};
