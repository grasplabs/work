import { failureText } from "@grasp-os/shared/errors";
import {
  organizationLogoMaxBytes,
  organizationLogoTypes,
} from "@grasp-os/shared/organization";
import type { Organization } from "@grasp-os/shared/organization";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";

import type { Session } from "../core.ts";
import { formatBytes } from "../format.ts";
import { organizationLogoChanged } from "../frame/organization-name.tsx";
import type { SettingRowState } from "../grasp/setting-row/index.ts";
import { toast } from "../grasp/toast/index.ts";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";

// Settings › Workspace's own changes: a change to the organization, saved
// as it is made, its row saying how its save stands (saving, saved, or
// failed with Try again), and the page read again behind it. A field is
// held only while its own save runs, never while the page reads again, so
// it can be changed again at once.

type Change = (
  organization: Session["organization"]
) => Promise<Organization | undefined>;

export const controlStyles = stylex.create({
  // Every control fills the rows' shared control column.
  fill: { width: "100%" },
});

/**
 * Makes a change to the organization: its failure and how its save
 * stands are its own, and `busy` only while the save runs. `onSaved` hears
 * the organization as core saved it; the page reads again behind it.
 */
export const useOrganizationChange = () => {
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const [status, setStatus] = useState<SettingRowState>("idle");
  const change = (
    update: Change,
    onSaved?: (organization: Organization) => void
  ): void => {
    setStatus("saving");
    void (async () => {
      const saved = await run(
        async (session) => await update(session.organization)
      );
      if (saved === undefined) {
        setStatus("failed");
        return;
      }
      setStatus("saved");
      onSaved?.(saved);
      // The page reads again behind the field, which stays free meanwhile.
      void router.invalidate();
    })();
  };
  return {
    busy,
    failure,
    status,
    change,
    /** A new value typed or picked: the last save's word goes. */
    idle: () => {
      setStatus("idle");
    },
  };
};

/** The words a row says of its save, translated. */
export const useSaveWords = () => {
  const { t } = useLingui();
  return {
    failedLabel: t`Could not save. Your change is kept.`,
    retryLabel: t`Try again`,
    savedLabel: t`Saved`,
    savingLabel: t`Saving`,
  };
};

/** The logo's limits, in words, for the well's tooltip. */
const useLogoHint = (): string => {
  const { t } = useLingui();
  const most = formatBytes(organizationLogoMaxBytes);
  return t`PNG, JPEG or WebP, up to ${most}.`;
};

/** Sets the removed logo again, or says it could not. */
const putBack = async (
  image: Uint8Array,
  setLogo: (image: Uint8Array) => Promise<void>,
  failed: string
): Promise<void> => {
  try {
    await setLogo(image);
  } catch {
    toast.error(failed);
  }
};

/**
 * Removes the logo at once and offers Undo in a toast, as the library's
 * Confirmations pattern has an undoable removal: the picture's bytes are
 * read first and kept only for the toast's lifetime, and Undo sets them
 * again through the same call as choosing a logo. Outside the component,
 * as the React Compiler can't compile `try`.
 */
const removeWithUndo = async (
  address: string,
  removeLogo: () => Promise<void>,
  setLogo: (image: Uint8Array) => Promise<void>,
  words: { done: string; failed: string; undo: string; undoFailed: string }
): Promise<void> => {
  let image: Uint8Array;
  try {
    const response = await fetch(address);
    if (!response.ok) {
      throw new Error(`The logo could not be read: ${String(response.status)}`);
    }
    image = new Uint8Array(await response.arrayBuffer());
    await removeLogo();
  } catch {
    toast.error(words.failed);
    return;
  }
  toast.success(words.done, {
    action: {
      label: words.undo,
      onAction: () => {
        void putBack(image, setLogo, words.undoFailed);
      },
    },
  });
};

/**
 * The organization's logo, for the library's image well on its card. A
 * press or a dropped image saves it at once (PNG, JPEG or WebP, at most
 * 512 KB, which core checks again by its bytes); the well shows the save,
 * and a failure with Try again. Remove takes it away at once, with Undo in
 * a toast. The sidebar shows the new one at once.
 */
export const useOrganizationLogo = (logo: string | null) => {
  const { t } = useLingui();
  const core = useCore();
  const router = useRouter();
  const hint = useLogoHint();
  const most = formatBytes(organizationLogoMaxBytes);
  // What core last took: the page's read catches up behind it.
  const [saved, setSaved] = useState(logo);
  const kept = (organization: Organization): void => {
    setSaved(organization.logo);
    organizationLogoChanged(organization.logo);
    void router.invalidate();
  };
  const upload = async (file: File): Promise<string | undefined> => {
    const image = new Uint8Array(await file.arrayBuffer());
    let organization: Organization;
    try {
      organization = await core.withSession(
        async (session) => await session.organization.setLogo(image)
      );
    } catch (error) {
      // Core's own words for why (an image it can't read, too large or too
      // wide): the well alone says only that it wasn't saved.
      toast.error(failureText(error));
      throw error;
    }
    kept(organization);
    return organization.logo ?? undefined;
  };
  const setLogo = async (image: Uint8Array): Promise<void> => {
    kept(
      await core.withSession(
        async (session) => await session.organization.setLogo(image)
      )
    );
  };
  const remove = async (address: string): Promise<void> => {
    await removeWithUndo(
      address,
      async () => {
        kept(
          await core.withSession(
            async (session) => await session.organization.removeLogo()
          )
        );
      },
      setLogo,
      {
        done: t`Logo removed`,
        failed: t`The logo could not be removed`,
        undo: t`Undo`,
        undoFailed: t`The logo could not be put back`,
      }
    );
  };
  return {
    accept: organizationLogoTypes,
    hint,
    maxSize: organizationLogoMaxBytes,
    onValueChange: (value: string | null): void => {
      if (value === null && saved !== null) {
        void remove(saved);
      }
    },
    upload,
    value: saved,
    words: {
      change: t`Change the logo`,
      add: t`Add a logo`,
      remove: t`Remove the logo`,
      saving: t`Saving`,
      saved: t`Saved`,
      failed: t`Not saved`,
      retry: t`Try again`,
      how: t`Click or drop a picture.`,
      refused: (file: string, reason: string) =>
        reason === "file-too-large"
          ? t`${file} is too large.`
          : t`${file} is not a kind of picture this takes.`,
      // The card's own line, under the name: short, with the limit.
      refusedInRow: (reason: string) =>
        reason === "file-too-large"
          ? t`Too large: at most ${most}`
          : t`Not a PNG, JPEG or WebP picture`,
    },
  };
};
