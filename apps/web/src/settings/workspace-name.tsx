import { useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import type { Session } from "../core.ts";
import { organizationRenamed } from "../frame/organization-name.tsx";
import { Input } from "../grasp/input/index.ts";
import { useCoreAction } from "../use-core-action.ts";
import { SettingRow } from "./section.tsx";

// Settings › Workspace's own fields: a change to the organization, then
// the page read again, each field with its own failure; and the name,
// which tells the sidebar the moment core saved it
// (frame/organization-name.tsx), so it never shows the name just replaced.

type Change = (organization: Session["organization"]) => Promise<unknown>;

/**
 * Makes a change to the organization, then reads the page again: its
 * failure is its own, and `busy` while it runs. `onSaved` runs once core
 * took the change.
 */
export const useOrganizationChange = () => {
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const change = (update: Change, onSaved?: () => void): void => {
    void (async () => {
      const saved = await run(async (session) => {
        await changeThenRefresh(
          async () => await update(session.organization),
          async () => {
            await router.invalidate({ sync: true });
          }
        );
        return true;
      });
      if (saved === true) {
        onSaved?.();
      }
    })();
  };
  return { busy, failure, change };
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
  const { busy, failure, change } = useOrganizationChange();
  const [draft, setDraft] = useState<string | null>(null);
  const save = (): void => {
    const next = draft?.trim();
    setDraft(null);
    if (next !== undefined && next !== "" && next !== name) {
      change(
        async (api) => await api.update({ name: next }),
        () => {
          organizationRenamed(next);
        }
      );
    }
  };
  return (
    <SettingRow
      {...(failure === undefined ? {} : { error: failure })}
      help={
        canChange
          ? t`Your company’s name in Grasp.`
          : t`Your company’s name in Grasp. An admin changes it.`
      }
      label={t`Name`}
    >
      {(field) => (
        <Input
          {...field}
          maxLength={80}
          onBlur={save}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.currentTarget.blur();
            }
            if (event.key === "Escape") {
              setDraft(null);
            }
          }}
          onValueChange={setDraft}
          // Read-only while its save runs, not disabled: a disabled field drops the keyboard's focus.
          readOnly={!canChange || busy}
          value={draft ?? name}
        />
      )}
    </SettingRow>
  );
};
