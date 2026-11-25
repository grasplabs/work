import { interviewPagePath } from "@grasp-os/shared/interview-links";
import { describe, expect, it } from "vite-plus/test";

import { bootOf } from "./boot-path.ts";

// Only the interview's own address loads the interview alone: the rest of
// the app, under it or beside it, loads the app.

describe(bootOf, () => {
  it("loads the interview alone at the address its links lead to", () => {
    expect(bootOf(interviewPagePath)).toBe("interview");
    expect(bootOf("/interview/")).toBe("interview");
    expect(bootOf("/Interview")).toBe("interview");
  });

  it("loads the app everywhere else", () => {
    expect(bootOf("/")).toBe("app");
    expect(bootOf("/setup")).toBe("app");
    expect(bootOf("/interviews")).toBe("app");
    expect(bootOf("/interview/other")).toBe("app");
    expect(bootOf("/settings/onboarding")).toBe("app");
  });
});
