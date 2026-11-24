import type { CatalogTool } from "@grasp-os/shared/connect";
import { composioToolsSchema } from "@grasp-os/shared/connect";
import { describe, expect, it } from "vite-plus/test";

import { toolRules, withAllowed, withRead } from "./tool-choices.ts";

// What the dialog for connecting a Composio toolkit submits: a tool wrongly
// submitted as a read runs without asking its person, so the default for a
// tool Composio doesn't tag read-only must be a side effect.

const tool = (name: string, readOnly: boolean): CatalogTool => ({
  name,
  description: null,
  inputs: [],
  readOnly,
});

const list = tool("HUBSPOT_LIST_CONTACTS", true);
const create = tool("HUBSPOT_CREATE_CONTACT", false);

describe("the tools an admin allows", () => {
  it("are each submitted once, never marked without being allowed, and start from the hint again when allowed again", () => {
    const twice = withAllowed(withAllowed([], list, true), list, true);
    const notAllowed = withRead(twice, create.name, true);
    expect(toolRules(notAllowed)).toStrictEqual([
      { name: "HUBSPOT_LIST_CONTACTS", read: true },
    ]);
    // What connect takes: its schema reads what the dialog submits.
    expect(
      composioToolsSchema.safeParse(toolRules(notAllowed)).success
    ).toBeTruthy();

    const marked = withRead(withAllowed([], create, true), create.name, true);
    const removed = withAllowed(marked, create, false);
    expect(toolRules(withAllowed(removed, create, true))).toStrictEqual([
      "HUBSPOT_CREATE_CONTACT",
    ]);
  });
});
