import { sha256HexOfBytes } from "@grasp-os/shared/encoding";
import {
  mailFromHeader,
  mailIngressPath,
  mailSentAtHeader,
  mailSha256Header,
  mailSignatureHeader,
  mailSizeHeader,
  mailToHeader,
  signMail,
} from "@grasp-os/shared/mail-ingress";
import type { SignedMail } from "@grasp-os/shared/mail-ingress";
import type { Role } from "@grasp-os/shared/roles";
import { routerSecretHeader } from "@grasp-os/shared/router";
import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import worker from "../src/index.ts";
import { intake, invoiceMail, readByRun, runsOf } from "./email-triggers.ts";
import { mockIdp } from "./idp.ts";
import { endLiveRuns } from "./runs.ts";
import { clientOrigin } from "./sign-in-config.ts";
import { signedInApi } from "./sign-in.ts";
import { appWith } from "./workflow-apps.ts";

// Mail the router's mail sorter posts to core's raw-mail ingress, signed,
// which starts runs as mail from Email Routing does (email-triggers.ts).

const idp = mockIdp();

const personApi = async (role: Role) => await signedInApi(idp, role);

/**
 * How a delivery to the raw-mail ingress is sent: signed with `secret`
 * (core's router secret unless said) for `signed`, which is what's sent
 * unless a test sends something else than it signed.
 */
interface Posting {
  secret?: string;
  signed?: Partial<SignedMail>;
  sent?: Partial<SignedMail>;
  body?: string;
  changes?: Partial<Env>;
  /** Leave the signature out. */
  unsigned?: boolean;
}

/**
 * Posts `raw` for `to` to core's raw-mail ingress, as the router's mail
 * sorter does: through the router-secret check, signed for its recipient,
 * sender, hash, size and time.
 */
const post = async (
  to: string,
  raw: string,
  posting: Posting = {}
): Promise<Response> => {
  const bytes = new TextEncoder().encode(raw);
  const mail: SignedMail = {
    to,
    from: "bounces@acme.test",
    sha256: await sha256HexOfBytes(bytes),
    size: bytes.byteLength,
    sentAt: new Date().toISOString(),
    ...posting.signed,
  };
  const sent = { ...mail, ...posting.sent };
  const signature = await signMail(posting.secret ?? env.ROUTER_SECRET, mail);
  return await worker.fetch(
    new Request(`https://core${mailIngressPath}`, {
      method: "POST",
      headers: {
        [routerSecretHeader]: env.ROUTER_SECRET,
        [mailToHeader]: sent.to,
        [mailFromHeader]: sent.from,
        [mailSha256Header]: sent.sha256,
        [mailSizeHeader]: String(sent.size),
        [mailSentAtHeader]: sent.sentAt,
        ...(posting.unsigned === true
          ? {}
          : { [mailSignatureHeader]: signature }),
      },
      body: posting.body ?? raw,
    }),
    { ...env, ...posting.changes },
    createExecutionContext()
  );
};

/**
 * The client's own mail domain: its hostname, which the router sorts mail
 * to it by.
 */
const own = new URL(clientOrigin).hostname;

/** The time `n` minutes from now, ISO 8601. */
const minutes = (n: number): string =>
  new Date(Date.now() + n * 60_000).toISOString();

describe("mail posted to core's raw-mail ingress", () => {
  afterEach(endLiveRuns);

  it("starts a run as mail from Email Routing does", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, intake("posted"));

    const response = await post(`posted@${own}`, invoiceMail());
    const read = await readByRun(builder, app);

    expect(response.status).toBe(202);
    expect(read).toMatchObject({
      from: "ben@acme.test",
      subject: "Invoice INV-7",
      attachments: ["inv-7.pdf:5"],
    });
  });

  it("answers a bounce with core's reason", async () => {
    const response = await post(`nobody-here@${own}`, invoiceMail());

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toStrictEqual({
      reason: "No such address.",
    });
  });

  it("takes the previous router secret's signature only while rotating", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, intake("rotated"));
    const previous = "previous-router-secret";

    const before = await post(`rotated@${own}`, invoiceMail(), {
      secret: previous,
    });
    const rotating = await post(`rotated@${own}`, invoiceMail(), {
      secret: previous,
      changes: { ROUTER_SECRET_PREVIOUS: previous },
    });

    expect([before.status, rotating.status]).toStrictEqual([403, 202]);
    await expect(runsOf(builder, app)).resolves.toHaveLength(1);
  });

  it("refuses a delivery that isn't signed for exactly what it carries, and starts nothing", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, intake("guarded"));
    const to = `guarded@${own}`;
    const mail = invoiceMail();
    // Same length, other bytes: what a message swapped on the way looks like.
    const swapped = mail.replace("Friday", "Monday");

    const refusals = {
      // The router secret alone: any public request through the router.
      unsigned: await post(to, mail, { unsigned: true }),
      otherKey: await post(to, mail, { secret: "another-client-secret" }),
      // Signed for one address, sent to another.
      otherRecipient: await post(`someone-else@${own}`, mail, {
        sent: { to },
      }),
      otherSender: await post(to, mail, {
        sent: { from: "ceo@acme.test" },
      }),
      otherBody: await post(to, mail, { body: swapped }),
      shorterBody: await post(to, mail, { body: mail.slice(0, -10) }),
      stale: await post(to, mail, {
        signed: { sentAt: minutes(-10) },
      }),
      ahead: await post(to, mail, { signed: { sentAt: minutes(10) } }),
      notConfigured: await post(to, mail, {
        changes: { ROUTER_SECRET: "" },
        secret: "",
      }),
    };

    expect(
      Object.fromEntries(
        Object.entries(refusals).map(([name, response]) => [
          name,
          response.status,
        ])
      )
    ).toStrictEqual(
      Object.fromEntries(Object.keys(refusals).map((name) => [name, 403]))
    );
    await expect(runsOf(builder, app)).resolves.toHaveLength(0);
  });

  it("takes mail for the client's own domain however its case or end is written, as the router sorts it", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, intake("folded"));

    const statuses = [
      await post(`Folded@${own.toUpperCase()}`, invoiceMail()),
      await post(`folded@${own}.`, invoiceMail({ subject: "Invoice INV-8" })),
    ].map(({ status }) => status);

    expect(statuses).toStrictEqual([202, 202]);
    await expect(runsOf(builder, app)).resolves.toHaveLength(2);
  });

  it("bounces signed mail for any domain but the client's own, so a wrong route in the router delivers nothing, and logs no address", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, intake("sorted"));
    const warned = vi.spyOn(console, "warn");
    // The router's map sending another client's mail here, and domains
    // that only look like this client's.
    const recipients = [
      "sorted@other.grasp.test",
      "sorted@grasp.test",
      `sorted@mail.${own}`,
      `sorted@${own}.evil.test`,
      `sorted@evil-${own}`,
      `sorted@${own}..`,
      // A Cyrillic look-alike, as punycode: header values are ASCII.
      "sorted@xn--cme-5cd.grasp.test",
      // One recipient per delivery: a list is one address, whose domain
      // follows its last @, and whose local part receives nothing.
      `sorted@${own},sorted@other.grasp.test`,
      `sorted@other.grasp.test,sorted@${own}`,
      "sorted",
      `@${own}`,
    ];

    try {
      const answers = await Promise.all(
        recipients.map(async (to) => {
          // The envelope recipient is what's checked: the To header says
          // whatever the sender wrote.
          const response = await post(to, invoiceMail({ to: `sorted@${own}` }));
          return [to, response.status, await response.json()];
        })
      );

      expect(answers).toStrictEqual(
        recipients.map((to) => [to, 422, { reason: "No such address." }])
      );
      await expect(runsOf(builder, app)).resolves.toHaveLength(0);
      expect(warned).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "mail.ingress_refused",
          reason: "foreign_recipient",
        })
      );
      expect(JSON.stringify(warned.mock.calls)).not.toContain("grasp.test");
    } finally {
      warned.mockRestore();
    }
  });

  it("refuses mail, for the router to try again, while the deployment has no hostname of its own", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, intake("unset"));

    const response = await post(`unset@${own}`, invoiceMail(), {
      changes: { SIGN_IN: undefined },
    });

    expect(response.status).toBe(403);
    await expect(runsOf(builder, app)).resolves.toHaveLength(0);
  });
});
