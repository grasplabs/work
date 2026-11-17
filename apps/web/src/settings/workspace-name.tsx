import { failureText } from "@grasp-os/shared/errors";
import {
  organizationErrors,
  organizationLogoMaxBytes,
  organizationLogoTypes,
} from "@grasp-os/shared/organization";
import type { Organization } from "@grasp-os/shared/organization";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { useRef, useState } from "react";

import type { Session } from "../core.ts";
import {
  organizationLogoChanged,
  organizationRenamed,
} from "../frame/organization-name.tsx";
import { Avatar, AvatarFallback, AvatarImage } from "../grasp/avatar/index.ts";
import { Button } from "../grasp/button/index.ts";
import { Input } from "../grasp/input/index.ts";
import { SettingRow } from "../grasp/setting-row/index.ts";
import type { SettingRowState } from "../grasp/setting-row/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
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
  // The logo, then its buttons, in the control column.
  logo: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    width: "100%",
  },
  // The file picker the Change button opens: never seen.
  picker: { display: "none" },
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

/**
 * The organization's logo, as a setting's row: the logo, or its initials
 * while it has none; Change picks an image (PNG, JPEG or WebP, at most
 * 512 KB, which core checks again by its bytes), Remove takes it away.
 * The sidebar shows the new one at once.
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
  const words = useSaveWords();
  const { busy, failure, status, change } = useOrganizationChange();
  const picker = useRef<HTMLInputElement>(null);
  // What core last took: the page's read catches up behind it.
  const [saved, setSaved] = useState(logo);
  // An image refused before it was sent: too large for core to take.
  const [problem, setProblem] = useState<string>();
  // The last change asked for, kept for Try again.
  const [tried, setTried] = useState<Uint8Array | null>();
  const send = (image: Uint8Array | null): void => {
    setTried(image);
    change(
      async (api) =>
        image === null ? await api.removeLogo() : await api.setLogo(image),
      (organization) => {
        setSaved(organization.logo);
        setTried(undefined);
        organizationLogoChanged(organization.logo);
      }
    );
  };
  const choose = (file: File | undefined): void => {
    setProblem(undefined);
    if (file === undefined) {
      return;
    }
    if (file.size > organizationLogoMaxBytes) {
      setProblem(
        failureText(organizationErrors.create("organization.logo_too_large"))
      );
      return;
    }
    void (async () => {
      send(new Uint8Array(await file.arrayBuffer()));
    })();
  };
  const reason = problem ?? failure;
  return (
    <SettingRow
      {...words}
      {...(reason === undefined ? {} : { error: reason })}
      help={t`Shown beside your company’s name in Grasp.`}
      label={t`Logo`}
      onRetry={() => {
        if (tried !== undefined) {
          send(tried);
        }
      }}
      status={status}
    >
      <span {...stylex.props(controlStyles.logo)}>
        <Avatar name={name} size="sm">
          {saved === null ? null : <AvatarImage src={saved} />}
          <AvatarFallback />
        </Avatar>
        {canChange ? (
          <>
            <input
              accept={organizationLogoTypes.join(",")}
              aria-hidden
              onChange={(event) => {
                choose(event.currentTarget.files?.[0]);
                // The same file chosen again is a change again.
                event.currentTarget.value = "";
              }}
              ref={picker}
              tabIndex={-1}
              type="file"
              {...stylex.props(controlStyles.picker)}
            />
            <Button
              disabled={busy}
              onClick={() => {
                picker.current?.click();
              }}
              size="sm"
            >
              {saved === null ? t`Add a logo` : t`Change`}
            </Button>
            {saved === null ? null : (
              <Button
                disabled={busy}
                onClick={() => {
                  send(null);
                }}
                size="sm"
                variant="ghost"
              >
                {t`Remove`}
              </Button>
            )}
          </>
        ) : null}
      </span>
    </SettingRow>
  );
};
