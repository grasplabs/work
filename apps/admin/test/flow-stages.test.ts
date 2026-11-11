import { STAGES } from "@grasp-os/shared/admin/onboarding-admin";
import type {
  Stage,
  StageStatus,
} from "@grasp-os/shared/admin/onboarding-admin";
import { defaultFlow, flowPresets } from "@grasp-os/shared/onboarding-flow";
import { describe, expect, it } from "vite-plus/test";

import { stageShown, stagesIn } from "../src/admin/flow-stages.ts";

/** Every step with `status`, but those in `others`. */
const statuses = (
  status: StageStatus,
  others: Partial<Record<Stage, StageStatus>> = {}
): Record<Stage, StageStatus> => ({
  conversation: status,
  research: status,
  agreed: status,
  connected: status,
  leads: status,
  interviews: status,
  open: status,
  ...others,
});

describe("the steps a company's flow has", () => {
  it("are all of them for the whole onboarding, and for a Grasp that says no flow", () => {
    expect({
      whole: stagesIn(defaultFlow),
      notSaid: stagesIn(),
    }).toStrictEqual({ whole: [...STAGES], notSaid: [...STAGES] });
  });

  it("leave out what the flow switched off: Grasp's own steps, the admin's, or all but the opening", () => {
    expect({
      short: stagesIn(flowPresets.short),
      setup: stagesIn(flowPresets.setup),
      none: stagesIn(flowPresets.none),
      // One agreement asked for keeps Agreed.
      oneAgreement: stagesIn({
        ...flowPresets.setup,
        grasp: {
          kickoff: false,
          agreements: { processing: true, assessment: false, council: false },
        },
      }),
    }).toStrictEqual({
      short: [...STAGES],
      setup: ["connected", "open"],
      none: ["open"],
      oneAgreement: ["agreed", "connected", "open"],
    });
  });

  it("open on the step asked for while the flow has it, else on the first that isn't done", () => {
    const shown = stagesIn(flowPresets.setup);
    expect({
      asked: stageShown(shown, "connected", statuses("later")),
      notInFlow: stageShown(shown, "interviews", statuses("later")),
      afterDone: stageShown(
        shown,
        "interviews",
        statuses("later", { connected: "done" })
      ),
      allDone: stageShown(shown, "interviews", statuses("done")),
    }).toStrictEqual({
      asked: "connected",
      notInFlow: "connected",
      afterDone: "open",
      allDone: "open",
    });
  });
});
