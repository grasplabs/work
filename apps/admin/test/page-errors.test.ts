import { describe, expect, it, vi } from "vite-plus/test";

import { reportPageErrorFn } from "../src/admin/page-error-functions.ts";
import { pageErrorsPerMinute } from "../src/admin/page-error-limit.ts";
import { mockAccess } from "./access.ts";
import { callServerFn } from "./pages.ts";

// What the admin's pages report of an error they hit in the browser
// (src/admin/page-errors.ts): a line in the Worker's logs, about the page,
// never the person; a limited number a minute from each staff member;
// refused as anything else.

mockAccess();

const report = {
  kind: "render" as const,
  message: "Cannot read properties of undefined",
  stack: "TypeError: Cannot read properties of undefined\n    at Setup",
  route: "/organizations/$clientId/setup",
  build: "local",
};

/** Everything `task` logs as an error while it runs. */
const errorsLoggedBy = async (task: () => Promise<unknown>) => {
  const lines: unknown[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((line) => {
    lines.push(line);
  });
  try {
    await task();
  } finally {
    spy.mockRestore();
  }
  return lines;
};

describe("a page's error report", () => {
  it("logs what the page hit, its route's pattern and its build, and nothing of who hit it", async () => {
    const lines = await errorsLoggedBy(async () => {
      await callServerFn(reportPageErrorFn, report, {
        email: "grace@grasp.test",
      });
    });

    expect({
      lines,
      who: JSON.stringify(lines).includes("grace@grasp.test"),
    }).toStrictEqual({
      lines: [{ event: "admin.page_error", ...report }],
      who: false,
    });
  });

  it("refuses what isn't a report, or one past its limits, logging nothing", async () => {
    const tries = [
      { ...report, kind: "anything" },
      { ...report, message: "x".repeat(1001) },
      { ...report, url: "https://admin.grasp.test/organizations/acme" },
    ];

    let outcomes: string[] = [];
    const lines = await errorsLoggedBy(async () => {
      outcomes = await Promise.all(
        tries.map(
          async (each) =>
            // SAFETY: each is what a page elsewhere might send in its place:
            // the Worker checks it, which is what this tests.
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
            await callServerFn(reportPageErrorFn, each as typeof report).then(
              () => "taken",
              () => "refused"
            )
        )
      );
    });

    expect({ outcomes, logged: lines.length }).toStrictEqual({
      outcomes: ["refused", "refused", "refused"],
      logged: 0,
    });
  });

  it("logs a limited number a minute from each staff member, whatever the others sent", async () => {
    const answers: unknown[] = [];
    // All in one minute, however long the test takes.
    vi.useFakeTimers({ toFake: ["Date"] });
    let lines: unknown[] = [];
    try {
      lines = await errorsLoggedBy(async () => {
        for (let sent = 0; sent <= pageErrorsPerMinute; sent += 1) {
          answers.push(
            // oxlint-disable-next-line no-await-in-loop -- counted one at a time
            await callServerFn(reportPageErrorFn, report, {
              email: "looping@grasp.test",
            })
          );
        }
        answers.push(
          await callServerFn(reportPageErrorFn, report, {
            email: "other@grasp.test",
          })
        );
      });
    } finally {
      vi.useRealTimers();
    }

    expect({ answers, logged: lines.length }).toStrictEqual({
      answers: [
        ...Array.from({ length: pageErrorsPerMinute }, () => ({
          logged: true,
        })),
        { logged: false },
        { logged: true },
      ],
      logged: pageErrorsPerMinute + 1,
    });
  });
});
