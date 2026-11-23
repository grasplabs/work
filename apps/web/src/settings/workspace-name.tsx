import { failureText } from "@grasp-os/shared/errors";
import {
  organizationLogoMaxBytes,
  organizationLogoTypes,
} from "@grasp-os/shared/organization";
import type { Organization } from "@grasp-os/shared/organization";
import type { FieldStatusValue } from "@grasp-os/ui/components/field";
import { useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";

import type { Session } from "../core.ts";
import { formatBytes } from "../format.ts";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";

// Settings › Workspace's own changes: a change to the organization, saved
// as it is made, its row saying how its save stands (saving, saved, or
// failed with Try again), and the page read again behind it. A field is
// held only while its own save runs, never while the page reads again, so
// it can be changed again at once. And the organization's logo, saved as
// it is chosen.

type Change = (
  organization: Session["organization"]
) => Promise<Organization | undefined>;

/**
 * Makes a change to the organization: its failure and how its save
 * stands are its own, and `busy` only while the save runs. `onSaved` hears
 * the organization as core saved it; the page reads again behind it.
 */
export const useOrganizationChange = () => {
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const [status, setStatus] = useState<FieldStatusValue>("idle");
  const change = (
    update: Change,
    onSaved?: (organization: Organization) => void
  ): void => {
    setStatus("loading");
    void (async () => {
      const saved = await run(
        async (session) => await update(session.organization)
      );
      if (saved === undefined) {
        setStatus("error");
        return;
      }
      setStatus("success");
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

/**
 * The organization's logo, for Damsko's image well on its card. A press
 * or a dropped image saves it at once (PNG, JPEG or WebP, at most 512 KB,
 * which core checks again by its bytes); the well shows the save, and a
 * failure with Try again, and `problem` says core's reason under the card.
 * Remove takes it away at once.
 */
export const useOrganizationLogo = (logo: string | null) => {
  const { t } = useLingui();
  const core = useCore();
  const router = useRouter();
  const most = formatBytes(organizationLogoMaxBytes);
  // What core last took: the page's read catches up behind it.
  const [saved, setSaved] = useState(logo);
  // Core's own words for why a logo wasn't kept, for the line under the card.
  const [problem, setProblem] = useState<string>();
  const kept = (organization: Organization): void => {
    setSaved(organization.logo);
    setProblem(undefined);
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
      // An image core can't read, too large or too wide: the well alone
      // says only that it wasn't saved.
      setProblem(failureText(error));
      throw error;
    }
    kept(organization);
    return organization.logo ?? undefined;
  };
  const remove = async (): Promise<void> => {
    try {
      kept(
        await core.withSession(
          async (session) => await session.organization.removeLogo()
        )
      );
    } catch {
      setProblem(t`The logo could not be removed`);
    }
  };
  return {
    problem,
    well: {
      accept: organizationLogoTypes,
      description: t`PNG, JPEG or WebP, up to ${most}.`,
      maxFileSize: organizationLogoMaxBytes,
      onUpload: upload,
      onValueChange: (value: string | null): void => {
        if (value === null && saved !== null) {
          void remove();
        }
      },
      value: saved,
    },
  };
};
