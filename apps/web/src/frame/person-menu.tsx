import { useLingui } from "@lingui/react/macro";

import { signOut } from "../core-connection.ts";
import type { CoreConnection } from "../core-connection.ts";
import { toast } from "../grasp/toast/index.ts";
import { closePhoneMenu } from "./phone-menu.ts";

// The person signed in, as the sidebar's foot shows them
// (grasp/frame/grasp-sidebar.tsx): signing out.

/**
 * Signs the person out; a sign-out core didn't carry out is said in a
 * toast, and the page stays.
 */
export const useSignOut = (core: CoreConnection): (() => Promise<void>) => {
  const { t } = useLingui();
  return async () => {
    try {
      closePhoneMenu();
      await signOut(core);
    } catch {
      toast.error({
        title: t`Signing out didn't work`,
        description: t`You're still signed in. Try again in a moment.`,
      });
    }
  };
};
