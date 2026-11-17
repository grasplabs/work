import {
  organizationLogoMaxBytes,
  organizationLogoTypes,
} from "@grasp-os/shared/organization";
import type { Organization } from "@grasp-os/shared/organization";
import { toast } from "@grasp-os/ui/components/toast";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";

import type { Session } from "../core.ts";
import { formatBytes } from "../format.ts";
import {
  organizationLogoChanged,
  organizationRenamed,
} from "../frame/organization-name.tsx";
import { ImageWell } from "../grasp/file-upload/index.ts";
import { Input } from "../grasp/input/index.ts";
import { SettingRow } from "../grasp/setting-row/index.ts";
import type { SettingRowState } from "../grasp/setting-row/index.ts";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";

// Settings › Workspace's own fields: a change to the organization, saved
// as it is made, the row saying how its save stands (saving, saved, or
// failed with Try again), and the page read again behind it. A field is
// held only while its own save runs, never while the page reads again, so
// it can be changed again at once. The name tells the sidebar the moment
// core saved it (frame/organization-name.tsx), so it never shows the name
// just replaced.

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

/** The organization's name, as a setting's row: saved when the field is left, or on Enter; Escape puts it back. */
export const NameField = ({
  name,
  canChange,
}: {
  name: string;
  canChange: boolean;
}) => {
  const { t } = useLingui();
  const words = useSaveWords();
  const { busy, failure, status, change, idle } = useOrganizationChange();
  const [draft, setDraft] = useState<string | null>(null);
  // What core last took: the page's read catches up behind it.
  const [saved, setSaved] = useState(name);
  // The name a failed save tried, kept for Try again.
  const [tried, setTried] = useState<string>();
  const send = (next: string): void => {
    setTried(next);
    change(
      async (api) => await api.update({ name: next }),
      (organization) => {
        setSaved(organization.name);
        setTried(undefined);
        organizationRenamed(organization.name);
      }
    );
  };
  const save = (): void => {
    const next = draft?.trim();
    // A failed save keeps what was typed in the field, as the row says.
    if (status !== "failed") {
      setDraft(null);
    }
    if (next !== undefined && next !== "" && next !== saved) {
      send(next);
    }
  };
  return (
    <SettingRow
      {...words}
      {...(failure === undefined ? {} : { error: failure })}
      {...(canChange ? {} : { info: t`An admin changes it.` })}
      label={t`Name`}
      onRetry={() => {
        if (tried !== undefined) {
          send(tried);
        }
      }}
      status={status}
    >
      {(field) => (
        <Input
          {...field}
          layout={controlStyles.fill}
          maxLength={80}
          onBlur={save}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.currentTarget.blur();
            }
            if (event.key === "Escape") {
              setDraft(null);
              idle();
            }
          }}
          onValueChange={(value) => {
            setDraft(value);
            idle();
          }}
          // Read-only while its save runs, not disabled: a disabled field drops the keyboard's focus.
          readOnly={!canChange || busy}
          size="sm"
          value={draft ?? saved}
        />
      )}
    </SettingRow>
  );
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
    toast.add({ type: "error", title: failed });
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
    toast.add({ type: "error", title: words.failed });
    return;
  }
  toast.add({
    type: "success",
    title: words.done,
    actionProps: {
      children: words.undo,
      onClick: () => {
        void putBack(image, setLogo, words.undoFailed);
      },
    },
  });
};

/**
 * The organization's logo, as a row of the Organization card: the library's
 * image well, itself the control. A press or a dropped image saves it at
 * once (PNG, JPEG or WebP, at most 512 KB, which core checks again by its
 * bytes); the well shows the save, and a failure with Try again. Remove
 * takes it away at once, with Undo in a toast. The sidebar shows the new one at once.
 */
export const LogoField = ({
  name,
  logo,
  canChange,
}: {
  name: string;
  logo: string | null;
  canChange: boolean;
}) => {
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
    const organization = await core.withSession(
      async (session) => await session.organization.setLogo(image)
    );
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
  return (
    <SettingRow label={t`Logo`}>
      {(field) => (
        <ImageWell
          {...field}
          accept={organizationLogoTypes}
          disabled={!canChange}
          fit="contain"
          hint={hint}
          initials={name}
          maxSize={organizationLogoMaxBytes}
          onValueChange={(value) => {
            if (value === null && saved !== null) {
              void remove(saved);
            }
          }}
          upload={upload}
          value={saved}
          words={{
            change: t`Change the logo`,
            add: t`Add a logo`,
            remove: t`Remove the logo`,
            saving: t`Saving`,
            saved: t`Saved`,
            failed: t`Could not save`,
            retry: t`Try again`,
            how: t`Click or drop a picture.`,
            // One short line under the well, with the limit in it: the
            // file's own name only makes the line wrap.
            refused: (_file, reason) =>
              reason === "file-too-large"
                ? t`Too large: at most ${most}`
                : t`Not a PNG, JPEG or WebP picture`,
          }}
        />
      )}
    </SettingRow>
  );
};
