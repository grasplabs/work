/**
 * The v1 App server, for the tests of what only it does: its call queue,
 * its caller tokens and the bindings it reaches App code through, and,
 * until GRA-656's last slice moves them, the run tests on their own
 * servers. GRA-645 removes the v1 server, and this with it.
 */
import { release } from "./apps.ts";

/** Someone signed in, with their API. */
type Builder = Parameters<typeof release>[0];

/**
 * The v1 sample server: purchase orders, a ledger that books each
 * entry once per idempotency key, counters that show how often a step
 * really ran, and statistics points, recorded around a mail, by name, or
 * once a held search is let go.
 */
export const v1Server = `import { DurableObject } from "cloudflare:workers";

type Caller = { userId: string; idempotencyKey?: string };

export class App extends DurableObject {
  hit(_caller: Caller, name: string): number {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS hits (name TEXT PRIMARY KEY, count INTEGER NOT NULL)");
    this.ctx.storage.sql.exec("INSERT INTO hits VALUES (?, 1) ON CONFLICT (name) DO UPDATE SET count = count + 1", name);
    return this.hits(_caller, name);
  }

  hits(_caller: Caller, name: string): number {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS hits (name TEXT PRIMARY KEY, count INTEGER NOT NULL)");
    const [row] = this.ctx.storage.sql.exec("SELECT count FROM hits WHERE name = ?", name).toArray();
    return Number(row?.count ?? 0);
  }

  // Takes \`ms\` milliseconds, holding the App's turn meanwhile.
  async pause(_caller: Caller, ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  purchaseOrder(_caller: Caller, number: string): { amount: number } | null {
    return number === "PO-1" ? { amount: 800_000 } : null;
  }

  book(caller: Caller, entry: { invoice: string; total: number }, key: string): string {
    this.hit(caller, "book:" + key);
    return "ledger-" + entry.invoice + "-for-" + caller.userId;
  }

  // Mails the invoice with the caller's key, or with a key of its own.
  async mail(caller: Caller, ownKey: boolean): Promise<unknown> {
    const idempotencyKey = ownKey ? crypto.randomUUID() : caller.idempotencyKey;
    try {
      const { output } = await (this.env as any).MAIL.call(
        caller,
        "mail.send",
        { to: "ben@acme.test", subject: "Invoice INV-7" },
        { idempotencyKey }
      );
      return JSON.parse(output);
    } catch (error) {
      return { refused: (error as { code?: string }).code };
    }
  }

  // Records two points alike of the App's statistics, mails the invoice,
  // and records a third once the mail was sent.
  async mailCounted(caller: Caller): Promise<unknown> {
    const stats = (this.env as any).STATISTICS;
    await stats.record(caller, { measure: "mails", value: 1 });
    await stats.record(caller, { measure: "mails", value: 1 });
    const sent = await this.mail(caller, false);
    if (!("refused" in (sent as object))) {
      await stats.record(caller, { measure: "sent", value: 1 });
    }
    return sent;
  }

  // How many points of \`measure\` the App's statistics hold of today
  // and yesterday: a run that crosses midnight counts the same.
  async points(caller: Caller, measure: string): Promise<number> {
    const { groups } = await (this.env as any).STATISTICS.read(caller, { measure, days: 2 });
    return groups[0]?.count ?? 0;
  }

  // Records a point of each of \`measures\`, in that order.
  async point(caller: Caller, ...measures: string[]): Promise<void> {
    for (const measure of measures) {
      await (this.env as any).STATISTICS.record(caller, { measure, value: 1 });
    }
  }

  // Waits at the mail server, its search naming its caller's token, until
  // the test lets it go, then counts \`parked:done\`.
  async parkAtMail(caller: Caller): Promise<void> {
    await (this.env as any).MAIL.call(caller, "mail.search", { query: "hold " + ((caller as { token?: string }).token ?? "") });
    this.hit(caller, "parked:done");
  }

  // Waits at the mail server, which holds its search until the test lets
  // it go (MAIL, granted \`mail.search\`), then records a point of
  // \`measure\`, and counts whether the call was taken
  // (\`measure\`:recorded) or refused, the search's answer or the point.
  async pointAfter(caller: Caller, measure: string): Promise<void> {
    try {
      await (this.env as any).MAIL.call(caller, "mail.search", { query: "hold " + measure });
    } catch {
      this.hit(caller, measure + ":refused");
      return;
    }
    try {
      await this.point(caller, measure);
      this.hit(caller, measure + ":recorded");
    } catch {
      this.hit(caller, measure + ":refused");
    }
  }
}
`;

/** A new App of `builder`'s with the v1 sample server and `files`, current. */
export const v1AppWith = async (
  builder: Builder,
  files: Record<string, string>
): Promise<string> => {
  const { id } = await builder.api.apps.create({ name: "Invoices" });
  await release(builder, id, { "app/server.ts": v1Server, ...files });
  return id;
};
