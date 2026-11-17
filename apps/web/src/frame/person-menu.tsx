import { useLingui } from "@lingui/react/macro";

import { signOut } from "../core-connection.ts";
import type { CoreConnection } from "../core-connection.ts";
import { toast } from "../grasp/toast/index.ts";

// The person signed in, as the sidebar's foot shows them
// (grasp/frame/grasp-sidebar.tsx): their initials, and signing out.

const nameParts = /\s+/u;

/**
 * Up to two letters of `name`, for the avatar, as the prototype's
 * (`lib/format.ts`): of the parts written with a capital, so a particle
 * such as "de" or "van" is passed over ("Sanne de Wit" is SW). A name
 * written all in small letters keeps its first two parts.
 */
export const initials = (name: string): string => {
  const parts = name.split(nameParts).filter((part) => part !== "");
  const capitalised = parts.filter((part) => {
    const first = part.charAt(0);
    return first !== first.toLocaleLowerCase();
  });
  return (capitalised.length > 0 ? capitalised : parts)
    .slice(0, 2)
    .map((part) => part.charAt(0).toLocaleUpperCase())
    .join("");
};

/**
 * Signs the person out; a sign-out core didn't carry out is said in a
 * toast, and the page stays.
 */
export const useSignOut = (core: CoreConnection): (() => Promise<void>) => {
  const { t } = useLingui();
  return async () => {
    try {
      await signOut(core);
    } catch {
      toast.error({
        title: t`Signing out didn't work`,
        description: t`You're still signed in. Try again in a moment.`,
      });
    }
  };
};
