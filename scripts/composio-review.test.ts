import { describe, expect, it } from "vite-plus/test";

import { composioClasses } from "../apps/connect/src/composio-classes.ts";
import { isNeverTool } from "../apps/connect/src/never.ts";
import { reviewRows } from "./composio-review.ts";

describe("a Composio toolkit's review table", () => {
  it("suggests the class a release gave, never for a Never name, and otherwise asks by Composio's hint", () => {
    const rows = reviewRows(
      "crm",
      [
        {
          slug: "CRM_UPDATE_DEAL",
          description: "Updates a deal",
          readOnly: false,
        },
        { slug: "CRM_LIST_DEALS", description: "Lists deals", readOnly: true },
        {
          slug: "CRM_DELETE_DEAL",
          description: "Deletes a deal",
          readOnly: false,
        },
        { slug: "CRM_GET_DEAL", description: "Gets a deal", readOnly: true },
      ],
      {
        crm: {
          CRM_GET_DEAL: "read-company",
          CRM_DELETE_DEAL: "change-company",
        },
      }
    );
    expect(
      rows.map(({ tool, shipped, suggested }) => [tool, shipped, suggested])
    ).toStrictEqual([
      ["CRM_DELETE_DEAL", "change-company", "never"],
      ["CRM_GET_DEAL", "read-company", "read-company"],
      ["CRM_LIST_DEALS", "", "read-company?"],
      ["CRM_UPDATE_DEAL", "", "change-company?"],
    ]);
  });

  it("finds no class in this release for a tool the Never rule refuses", () => {
    const refused = Object.values(composioClasses).flatMap((tools) =>
      Object.entries(tools).flatMap(([tool, toolClass]) =>
        toolClass !== "never" && isNeverTool(tool) ? [tool] : []
      )
    );
    expect(refused).toStrictEqual([]);
  });
});
