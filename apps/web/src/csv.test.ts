import { describe, expect, it } from "vite-plus/test";

import { toCsv } from "./csv.ts";

// What a spreadsheet makes of the CSV the web hands people: each cell
// stays one cell, and nothing in it runs as a formula.

describe("a CSV file", () => {
  it("keeps plain cells as they are, a row a line", () => {
    expect(
      toCsv([
        ["Name", "Team"],
        ["Eva Bakker", "Finance"],
      ])
    ).toBe("Name,Team\nEva Bakker,Finance");
  });

  it("quotes a cell with a comma, a quote or a line break, its quotes doubled", () => {
    expect(
      toCsv([["Writes, edits", 'Says "hi"', "Two\nlines", "Carriage\rreturn"]])
    ).toBe('"Writes, edits","Says ""hi""","Two\nlines","Carriage\rreturn"');
  });

  it("keeps a cell that starts like a formula from running as one", () => {
    const [row = ""] = toCsv([
      ["=SUM(A1)", "+1", "-1", "@cmd", "  =1+1", "\tTab", '=HYPERLINK("x")'],
    ]).split("\n");
    expect(row).toBe(
      `'=SUM(A1),'+1,'-1,'@cmd,'  =1+1,'\tTab,"'=HYPERLINK(""x"")"`
    );
  });

  it("leaves a formula sign later in a cell alone", () => {
    expect(toCsv([["a=b", "1+1", "name@example.com"]])).toBe(
      "a=b,1+1,name@example.com"
    );
  });
});
