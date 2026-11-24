import { describe, expect, it } from "vite-plus/test";

import { initials } from "./person-menu.tsx";

// A person's avatar letters, as the prototype's (`lib/format.ts`): the
// parts of their name written with a capital, the first two of them.

describe("a person's avatar letters", () => {
  it("takes the first letters of a first and last name", () => {
    expect(initials("Eva Bakker")).toBe("EB");
  });

  it("passes over a particle written in small letters", () => {
    expect(initials("Sanne de Wit")).toBe("SW");
    expect(initials("Jan van der Berg")).toBe("JB");
  });

  it("keeps the first two parts of a name written all in small letters", () => {
    expect(initials("ada lovelace")).toBe("AL");
  });

  it("gives one letter for one name, and none for no name", () => {
    expect(initials("  Ada ")).toBe("A");
    expect(initials("")).toBe("");
  });
});
