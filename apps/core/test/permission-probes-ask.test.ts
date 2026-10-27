import { describe, expect, it } from "vite-plus/test";

import {
  permissionProbes,
  unreadableTo,
} from "./fixtures/permission-probes.ts";
import { mockIdp } from "./idp.ts";
import {
  askedInWorkspace,
  clockRunsAhead,
  companyOnce,
  memberProbes,
  probeTime,
} from "./permission-probing.ts";
import type { ProbeOutcome } from "./permission-probing.ts";
import { watched } from "./teams-door.ts";

// Who may see what (GRA-731): the 150 permission probes
// (fixtures/permission-probes.ts) in the Brain baseline's company, each
// asked as one person about what another may see, through `Workspace.ask`
// and once more through the Teams door, as the Brain baseline's security
// gate checks a trial: nothing its asker may not read reaches a model or
// the answer. The model is a stand-in that tries every read it can
// (permission-probing.ts), so a probe passes on the platform's permissions
// alone. The probes are split over files that can run apart:
// permission-probes-ask.test.ts asks the members' probes through
// `Workspace.ask`, permission-probes-teams.test.ts through the Teams door,
// and permission-probes-controls.test.ts has the controls, the outsiders
// and people matters.

const idp = mockIdp();

watched();

const setUp = companyOnce(idp);

describe("the permission probes", probeTime, () => {
  clockRunsAhead();

  it("are 150, guests and removed people among them, each asking as one person about what another may see", () => {
    expect({
      probes: permissionProbes.length,
      unique: new Set(permissionProbes.map(({ id }) => id)).size,
      askers: [...new Set(permissionProbes.map(({ asker }) => asker))],
      // Every probe's target is one its asker may not see.
      foreign: permissionProbes.every(
        ({ asker, target }) =>
          asker === "removed" ||
          asker === "guest" ||
          unreadableTo[asker].includes(target)
      ),
    }).toStrictEqual({
      probes: 150,
      unique: 150,
      askers: ["ana", "bram", "removed", "guest"],
      foreign: true,
    });
  });

  it("show a member nothing they may not read through Workspace.ask: no canary, fact or colleague's memory reaches a model or the answer", async () => {
    const place = await setUp();
    const outcomes: ProbeOutcome[] = [];
    for (const probe of memberProbes) {
      // oxlint-disable-next-line no-await-in-loop -- one turn at a time
      outcomes.push(await askedInWorkspace(probe, place));
    }
    expect({
      asked: outcomes.length,
      unanswered: outcomes.filter(({ answered }) => answered !== true),
      leaks: outcomes.filter(({ leaked }) => leaked.length > 0),
    }).toStrictEqual({ asked: 120, unanswered: [], leaks: [] });
  });
});
