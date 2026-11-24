import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { connectAccount, mailboxAccount, outcome, someone } from "./connect.ts";
import {
  ceo,
  invoices,
  messageId,
  spoofedId,
  todoListIds,
} from "./fixtures/graph.ts";
import {
  audit,
  connected,
  connectedOwn,
  graph,
  graphPaths,
  listAs,
  mailboxPath,
  ownMailbox,
  providers,
  requests,
  taskIdOf,
} from "./microsoft-365-harness.ts";
import {
  callTool as call,
  claimedAgo,
  outputOf,
  toolError,
} from "./tool-calls.ts";
import type { Connection, Input } from "./tool-calls.ts";

const tasksRead = () =>
  graphPaths().filter((path) => path.endsWith("/tasks")).length;

/** Calls `action` for the person's own To Do. */
const todo = async (
  connection: Connection,
  action: string,
  input: Input,
  idempotencyKey?: string
) =>
  await outputOf(
    call(
      connection,
      action,
      { mailbox: ownMailbox(connection), ...input },
      {
        resource: ownMailbox(connection),
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      }
    )
  );

// The Microsoft 365 connector against Graph's recorded answers, through
// connect's real call path: capability, policy, a fresh isolate, the
// egress (which adds the token and holds each call to its routes), and
// back. Scoping comes first: a call for one mailbox or drive reaches only
// that one, by construction.

describe("the Microsoft 365 connector's To Do tools", () => {
  const followUp = {
    list: todoListIds.tasks,
    title: "Send Northwind the signed contract",
    note: "Promised in Tuesday's call.",
    due: "2026-10-30",
  };

  it("list only the person's own To Do lists", async () => {
    const connection = await connected();
    // Only the list that is theirs alone: neither the one they shared nor
    // the one shared with them.
    await expect(todo(connection, "todo.lists", {})).resolves.toStrictEqual({
      mailbox: ownMailbox(connection),
      lists: [
        { id: todoListIds.tasks, name: "Tasks", wellknownName: "defaultList" },
      ],
      nextPage: null,
    });
  });

  it("make a task in the person's own list with its due day, and complete it", async () => {
    const connection = await connected();
    const created = await todo(
      connection,
      "todo.create",
      followUp,
      "run-3:follow-up"
    );
    expect(created).toMatchObject({
      mailbox: ownMailbox(connection),
      listId: todoListIds.tasks,
      task: {
        title: followUp.title,
        status: "notStarted",
        due: { dateTime: "2026-10-30T12:00:00", timeZone: "UTC" },
        completedAt: null,
      },
    });
    const id = taskIdOf(created);
    const open = { list: todoListIds.tasks, openOnly: true };
    await expect(todo(connection, "todo.tasks", open)).resolves.toMatchObject({
      tasks: [{ id, title: followUp.title }],
    });
    await expect(
      todo(
        connection,
        "todo.complete",
        { list: todoListIds.tasks, task: id },
        "run-3:done"
      )
    ).resolves.toMatchObject({
      task: { id, status: "completed", completedAt: { timeZone: "UTC" } },
    });
    await expect(todo(connection, "todo.tasks", open)).resolves.toMatchObject({
      tasks: [],
    });
    await expect(
      todo(connection, "todo.tasks", { list: todoListIds.tasks })
    ).resolves.toMatchObject({ tasks: [{ id, status: "completed" }] });
  });

  it("refuse another person's To Do, and lists shared with or by the person", async () => {
    const connection = await connected();
    // A capability for a colleague's mailbox: Graph opens no To Do but the
    // token's own user's.
    await expect(
      toolError(
        call(connection, "todo.lists", { mailbox: ceo }, { resource: ceo })
      )
    ).resolves.toMatchObject({ error: { code: "access_denied" } });
    await expect(
      toolError(
        call(
          connection,
          "todo.create",
          { ...followUp, mailbox: ceo },
          { resource: ceo, idempotencyKey: "run-4:theirs" }
        )
      )
    ).resolves.toMatchObject({ error: { code: "access_denied" } });
    // A list shared either way reaches someone else: nothing is read,
    // made or completed in it.
    const calls: [string, Input][] = [
      todoListIds.sharedWithThem,
      todoListIds.sharedByThem,
    ].flatMap((list): [string, Input][] => [
      ["todo.tasks", { list }],
      ["todo.create", { ...followUp, list }],
      ["todo.complete", { list, task: "AAkALgAAAAAAHYQDEapmEc2b=" }],
    ]);
    const refusals = await Promise.all(
      calls.map(
        async ([action, input]) =>
          await toolError(
            call(
              connection,
              action,
              { mailbox: ownMailbox(connection), ...input },
              {
                resource: ownMailbox(connection),
                idempotencyKey: crypto.randomUUID(),
              }
            )
          )
      )
    );
    expect(refusals).toMatchObject(
      calls.map(() => ({ error: { code: "access_denied" } }))
    );
    expect(graph.writesDone()).toBe(0);
  });

  it("find a task whose answer was lost by the tag it carries, and never make it twice", async () => {
    const connection = await connected();
    // Older tasks fill Graph's first page, so the lost one is on a later
    // page.
    await Promise.all(
      ["one", "two", "three"].map(
        async (n) =>
          await todo(
            connection,
            "todo.create",
            { ...followUp, title: `Earlier follow-up ${n}` },
            `run-5:earlier-${n}`
          )
      )
    );
    graph.loseWriteAnswer();
    await expect(
      outcome(
        call(
          connection,
          "todo.create",
          { mailbox: ownMailbox(connection), ...followUp },
          {
            resource: ownMailbox(connection),
            idempotencyKey: "run-5:follow-up",
          }
        )
      )
    ).resolves.toBe("connect.outcome_unknown");
    await claimedAgo(connection);
    const found = await todo(
      connection,
      "todo.create",
      followUp,
      "run-5:follow-up"
    );
    await expect(
      todo(connection, "todo.create", followUp, "run-5:follow-up")
    ).resolves.toStrictEqual(found);
    expect(found).toMatchObject({ task: { title: followUp.title } });
    // The three earlier tasks and the lost one, each made once.
    expect(graph.writesDone()).toBe(4);
    const { tasks } = z
      .object({
        tasks: z.array(z.object({ id: z.string(), title: z.string() })),
      })
      .parse(await todo(connection, "todo.tasks", { list: todoListIds.tasks }));
    expect(
      tasks.filter(({ title }) => title === followUp.title).map(({ id }) => id)
    ).toStrictEqual([taskIdOf(found)]);
  });

  it("refuse a due day that doesn't exist before anything goes out", async () => {
    const connection = await connected();
    const sent = graph.sent.length;
    await expect(
      toolError(
        call(
          connection,
          "todo.create",
          { mailbox: ownMailbox(connection), ...followUp, due: "2026-02-30" },
          {
            resource: ownMailbox(connection),
            idempotencyKey: "run-7:follow-up",
          }
        )
      )
    ).resolves.toBe("Invalid input: custom at due");
    expect(graph.sent).toHaveLength(sent);
  });

  it("read no task of a list the person shared after its answer was lost", async () => {
    const connection = await connected();
    graph.loseWriteAnswer();
    await expect(
      outcome(
        call(
          connection,
          "todo.create",
          { mailbox: ownMailbox(connection), ...followUp },
          {
            resource: ownMailbox(connection),
            idempotencyKey: "run-6:follow-up",
          }
        )
      )
    ).resolves.toBe("connect.outcome_unknown");
    await claimedAgo(connection);
    graph.shareList(todoListIds.tasks);
    const before = tasksRead();
    await expect(
      outcome(
        call(
          connection,
          "todo.create",
          { mailbox: ownMailbox(connection), ...followUp },
          {
            resource: ownMailbox(connection),
            idempotencyKey: "run-6:follow-up",
          }
        )
      )
    ).resolves.toBe("connect.outcome_unknown");
    // The list is no longer the person's alone: the task isn't looked for
    // in it, so the outcome stays unknown. Only the POST that made the task
    // went to its tasks, before the list was shared.
    expect(tasksRead()).toBe(before);
  });
});

describe("the Microsoft 365 connector's answers", () => {
  it("free a move's key when a lookup before it is throttled, so a retry moves once", async () => {
    const { connection, own } = await connectedOwn();
    const move = async () =>
      await outcome(
        call(
          connection,
          "mail.move",
          {
            mailbox: own,
            message: messageId(own, 1),
            destination: "archive",
          },
          { idempotencyKey: "run-8:move-lookup" }
        )
      );
    // The first request, the lookup, is throttled: nothing is moved.
    graph.throttle();
    const outcomes = [await move(), await move(), await move()];
    expect(outcomes).toStrictEqual(["connect.server_unavailable", "ok", "ok"]);
    expect(graph.writesDone()).toBe(1);
  });

  it("never take a provider's answer for connect's egress's own", async () => {
    const connection = await connected();
    // Graph's 404 carries `grasp-egress: refused`: the egress drops it,
    // and the connector reports Graph's answer.
    await expect(
      toolError(
        call(connection, "mail.get", { mailbox: invoices, message: spoofedId })
      )
    ).resolves.toMatchObject({ error: { code: "not_found" } });
  });

  it("free a throttled move's key after the lookups before it, reads", async () => {
    const { connection, own } = await connectedOwn();
    const move = async () =>
      await outcome(
        call(
          connection,
          "mail.move",
          {
            mailbox: own,
            message: messageId(own, 1),
            destination: "archive",
          },
          { idempotencyKey: "run-8:move" }
        )
      );
    graph.throttleWrite();
    const outcomes = [await move(), await move(), await move()];
    expect(outcomes).toStrictEqual(["connect.server_unavailable", "ok", "ok"]);
    expect(graph.writesDone()).toBe(1);
  });

  it("refuse a mailbox that is a dot segment before anything goes out", async () => {
    const connection = await connected();
    const outcomes = await Promise.all(
      [".", ".."].map(
        async (mailbox) =>
          await toolError(call(connection, "mail.list", { mailbox }))
      )
    );

    // Refused as input, naming the mailbox.
    expect(
      outcomes.map((refusal) => JSON.stringify(refusal).includes("mailbox"))
    ).toStrictEqual([true, true]);
    expect(graph.sent).toStrictEqual([]);
  });

  it("tell a request connect's egress refused from one Graph refused", async () => {
    const connection = await connected();
    // `..` is a Graph ID's alphabet, but a dot segment in a path: the
    // request that goes out isn't one of the tool's routes.
    await expect(
      toolError(
        call(connection, "mail.get", { mailbox: invoices, message: ".." })
      )
    ).resolves.toMatchObject({ error: { code: "egress_refused" } });
    expect(graph.sent).toStrictEqual([]);
  });
});

/** The write requests that reached Graph. */
const writesSent = (): number =>
  requests().filter(({ method }) => method !== "GET").length;

describe("the Microsoft 365 connector's writes whose outcome can't be confirmed", () => {
  const email = {
    mailbox: invoices,
    subject: "Payment of invoice 2026-0041",
    body: "Paid today.",
    to: ["billing@northwind.example.org"],
  };

  const draft = async (connection: Connection, key: string): Promise<string> =>
    await outcome(
      call(connection, "mail.createDraft", email, {
        resource: invoices,
        idempotencyKey: key,
      })
    );

  it("say an email Graph sent is of unknown outcome when its answer was lost, and never send it again", async () => {
    const connection = await connected();
    const send = async () =>
      await outcome(
        call(connection, "mail.send", email, {
          resource: invoices,
          idempotencyKey: "run-9:send-receipt",
        })
      );
    // Graph sends it; its answer never arrives.
    graph.loseWriteAnswer();
    const outcomes = [await send(), await send(), await send()];
    expect(outcomes).toStrictEqual([
      "connect.outcome_unknown",
      "connect.outcome_unknown",
      "connect.outcome_unknown",
    ]);
    expect(graph.writesDone()).toBe(1);
    expect(writesSent()).toBe(1);
    // Recorded as of unknown outcome, never as a failure a caller could
    // take for "nothing was sent"; the repeats as repeats, not sends.
    const audited = await audit.events();
    const details = audited
      .filter(({ action }) => action === "connection.call")
      .map(({ detail }) => detail);
    expect(details).toMatchObject([
      { outcome: "unknown", reason: "connect.outcome_unknown" },
      { outcome: "unknown", reason: "connect.outcome_unknown", replayed: true },
      { outcome: "unknown", reason: "connect.outcome_unknown", replayed: true },
    ]);
    expect(details[0]?.replayed).toBeUndefined();
  });

  it("say a write Graph answered with a server error is of unknown outcome, but one it refused failed", async () => {
    const connection = await connected();
    const outcomes: string[] = [];
    for (const status of [500, 502, 503, 504]) {
      graph.failWrite(status);
      // The same key twice: Graph fails the first write only.
      outcomes.push(
        // oxlint-disable-next-line no-await-in-loop -- one write failed at a time
        await draft(connection, `run-9:draft-${status}`),
        // oxlint-disable-next-line no-await-in-loop -- one write failed at a time
        await draft(connection, `run-9:draft-${status}`)
      );
    }
    // A refusal says nothing was made: the action failed, for good.
    graph.failWrite(400, { error: { code: "ErrorInvalidRecipients" } });
    outcomes.push(
      await draft(connection, "run-9:draft-400"),
      await draft(connection, "run-9:draft-400")
    );
    expect(outcomes).toStrictEqual([
      ...Array.from({ length: 8 }, () => "connect.outcome_unknown"),
      "connect.action_failed",
      "connect.action_failed",
    ]);
    // Each key reached Graph once.
    expect(writesSent()).toBe(5);
  });

  it("say a draft Graph made is of unknown outcome when its answer can't be read", async () => {
    const connection = await connected();
    // Graph made it, and its answer isn't a draft the connector can read.
    graph.failWrite(201, { value: "not a message" });
    await expect(draft(connection, "run-9:draft-unreadable")).resolves.toBe(
      "connect.outcome_unknown"
    );
    await expect(draft(connection, "run-9:draft-unreadable")).resolves.toBe(
      "connect.outcome_unknown"
    );
    expect(writesSent()).toBe(1);
  });
});

describe("a chat agent's Microsoft 365 mail call", () => {
  it("reaches its person's own mailbox, and a shared one only once pointed at for them", async () => {
    const connection = await connected();
    const ends = {
      own: await listAs(connection, connection.person.email.toUpperCase(), []),
      shared: await listAs(connection, invoices, []),
      anotherPointed: await listAs(connection, invoices, [ceo]),
    };
    const reachedShared = graphPaths().some((path) =>
      path.startsWith(mailboxPath)
    );
    expect({ ...ends, reachedShared }).toStrictEqual({
      own: "ok",
      shared: "connect.mailbox_not_pointed",
      anotherPointed: "connect.mailbox_not_pointed",
      reachedShared: false,
    });
    await expect(listAs(connection, invoices, [invoices])).resolves.toBe("ok");
  });

  it("takes a shared connection's own mailbox as the company's, which needs pointing at too", async () => {
    const admin = someone("admin");
    const account = mailboxAccount();
    const id = await connectAccount(providers, admin, account, {
      scope: "shared",
    });
    const connection = { id, person: admin };
    await expect(listAs(connection, account.email, [])).resolves.toBe(
      "connect.mailbox_not_pointed"
    );
    await expect(
      listAs(connection, account.email, [account.email])
    ).resolves.toBe("ok");
  });
});
