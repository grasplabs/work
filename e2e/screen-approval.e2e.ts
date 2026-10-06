import { expect } from "@playwright/test";

import { test } from "./csp.ts";
import { apiOf, pageOf, peopleIn } from "./people.ts";

// An App's screen and its approval, end to end in a real browser: a
// screen whose code nobody approved isn't started, an admin finds it on
// their dashboard, reads its code and approves it on the engine's page,
// and when they take that back the page stops the screen and empties its
// frame, so what it had been handed is gone from the page. That core refuses the data,
// whatever a caller says, is core's own test (screen-trust.test.ts).

const secret = "Acme owes 4,200";

const serverCode = `import { DurableObject } from "cloudflare:workers";

export class App extends DurableObject {
  notes(): string[] {
    return [${JSON.stringify(secret)}];
  }
}
`;

const screenCode = `import { callServer } from "@grasp-os/sdk/screen";
import { Button } from "@grasp-os/ui/components/button";
import { useEffect, useState } from "react";

export default function Ledger() {
  const [notes, setNotes] = useState<string[]>([]);
  const load = async () => {
    setNotes(await callServer<string[]>("notes"));
  };
  useEffect(() => {
    void load();
  }, []);
  return (
    <main className="flex flex-col gap-2 p-4">
      <h1>Ledger</h1>
      <ul aria-label="Ledger">
        {notes.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
      <Button onClick={() => void load()}>Load again</Button>
    </main>
  );
}
`;

test("a screen gets its engine's data only while an admin's approval of its code stands", async ({
  browser,
}) => {
  const { builder, admin } = peopleIn("screenApproval");
  const name = `Ledger ${crypto.randomUUID().slice(0, 8)}`;
  const { core, api } = apiOf(builder);
  let app: string;
  try {
    ({ id: app } = await api.apps.create({ name }));
    const { version } = await api.apps.files.commit(
      app,
      { "app/server.ts": serverCode, "screens/ledger.tsx": screenCode },
      name
    );
    await api.apps.versions.setCurrent(app, version);
  } finally {
    core[Symbol.dispose]();
  }

  // Nobody approved its code: the screen isn't started, and says why.
  const using = await pageOf(browser, builder);
  await using.goto(`/engines/${app}/apps/ledger/full`);
  const frame = using.locator('iframe[title="ledger app"]');
  await expect(
    using.getByText(
      "Nobody has approved this app's code for the engine's data yet."
    )
  ).toBeVisible({ timeout: 20_000 });
  await expect(frame).not.toHaveAttribute("src");

  // A current version nobody approved is in front of the admins, who read
  // its code and approve it on the engine's page.
  const deciding = await pageOf(browser, admin);
  await deciding.goto("/dashboard");
  await deciding
    .getByRole("region", { name: "To do" })
    .getByRole("link", { name: `Review the apps of ${name}` })
    .click();
  const approval = deciding.getByRole("region", { name: "Approval" });
  const row = approval.getByRole("row", { name: /ledger/u });
  await expect(row).toContainText("Not approved");
  await approval
    .getByRole("button", { name: "Read the code of version 1" })
    .click();
  const code = approval.getByRole("region", {
    name: "The code of version 1",
  });
  await code.getByText("screens/ledger.tsx").click();
  await expect(code).toContainText("export default function Ledger()");
  await approval
    .getByRole("button", { name: "Approve the apps of version 1" })
    .click();
  await expect(row).toContainText("Approved");

  await using.getByRole("button", { name: "Try again" }).click();
  const screen = using.frameLocator('iframe[title="ledger app"]');
  await expect(
    screen.getByRole("list", { name: "Ledger" }).getByText(secret)
  ).toBeVisible({ timeout: 20_000 });

  // Taken back: the screen's next call is refused, and the page stops it
  // and empties its frame.
  await row
    .getByRole("button", { name: "Take back the approval of ledger" })
    .click();
  await expect(row).toContainText("Approval taken back");
  await screen.getByRole("button", { name: "Load again" }).click();
  await expect(
    using.getByText(
      "The approval of this app's code was taken back, and the app was stopped."
    )
  ).toBeVisible();
  await expect(frame).not.toHaveAttribute("src");
});
