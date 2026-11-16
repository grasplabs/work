import { applyOutput } from "@grasp-os/shared/chat";
import type { ChatOutput, ChatUpdate } from "@grasp-os/shared/chat";
import { chatIdSchema } from "@grasp-os/shared/ids";
import { redact } from "@grasp-os/shared/redact";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  codeLimits,
  cutMarker,
  cutToBytes,
  utf8Bytes,
} from "../src/code-mode.ts";
import { codeResults, codeStep, says, testRunOpening } from "./agent-chat.ts";
import {
  chatsWith,
  runRecords,
  toolCallIds,
  watchOutput,
} from "./agent-code-runs.ts";
import { mockIdp } from "./idp.ts";

// A chat's agent, through the Workspace object: the loop, the code it runs
// in isolates of their own, and the model gateway, all real (agent-chat.ts).

const idp = mockIdp();

const { newChat } = chatsWith(idp);

describe("chat agent code output", () => {
  it("streams what the code logs to the chat before its step ends, redacted, and drops it once the step's result is stored", async () => {
    const { stub, chat, personId, ask } = await newChat(
      codeStep(
        "export default async () => { console.log('first'); console.log('key Bearer abcdefghijklmnopqrstuvwxyz0123'); await scheduler.wait(1_500); console.log('after the wait'); return 'done'; };"
      ),
      says("Done.")
    );
    // Put together as the page does, noting what showed before the result.
    let output: ChatOutput | null = null;
    const seen: { output: ChatOutput | null; result: boolean }[] = [];
    await stub.watch(chat.id, personId, null, async (update: ChatUpdate) => {
      output = applyOutput(output, update.output);
      seen.push({
        output,
        result: update.messages.some(({ role }) => role === "result"),
      });
      await Promise.resolve();
    });

    await ask("Log it.");

    const [callId] = await toolCallIds(stub, chat.id);
    await vi.waitFor(() => {
      expect(seen.at(-1)?.output).toBeNull();
    });
    const firstResult = seen.findIndex(({ result }) => result);
    const before = seen.slice(0, firstResult).map((step) => step.output);
    expect(before).toContainEqual({
      callId,
      text: "first\nkey [redacted]",
    });
    // What the model reads is redacted the same way.
    await expect(codeResults(stub, chat.id)).resolves.toStrictEqual([
      {
        isError: false,
        text: "Logs:\nfirst\nkey [redacted]\nafter the wait\n\nReturned:\ndone",
      },
    ]);

    // A line that comes after the run closed shows nowhere.
    const [record] = await runRecords(stub, chat.id);
    const shown = seen.length;
    await stub.codeRunOutput(
      chatIdSchema.parse(chat.id),
      String(record?.id),
      callId ?? "",
      "late"
    );
    await scheduler.wait(200);
    expect(seen.slice(shown).some((step) => step.output !== null)).toBeFalsy();
  });

  it("redacts a private key the code logs line by line, in the chat and for the model", async () => {
    const { stub, chat, personId, ask } = await newChat(
      codeStep(
        "export default async () => { for (const line of ['-----BEGIN PRIVATE KEY-----', 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC', 'BKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj', '-----END PRIVATE KEY-----', 'done']) { console.log(line); await scheduler.wait(1_100); } };"
      ),
      says("Done.")
    );
    const { seen } = await watchOutput(stub, chat.id, personId);

    await ask("Log it.");

    const streamed = seen.flatMap(({ output }) =>
      output === null ? [] : [output.text]
    );
    expect(streamed.length).toBeGreaterThan(0);
    expect(streamed.some((text) => /MIIE|BKcw/u.test(text))).toBeFalsy();
    await expect(codeResults(stub, chat.id)).resolves.toStrictEqual([
      { isError: false, text: "Logs:\n[redacted]\ndone" },
    ]);
  });

  it("redacts whole credential values in what streams and in what is kept", async () => {
    const { stub, chat, personId, ask } = await newChat(
      codeStep(
        `export default async () => { console.log("authorization: Basic dXNlcjpwYXNz"); console.log('password: "correct horse battery staple"'); await scheduler.wait(1_500); return 'done'; };`
      ),
      says("Done.")
    );
    const { seen } = await watchOutput(stub, chat.id, personId);

    await ask("Log it.");

    const streamed = seen.flatMap(({ output }) =>
      output === null ? [] : [output.text]
    );
    expect(streamed).toContain(
      'authorization: [redacted]\npassword: "[redacted]"'
    );
    expect(
      streamed.some((text) => /dXNlcjpwYXNz|horse|battery/u.test(text))
    ).toBeFalsy();
    await expect(codeResults(stub, chat.id)).resolves.toStrictEqual([
      {
        isError: false,
        text: 'Logs:\nauthorization: [redacted]\npassword: "[redacted]"\n\nReturned:\ndone',
      },
    ]);
  });

  it("tells a new watch what output there is in its first update, none included", async () => {
    const { stub, chat, personId } = await newChat();
    const first = Promise.withResolvers<ChatUpdate>();
    await stub.watch(chat.id, personId, null, async (update: ChatUpdate) => {
      first.resolve(update);
      await Promise.resolve();
    });

    // Explicitly none, so a page that had output from an earlier watch
    // (before a reconnect) drops it, rather than keep it as unchanged.
    const update = await first.promise;
    expect(Object.hasOwn(update, "output")).toBeTruthy();
    expect(update.output).toBeNull();
  });

  it("takes no more lines of a run than one may log, whatever is sent", async () => {
    const { stub, chat, personId } = await newChat();
    const chatId = chatIdSchema.parse(chat.id);
    const run = await stub.openCodeRun(
      chatId,
      crypto.randomUUID(),
      testRunOpening
    );
    const { latest } = await watchOutput(stub, chat.id, personId);

    for (let line = 0; line < codeLimits.logLines + 500; line += 1) {
      // oxlint-disable-next-line no-await-in-loop -- in order, as a run sends them
      await stub.codeRunOutput(chatId, run, "call_test", `line ${line}`);
    }

    // Every line it may log, then the marker that more was cut.
    await vi.waitFor(
      () => {
        const text = latest()?.text ?? "";
        expect(text.endsWith(cutMarker)).toBeTruthy();
        expect(text.slice(0, -cutMarker.length).split("\n")).toHaveLength(
          codeLimits.logLines
        );
      },
      { timeout: 10_000, interval: 100 }
    );
  });

  it.each([
    ["a character of three bytes", "漢".repeat(65_536)],
    ["a character of four bytes", "😀".repeat(40_000)],
  ])(
    "shows what fits of a line too large for its bytes, %s, never half a character, and says it was cut",
    async (_, line) => {
      const { stub, chat, personId } = await newChat();
      const chatId = chatIdSchema.parse(chat.id);
      const run = await stub.openCodeRun(
        chatId,
        crypto.randomUUID(),
        testRunOpening
      );
      const { latest } = await watchOutput(stub, chat.id, personId);

      await stub.codeRunOutput(chatId, run, "call_test", line);
      await stub.codeRunOutput(chatId, run, "call_test", "after the cut");

      await vi.waitFor(
        () => {
          expect(latest()?.text.endsWith(cutMarker)).toBeTruthy();
        },
        { timeout: 10_000, interval: 100 }
      );
      const text = latest()?.text ?? "";
      const shown = text.slice(0, -cutMarker.length);
      expect({
        prefix: line.startsWith(shown),
        some: shown.length > 1000,
        loneSurrogate:
          /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
            shown
          ),
        within:
          utf8Bytes(text) <=
          codeLimits.outputBytes - codeLimits.diagnosticBytes,
        after: text.includes("after the cut"),
      }).toStrictEqual({
        prefix: true,
        some: true,
        loneSurrogate: false,
        within: true,
        after: false,
      });
    }
  );

  it("shares one output budget between logs and result, and keeps room for how the run ended", async () => {
    const { stub, chat, personId, ask } = await newChat(
      codeStep(
        "export default async () => { for (let i = 0; i < 5_000; i++) console.log('é'.repeat(200)); await scheduler.wait(1_500); throw new Error('the end'); };"
      ),
      says("Done.")
    );
    let output: ChatOutput | null = null;
    let longest = 0;
    await stub.watch(chat.id, personId, null, async (update: ChatUpdate) => {
      output = applyOutput(output, update.output);
      longest = Math.max(longest, utf8Bytes(output?.text ?? ""));
      await Promise.resolve();
    });

    await ask("Flood it.");

    const [result] = await codeResults(stub, chat.id);
    const text = result?.text ?? "";
    expect({
      within: utf8Bytes(text) <= codeLimits.outputBytes,
      cut: text.includes(cutMarker),
      ending: /\n\nError \(threw\):\nError: the end/u.test(text),
      streamed:
        longest > 0 &&
        longest <= codeLimits.outputBytes - codeLimits.diagnosticBytes,
    }).toStrictEqual({ within: true, cut: true, ending: true, streamed: true });
  });

  it("redacts a whole credential value: a short Basic one, and a quoted one with spaces", () => {
    expect(
      [
        "authorization: Basic dXNlcjpwYXNz",
        "Authorization: Basic YQ==",
        'password: "correct horse battery staple"',
        "secret='two words' and more",
        '{"password":"a b c","user":"ann"}',
        'token: "never closed',
        '{"access_token":"ya29.abc","client_secret":"shh"}',
        String.raw`"{\"password\":\"hunter2\",\"user\":\"ann\"}"`,
        String.raw`"{\"refresh_token\":\"1//abc def\"}"`,
        String.raw`password=abc\def next`,
      ].map(redact)
    ).toStrictEqual([
      "authorization: [redacted]",
      "Authorization: [redacted]",
      'password: "[redacted]"',
      "secret='[redacted]' and more",
      '{"password":"[redacted]","user":"ann"}',
      'token: "[redacted]',
      '{"access_token":"[redacted]","client_secret":"[redacted]"}',
      String.raw`"{\"password\":\"[redacted]\",\"user\":\"ann\"}"`,
      String.raw`"{\"refresh_token\":\"[redacted]\"}"`,
      "password=[redacted] next",
    ]);
  });

  it("redacts adversarial floods of every credential shape in linear time", () => {
    const units = [
      "eyJ-",
      "eyJ--",
      "eyJ.",
      "bearer ",
      ["sk_", "live_"].join(""),
      "sk-",
      "ghp_",
      ["github", "_pat_"].join(""),
      ["xo", "xb-"].join(""),
      "AIza-",
      "AKIA",
      "token:",
      "access_token:",
      'password: "',
      String.raw`password\":\"`,
      String.raw`password=abc\def`,
      "secret='\\",
      "authorization: Basic ",
      "-----BEGIN PRIVATE KEY-----",
    ];
    // One link of many pairs, each holding a reference, ending in a
    // signature: every pair is read, and only by its offset.
    const pairs = Math.ceil((2 * codeLimits.outputBytes) / 8);
    const link = `https://h.example/x?${"a=&#59;&".repeat(pairs)}sig=S`;
    const linkStarted = performance.now();
    redact(link);
    const linkTook = performance.now() - linkStarted;
    const slowest = Math.max(
      linkTook,
      ...units.flatMap((unit) =>
        ["", "x", "-", "."].map((tail) => {
          const flood = `${unit}${tail}`.repeat(
            Math.ceil(
              (2 * codeLimits.outputBytes) / (unit.length + tail.length)
            )
          );
          const started = performance.now();
          redact(flood);
          return performance.now() - started;
        })
      )
    );

    // About 128K characters each: a quadratic pattern takes seconds.
    expect(slowest).toBeLessThan(250);
  });

  it("cuts text by UTF-8 bytes, never inside a character, and redacts credentials", () => {
    expect({
      cut: cutToBytes("é".repeat(10), 5),
      short: cutToBytes("abc", 10),
      emoji: cutToBytes("😀😀", 5),
      redacted: redact(
        "Authorization: Bearer abcdefghijklmnop1234 key sk-abcdefghijklmnop1234 jwt eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2Q aws AKIAABCDEFGHIJKLMNOP plain words"
      ),
      // Put together here, so the repository holds no token-shaped text.
      more: [
        ["sk_", "live_abcdefghij1234"].join(""),
        ["rk_", "test_abcdefghij1234"].join(""),
        ["ghp", "_abcdefghijklmnopqrstuvwxyz0123"].join(""),
        ["github", "_pat_abcdefghijklmnopqrstuv_0123"].join(""),
        ["xo", "xb-1234567890-abcdefghij"].join(""),
        ["AI", "zaSyA1234567890abcdefghijklmnopqrstuv"].join(""),
        "api_key=abc123",
        'password: "hunter2"',
        "token=xyz",
        "the secret is safe",
      ].map(redact),
    }).toStrictEqual({
      cut: "éé",
      short: "abc",
      emoji: "😀",
      redacted:
        "Authorization: [redacted] key [redacted] jwt [redacted] aws [redacted] plain words",
      more: [
        "[redacted]",
        "[redacted]",
        "[redacted]",
        "[redacted]",
        "[redacted]",
        "[redacted]",
        "api_key=[redacted]",
        'password: "[redacted]"',
        "token=[redacted]",
        "the secret is safe",
      ],
    });
  });
});
