import { describe, expect, it } from "vite-plus/test";

import { mockIdp } from "./idp.ts";
import {
  askedThroughDoor,
  companyOnce,
  doorClockRunsAhead,
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
  doorClockRunsAhead();

  it("show a member nothing they may not read through the Teams door either", async () => {
    const place = await setUp();
    const outcomes: ProbeOutcome[] = [];
    for (const probe of memberProbes) {
      // oxlint-disable-next-line no-await-in-loop -- one message at a time
      outcomes.push(await askedThroughDoor(probe, place));
    }
    expect({
      asked: outcomes.length,
      unanswered: outcomes.filter(({ answered }) => answered !== true),
      leaks: outcomes.filter(({ leaked }) => leaked.length > 0),
    }).toStrictEqual({ asked: 120, unanswered: [], leaks: [] });
  });
});
