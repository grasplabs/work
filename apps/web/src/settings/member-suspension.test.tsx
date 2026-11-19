// @vitest-environment happy-dom
import type { DirectoryAccount, Member } from "@grasp-os/shared/members";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { formatDate } from "../format.ts";
import { MemberSuspension } from "./member-suspension.tsx";

// A member's suspension in Settings › Members, as an admin reads it: why,
// since when, and where the way out is. Only the directory lifts one, so
// the row offers nothing to click.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const since = "2026-11-18T07:00:00.000Z";
// As the row writes it, in this machine's time zone.
const date = formatDate(since);

/** Ann, suspended for `reason`, or not at all for null. */
const ann = (reason: DirectoryAccount | null): Member => ({
  userId: "user-ann",
  name: "Ann de Vries",
  email: "ann@acme.test",
  role: "user",
  joinedAt: "2026-01-05T09:00:00.000Z",
  suspension: reason === null ? null : { since, reason },
});

let root: Root | undefined;

/** Ann's suspension as the row shows it: its text, and how many buttons. */
const shown = (member: Member): { text: string; buttons: number } => {
  const host = document.createElement("div");
  document.body.append(host);
  act(() => {
    root = createRoot(host);
    root.render(
      <I18nProvider i18n={i18n}>
        <MemberSuspension member={member} />
      </I18nProvider>
    );
  });
  const seen = {
    text: host.textContent ?? "",
    buttons: host.querySelectorAll("button").length,
  };
  act(() => {
    root?.unmount();
  });
  root = undefined;
  host.remove();
  return seen;
};

/** Each reason's way out, true for it; none once the directory turned the account on again. */
const waysOut: Record<DirectoryAccount, string | null> = {
  disabled:
    "Turn the account back on in the directory, and Grasp lifts the suspension at its next daily read. To end their access for good, remove them.",
  deleted:
    "Restore the account in the directory, and Grasp lifts the suspension at its next daily read. To end their access for good, remove them.",
  unlisted:
    "The account is no longer listed in the directory. If it was deleted and can still be restored there, restoring it lets Grasp lift the suspension at its next daily read. Otherwise, to end their access for good, remove them.",
  enabled: null,
};

describe("Settings › Members › a member's suspension", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("says why they are suspended, since when, and where the way out is, with nothing to click", () => {
    const reasons: Record<DirectoryAccount, string> = {
      disabled: `Since ${date}: the directory turned their account off.`,
      deleted: `Since ${date}: their account was deleted in the directory.`,
      unlisted: `Since ${date}: their account is no longer in the directory.`,
      enabled: `Since ${date}. The directory has turned their account on again, so its next daily read lifts this.`,
    };
    const states: DirectoryAccount[] = [
      "disabled",
      "deleted",
      "unlisted",
      "enabled",
    ];
    const seen = Object.fromEntries(
      states.map((state) => {
        const { text, buttons } = shown(ann(state));
        return [
          state,
          {
            // Its own reason, and none of the others.
            reason: Object.values(reasons).every(
              (each) => text.includes(each) === (each === reasons[state])
            ),
            suspended: text.startsWith("Suspended"),
            // Its own way out, and none of the others'.
            wayOut: Object.values(waysOut).every(
              (each) =>
                each === null ||
                text.includes(each) === (each === waysOut[state])
            ),
            buttons,
          },
        ];
      })
    );

    expect(seen).toStrictEqual({
      disabled: {
        reason: true,
        suspended: true,
        wayOut: true,
        buttons: 0,
      },
      deleted: {
        reason: true,
        suspended: true,
        wayOut: true,
        buttons: 0,
      },
      unlisted: {
        reason: true,
        suspended: true,
        wayOut: true,
        buttons: 0,
      },
      // Turned on again: the next read lifts it, so no way out is named.
      enabled: {
        reason: true,
        suspended: true,
        wayOut: true,
        buttons: 0,
      },
    });
  });

  it("shows nothing for a member who isn't suspended", () => {
    expect(shown(ann(null))).toStrictEqual({ text: "", buttons: 0 });
  });
});
