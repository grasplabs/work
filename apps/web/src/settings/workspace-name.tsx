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
import { useState } from "react";

import type { Session } from "../core.ts";
import {
  organizationLogoChanged,
  organizationRenamed,
} from "../frame/organization-name.tsx";
import { Button } from "../grasp/button/index.ts";
import { focus } from "../grasp/focus/focus.ts";
import { Input } from "../grasp/input/index.ts";
import { SettingRow } from "../grasp/setting-row/index.ts";
import type { SettingRowState } from "../grasp/setting-row/index.ts";
import { Spinner } from "../grasp/spinner/index.ts";
import { Text } from "../grasp/text/index.ts";
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
          value={draft ?? saved}
        />
      )}
    </SettingRow>
  );
};

/** The initials a company without a logo is shown by: its first two words'. */
const initialsOf = (name: string): string =>
  name
    .split(/\s+/u)
    .filter((word) => word !== "")
    .slice(0, 2)
    .map((word) => word.slice(0, 1))
    .join("")
    .toUpperCase();

const logoStyles = stylex.create({
  // The logo first in the card, above the rows: the well, then its words.
  block: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space4,
    paddingInline: grasp.space4,
    paddingBlock: grasp.space4,
    borderBlockEndWidth: grasp.hairline,
    borderBlockEndStyle: "solid",
    borderBlockEndColor: grasp.line,
  },
  // The well: the logo, or the initials, square, larger than a row's
  // control; itself the way to change it (a press or a dropped file).
  well: {
    position: "relative",
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: grasp.space16,
    height: grasp.space16,
    overflow: "hidden",
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.soft,
    boxShadow: grasp.edge,
    color: grasp.muted,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textLg,
    fontWeight: grasp.weightMedium,
  },
  changeable: { cursor: "pointer" },
  // A file held over it: the well says it will take it.
  over: { boxShadow: `0 0 0 2px ${grasp.ink}` },
  image: { width: "100%", height: "100%", objectFit: "contain" },
  // The file picker covers the well, so a press anywhere on it opens it.
  input: {
    position: "absolute",
    inset: 0,
    opacity: 0,
    cursor: "pointer",
  },
  // Saving: a spinner over the logo.
  veil: {
    position: "absolute",
    inset: 0,
    display: "grid",
    placeItems: "center",
    backgroundColor: grasp.soft,
  },
  words: { display: "grid", gap: grasp.space1, minWidth: 0 },
  line: { display: "flex", alignItems: "center", gap: grasp.space2 },
});

/**
 * The organization's logo, first in the Organization card: a square well
 * with the logo, or its initials while it has none, which is itself the
 * control. A press or a dropped image changes it (PNG, JPEG or WebP, at
 * most 512 KB, which core checks again by its bytes); Remove takes it
 * away. Saving shows on the well; a failure under it, with Try again. The
 * sidebar shows the new one at once.
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
  const { busy, failure, status, change } = useOrganizationChange();
  // What core last took: the page's read catches up behind it.
  const [saved, setSaved] = useState(logo);
  // An image refused before it was sent: too large for core to take.
  const [problem, setProblem] = useState<string>();
  // The last change asked for, kept for Try again.
  const [tried, setTried] = useState<Uint8Array | null>();
  const [over, setOver] = useState(false);
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
  const shown =
    saved === null ? (
      <span aria-hidden="true">{initialsOf(name)}</span>
    ) : (
      <img alt="" src={saved} {...stylex.props(logoStyles.image)} />
    );
  return (
    <div {...stylex.props(logoStyles.block)}>
      <label
        {...stylex.props(
          logoStyles.well,
          canChange && logoStyles.changeable,
          over && logoStyles.over,
          focus.within
        )}
      >
        {shown}
        {canChange ? (
          <input
            accept={organizationLogoTypes.join(",")}
            aria-label={saved === null ? t`Add a logo` : t`Change the logo`}
            disabled={busy}
            // A file dropped on the well lands on this field, which covers it.
            onDragEnter={() => {
              setOver(true);
            }}
            onDragLeave={() => {
              setOver(false);
            }}
            onChange={(event) => {
              setOver(false);
              choose(event.currentTarget.files?.[0]);
              // The same file chosen again is a change again.
              event.currentTarget.value = "";
            }}
            type="file"
            {...stylex.props(logoStyles.input)}
          />
        ) : null}
        {status === "saving" ? (
          <span {...stylex.props(logoStyles.veil)}>
            <Spinner aria-label={t`Saving`} />
          </span>
        ) : null}
      </label>
      <div {...stylex.props(logoStyles.words)}>
        <span {...stylex.props(logoStyles.line)}>
          <Text size="sm" weight="medium">
            {t`Logo`}
          </Text>
          {canChange && saved !== null ? (
            <Button
              disabled={busy}
              onClick={() => {
                send(null);
              }}
              size="xs"
              variant="ghost"
            >
              {t`Remove`}
            </Button>
          ) : null}
        </span>
        {reason === undefined ? (
          <Text size="xs" tone="muted">
            {canChange
              ? t`Click or drop an image: PNG, JPEG or WebP, up to 512 KB.`
              : t`An admin changes it.`}
          </Text>
        ) : (
          <span {...stylex.props(logoStyles.line)}>
            <Text size="xs">{reason}</Text>
            {tried === undefined ? null : (
              <Button
                onClick={() => {
                  send(tried);
                }}
                size="xs"
                variant="ghost"
              >
                {t`Try again`}
              </Button>
            )}
          </span>
        )}
      </div>
    </div>
  );
};
