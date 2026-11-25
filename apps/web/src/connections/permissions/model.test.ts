import { describe, expect, it } from "vite-plus/test";

import { calendlyTools } from "./calendly-tools.ts";
import {
  presetChoice,
  presetOf,
  sortTool,
  sortTools,
  startingChoice,
  withAll,
} from "./model.ts";

const sorted = sortTools(calendlyTools, "calendly");

const kindOf = (action: string) =>
  sortTool(
    {
      name: `CALENDLY_${action}`,
      description: null,
      inputs: [],
      readOnly: action.startsWith("LIST"),
    },
    "calendly"
  ).kind;

describe(sortTool, () => {
  it("sorts by the provider's hint, then by what the action does", () => {
    expect(kindOf("LIST_EVENT_TYPES")).toBe("look");
    expect(kindOf("UPDATE_EVENT_TYPE")).toBe("change");
    expect(kindOf("CANCEL_SCHEDULED_EVENT")).toBe("remove");
    expect(kindOf("REVOKE_USER_S_ORGANIZATION_INVITATION")).toBe("remove");
  });

  it("keeps an apostrophe and spots a deprecated tool", () => {
    const tool = sorted.find(
      ({ tool: { name } }) => name === "CALENDLY_LIST_USER_S_EVENT_TYPES"
    );
    expect(tool?.name).toBe("List user's event types");
    expect(tool?.deprecated).toBeTruthy();
  });
});

describe("choices", () => {
  it("starts with every current tool that only reads, as Read", () => {
    const start = startingChoice(sorted);
    expect(start).toHaveLength(34);
    expect(start.every(({ read }) => read)).toBeTruthy();
    expect(presetOf(sorted, start)).toBe("look");
  });

  it("never turns on a write tool as Read", () => {
    const all = presetChoice(sorted, "all");
    const writes = all.filter(
      ({ name }) =>
        calendlyTools.find((tool) => tool.name === name)?.readOnly !== true
    );
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every(({ read }) => !read)).toBeTruthy();
  });

  it("turns a group off and on again without the deprecated ones", () => {
    const off = withAll(startingChoice(sorted), sorted, false);
    expect(off).toStrictEqual([]);
    expect(withAll(off, sorted, true)).toHaveLength(53);
    expect(presetOf(sorted, withAll(off, sorted, true))).toBe("all");
  });
});
