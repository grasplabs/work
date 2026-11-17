// @vitest-environment happy-dom
import type { Organization } from "@grasp-os/shared/organization";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vite-plus/test";

import { organizationRenamed, useShownName } from "./organization-name.tsx";

// The organization's name the sidebar shows, against core's answer to its
// read of the organization, faked: the name once core says it; none when
// it has none or core can't say.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const organizationNamed = (name: string): Organization => ({
  name,
  timeZone: "Europe/Amsterdam",
  dataRegion: "eu",
  signInDomains: [],
});

/** Lets everything already settled run: core's answer, and React's render of it. */
const settled = async (): Promise<void> => {
  for (let turn = 0; turn < 10; turn += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one turn after another
    await Promise.resolve();
  }
};

/** Shows the name as the sidebar reads it. */
const Shown = ({
  organization,
}: {
  organization: () => Promise<Organization>;
}) => <p>{useShownName(organization)}</p>;

/**
 * The name shown once core answered `organization`'s read, and
 * `then` (a rename on the page, say) ran.
 */
const textWith = async (
  organization: () => Promise<Organization>,
  then?: () => void
): Promise<string> => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<Shown organization={organization} />);
    await settled();
  });
  if (then !== undefined) {
    act(then);
  }
  const text = host.textContent.trim();
  act(() => {
    root.unmount();
  });
  host.remove();
  return text;
};

describe("the organization's name in the sidebar", () => {
  it("names the organization once core says it, and its new name once renamed, and none when it has none or core can't say", async () => {
    expect({
      named: await textWith(async () => {
        await settled();
        return organizationNamed("Noordkade Finance");
      }),
      unnamed: await textWith(async () => {
        await settled();
        return organizationNamed("  ");
      }),
      unanswered: await textWith(async () => {
        await settled();
        throw new Error("Core couldn't say just now.");
      }),
      renamed: await textWith(
        async () => {
          await settled();
          return organizationNamed("Noordkade Finance");
        },
        () => {
          organizationRenamed("Noordkade Group");
        }
      ),
      // Renamed while the read is still out: its older answer doesn't undo it.
      renamedFirst: await textWith(async () => {
        organizationRenamed("Noordkade Group");
        await settled();
        return organizationNamed("Noordkade Finance");
      }),
      // A sidebar mounted anew, its read still out: nothing of the names
      // the sidebars before it showed.
      mountedAgain: await textWith(
        async () => await Promise.withResolvers<Organization>().promise
      ),
    }).toStrictEqual({
      named: "Noordkade Finance",
      unnamed: "",
      unanswered: "",
      renamed: "Noordkade Group",
      renamedFirst: "Noordkade Group",
      mountedAgain: "",
    });
  });
});
