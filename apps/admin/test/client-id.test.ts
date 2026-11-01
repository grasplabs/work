import { describe, expect, it } from "vite-plus/test";

import { clientIdProblem } from "../src/provision/client-id.ts";

describe("a web address the create page checks as it is typed", () => {
  it("is refused, in plain words, where the server would refuse it", () => {
    expect({
      empty: clientIdProblem(""),
      uppercase: clientIdProblem("Acme"),
      underscore: clientIdProblem("acme_eu"),
      edgeDash: clientIdProblem("-acme"),
      tooLong: clientIdProblem("a".repeat(51)),
      reserved: clientIdProblem("www"),
      fine: clientIdProblem("acme-eu-2"),
    }).toStrictEqual({
      empty: "Give it a web address.",
      uppercase: "Use only lowercase letters, digits and dashes.",
      underscore: "Use only lowercase letters, digits and dashes.",
      edgeDash: "Start and end it with a letter or digit.",
      tooLong: "Keep it to 50 characters at most.",
      reserved: "www is reserved for Grasp itself: choose another.",
      fine: null,
    });
  });
});
