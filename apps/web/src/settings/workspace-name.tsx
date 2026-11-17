import type { Organization } from "@grasp-os/shared/organization";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";

import type { Session } from "../core.ts";
import { organizationRenamed } from "../frame/organization-name.tsx";
import { Input } from "../grasp/input/index.ts";
import { SettingRow } from "../grasp/setting-row/index.ts";
import type { SettingRowState } from "../grasp/setting-row/index.ts";
import { useCoreAction } from "../use-core-action.ts";

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
      help={
        canChange
          ? t`Your company’s name in Grasp.`
          : t`Your company’s name in Grasp. An admin changes it.`
      }
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
          value={draft ?? saved}
        />
      )}
    </SettingRow>
  );
};
