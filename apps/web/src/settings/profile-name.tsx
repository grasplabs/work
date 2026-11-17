import { useLingui } from "@lingui/react/macro";
import { useState } from "react";

import { Input } from "../grasp/input/index.ts";
import { SettingRow } from "../grasp/setting-row/index.ts";
import type { SettingRowState } from "../grasp/setting-row/index.ts";
import { useCoreAction } from "../use-core-action.ts";

// Settings › Profile's name: the person's own, as Grasp calls them
// everywhere (`session.setName`). Saved when the field is left, or on
// Enter; Escape puts it back. Their sign-in set it when they first came
// in and doesn't again, so what they give stays.

/** The longest name core takes (`personNameSchema`). */
const nameMaxLength = 100;

/** The person's own name, as a setting's row. */
export const ProfileName = ({ name }: { name: string }) => {
  const { t } = useLingui();
  const { busy, failure, run } = useCoreAction();
  const [draft, setDraft] = useState<string | null>(null);
  // How its last save stands, said in the row (Setting row's `state`).
  const [state, setState] = useState<SettingRowState>("idle");
  // The name a failed save tried, kept for Try again.
  const [tried, setTried] = useState<string>();
  // What core last took: the frame's word on who is signed in catches up
  // on a later page.
  const [saved, setSaved] = useState(name);
  const send = (next: string): void => {
    setState("saving");
    void (async () => {
      const done = await run(async (session) => {
        await session.setName(next);
        return true;
      });
      if (done === true) {
        setSaved(next);
        setTried(undefined);
        setState("saved");
      } else {
        setTried(next);
        setState("failed");
      }
    })();
  };
  const save = (): void => {
    const next = draft?.trim();
    // A failed save keeps what was typed in the field, as the row says.
    if (state !== "failed") {
      setDraft(null);
    }
    if (next === undefined || next === "" || next === saved) {
      return;
    }
    send(next);
  };
  return (
    <SettingRow
      {...(failure === undefined ? {} : { error: failure })}
      failedLabel={t`Could not save. Your name is kept.`}
      label={t`Name`}
      onRetry={() => {
        if (tried !== undefined) {
          send(tried);
        }
      }}
      retryLabel={t`Try again`}
      savedLabel={t`Saved`}
      savingLabel={t`Saving`}
      state={state}
    >
      {(field) => (
        <Input
          {...field}
          maxLength={nameMaxLength}
          onBlur={save}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.currentTarget.blur();
            }
            if (event.key === "Escape") {
              setDraft(null);
              setState("idle");
            }
          }}
          onValueChange={(value) => {
            setDraft(value);
            setState("idle");
          }}
          // Read-only while its save runs, not disabled: a disabled field drops the keyboard's focus.
          readOnly={busy}
          value={draft ?? saved}
        />
      )}
    </SettingRow>
  );
};
