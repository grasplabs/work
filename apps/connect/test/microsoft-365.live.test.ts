/**
 * The Microsoft 365 connector against a real test tenant: skipped unless
 * the environment names one. It runs connect's whole call path (policy, a
 * fresh isolate, the egress with its allowlist and SharePoint download
 * redirect) against Graph itself, with a token taken as is.
 *
 * To run it, get a delegated Graph access token for a test tenant's user,
 * with the connector's scopes (User.Read, Mail.ReadWrite,
 * Mail.ReadWrite.Shared, Mail.Send, Mail.Send.Shared, MailboxSettings.Read,
 * Calendars.Read, Calendars.ReadWrite, Calendars.Read.Shared, Files.Read.All,
 * Sites.Read.All; Graph Explorer gives one), then, from the repo root:
 *
 *   M365_SMOKE_ACCESS_TOKEN=<token> \
 *   M365_SMOKE_MAILBOX=<a mailbox the user may read, e.g. a shared one> \
 *   M365_SMOKE_DRIVE=<a drive with a file at its top: its ID, from
 *     GET /me/drive or GET /sites/{site}/drive> \
 *   vp test run --project @grasp-os/connect test/microsoft-365.live.test.ts
 *
 * Add M365_SMOKE_WRITES=1 to also create a draft in the mailbox, try to
 * move it to a folder of another mailbox (refused), and move it to Deleted
 * Items. A move works only in the user's own mailbox, so for the writes
 * M365_SMOKE_MAILBOX must be the user's own. M365_SMOKE_FOREIGN_FOLDER
 * names that other folder: say, a shared mailbox's Inbox's ID. Never point
 * it at a client's tenant.
 *
 * M365_SMOKE_OWN_MAILBOX, the token's user's own address, also puts an
 * event in their calendar a week from now, with nobody invited, and moves
 * it by an hour; it stays there, titled "Grasp OS smoke test". With it,
 * free time is looked for in that calendar.
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { outcome } from "./connect.ts";
import { smokeConnection, smokeRun as run } from "./smoke.ts";

const smoke = z
  .object({
    M365_SMOKE_ACCESS_TOKEN: z.string().min(1),
    M365_SMOKE_MAILBOX: z.string().min(1),
    M365_SMOKE_DRIVE: z.string().min(1),
    M365_SMOKE_WRITES: z.literal("1").optional(),
    M365_SMOKE_FOREIGN_FOLDER: z.string().min(1).optional(),
    M365_SMOKE_OWN_MAILBOX: z.string().min(1).optional(),
  })
  .safeParse(env);

describe.runIf(smoke.success)("Microsoft 365, live", () => {
  const config = smoke.data;
  /** A shared connection holding the token, as OAuth would leave one. */
  const connection = async (): Promise<string> =>
    await smokeConnection(
      "microsoft",
      "microsoft-365",
      config?.M365_SMOKE_ACCESS_TOKEN ?? ""
    );

  it("reads mail, a calendar and files, and pages through mail", async () => {
    const id = await connection();
    const mailbox = config?.M365_SMOKE_MAILBOX ?? "";
    const drive = config?.M365_SMOKE_DRIVE ?? "";
    const mail = await run(
      id,
      "users.messages.list",
      { mailbox, top: 2 },
      mailbox
    );
    expect(mail).toHaveProperty("items");
    if (typeof mail.next === "string") {
      await run(
        id,
        "users.messages.list",
        { mailbox, top: 2, next: mail.next },
        mailbox
      );
    }
    const now = Date.now();
    await run(
      id,
      "users.calendarView.list",
      {
        mailbox,
        startDateTime: new Date(now).toISOString(),
        endDateTime: new Date(now + 7 * 24 * 3600 * 1000).toISOString(),
      },
      mailbox
    );
    const files = z
      .object({
        items: z.array(
          z.object({ id: z.string(), file: z.object({}).nullish() })
        ),
      })
      .parse(await run(id, "drives.root.children.list", { drive }, drive));
    // The drive's top folder must hold a file: it is read through Graph's
    // redirect to SharePoint.
    const item = files.items.find(({ file }) => file)?.id ?? "";
    await expect(
      run(
        id,
        "drives.items.content.download",
        { drive, item, as: "base64" },
        drive
      )
    ).resolves.toMatchObject({ id: item, encoding: "base64" });
  });

  it.runIf(config?.M365_SMOKE_WRITES === "1")(
    "creates a draft, and moves it to Deleted Items but not another mailbox",
    async () => {
      const id = await connection();
      const mailbox = config?.M365_SMOKE_MAILBOX ?? "";
      const key = crypto.randomUUID();
      const draft = await run(
        id,
        "users.messages.create",
        {
          mailbox,
          subject: "Grasp OS smoke test",
          body: {
            content: "Created and removed by the connector's smoke test.",
          },
          toRecipients: [{ emailAddress: { address: mailbox } }],
        },
        mailbox,
        `${key}:draft`
      );
      const foreign =
        config?.M365_SMOKE_FOREIGN_FOLDER ?? "AAMkAGNoSuchFolderInThisMailbox=";
      await expect(
        outcome(
          run(
            id,
            "me.messages.move.create",
            { message: String(draft.id), destinationId: foreign },
            undefined,
            `${key}:move-away`
          )
        )
      ).resolves.toBe("connect.action_failed");
      // Still where it was: the move below starts from the same ID.
      await expect(
        run(
          id,
          "me.messages.move.create",
          { message: String(draft.id), destinationId: "deleteditems" },
          undefined,
          `${key}:move`
        )
      ).resolves.toHaveProperty("id");
    }
  );

  it.runIf(config?.M365_SMOKE_OWN_MAILBOX !== undefined)(
    "puts an event in the user's own calendar with nobody invited, and moves it",
    async () => {
      const id = await connection();
      const mailbox = config?.M365_SMOKE_OWN_MAILBOX ?? "";
      const key = crypto.randomUUID();
      const day = new Date(Date.now() + 7 * 24 * 3600 * 1000)
        .toISOString()
        .slice(0, "2026-10-26".length);
      const timeZone = "Europe/Amsterdam";
      const made = z.object({ id: z.string() }).parse(
        await run(
          id,
          "users.events.create",
          {
            mailbox,
            subject: "Grasp OS smoke test",
            start: { dateTime: `${day}T14:00`, timeZone },
            end: { dateTime: `${day}T15:00`, timeZone },
          },
          mailbox,
          `${key}:create`
        )
      );
      await expect(
        run(id, "users.events.get", { mailbox, event: made.id }, mailbox)
      ).resolves.toMatchObject({ attendees: [] });
      await expect(
        run(
          id,
          "users.events.update",
          {
            mailbox,
            event: made.id,
            start: { dateTime: `${day}T15:00`, timeZone },
            end: { dateTime: `${day}T16:00`, timeZone },
          },
          mailbox,
          `${key}:update`
        )
      ).resolves.toMatchObject({
        start: { dateTime: `${day}T15:00:00.0000000`, timeZone },
      });
    }
  );

  it.runIf(config?.M365_SMOKE_OWN_MAILBOX !== undefined)(
    "reads the user's own calendar view",
    async () => {
      const id = await connection();
      const day = new Date(Date.now() + 7 * 24 * 3600 * 1000)
        .toISOString()
        .slice(0, "2026-10-26".length);
      const range = {
        startDateTime: `${day}T00:00:00Z`,
        endDateTime: `${day}T23:59:00Z`,
      };
      await expect(
        run(id, "me.calendarView.list", range)
      ).resolves.toHaveProperty("items");
    }
  );
});
