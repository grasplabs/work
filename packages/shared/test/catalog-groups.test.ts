import { describe, expect, it } from "vite-plus/test";

import { catalogGroupOf, firstSentence } from "../src/connect.ts";

// Composio's categories, as its toolkits name them, sorted into Grasp's
// kinds of app the way the design prototype sorts them.

describe("a catalog entry's group", () => {
  it("follows its category, whatever its case", () => {
    expect(
      [
        "CRM",
        "Accounting",
        "Human resources",
        "Email newsletters",
        "Scheduling & booking",
        "Phone & SMS",
        "Project management",
        "Documents",
        "Analytics",
        "Artificial intelligence",
        "AI agents",
        "Model context protocol",
        "Commerce",
        "Images & design",
        "Security & identity tools",
        "Customer support",
        "Forms & surveys",
      ].map((category) => catalogGroupOf([category]))
    ).toStrictEqual([
      "CRM",
      "Finance and accounting",
      "HR",
      "Marketing",
      "Email and calendar",
      "Chat",
      "Projects and tasks",
      "Files and documents",
      "Data and analytics",
      "AI",
      "AI",
      "AI",
      "Commerce",
      "Design and media",
      "Developer tools",
      "Support",
      "Forms and surveys",
    ]);
  });

  it("takes the first group that fits, in Grasp's precedence", () => {
    // Signing before documents, HR before finance, CRM before marketing.
    expect(catalogGroupOf(["E-signature documents"])).toBe("Signing");
    expect(catalogGroupOf(["Payroll & payments"])).toBe("HR");
    expect(catalogGroupOf(["Sales & marketing"])).toBe("CRM");
  });

  it("is that of the first category a group fits", () => {
    expect(catalogGroupOf(["News & lifestyle", "Accounting"])).toBe(
      "Finance and accounting"
    );
    expect(catalogGroupOf(["Accounting", "CRM"])).toBe(
      "Finance and accounting"
    );
  });

  it("is Other when no group fits, or there is no category", () => {
    expect(catalogGroupOf(["Fitness", "News & lifestyle"])).toBe("Other");
    expect(catalogGroupOf([])).toBe("Other");
  });
});

describe("a catalog entry's description", () => {
  it("is the first sentence, its whitespace collapsed", () => {
    expect(
      firstSentence("  Linear is an  issue tracker.\nIt is fast. Really!  ")
    ).toBe("Linear is an issue tracker.");
    expect(firstSentence("Version 2.0 of the API is here")).toBe(
      "Version 2.0 of the API is here"
    );
  });

  it("is cut at a word, with an ellipsis, when the sentence is long", () => {
    const long = `${"word ".repeat(40).trim()}, and more.`;
    const cut = firstSentence(long);
    expect(cut).toBe(`${"word ".repeat(27).trim()}…`);
    expect(cut?.length).toBeLessThanOrEqual(140);
  });

  it("is none for an empty description", () => {
    expect(firstSentence(" \n ")).toBeNull();
  });
});
