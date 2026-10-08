import { describe, expect, it } from "vite-plus/test";

import { mayRead } from "../src/knowledge/access.ts";

// A collection for admins (knowledge/access.ts): every admin reads it,
// Grasp staff included, and nobody else, also when an App is shared
// (app-provenance.ts decides with `mayRead`).

const forAdmins = { access: "admins", owner: "owner", teamIds: [] } as const;

describe("a collection for admins", () => {
  it("is read by every admin, and by nobody else", () => {
    expect(
      [
        { userId: "another-admin", teamIds: [], admin: true },
        { userId: "member", teamIds: ["ops"], admin: false },
      ].map((reader) => mayRead(reader, forAdmins))
    ).toStrictEqual([true, false]);
  });
});
