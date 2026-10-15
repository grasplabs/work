/**
 * Extracting an upload's text on the on-prem sandbox, on plain workerd: a
 * stand-in core (apps/core/test/workerd/extraction-worker.ts) runs the
 * same `localExtractor` core runs for an upload, a shared document and a
 * kickoff's transcript, with `SANDBOX_HOST` bound to the supervisor
 * (workerd-sandbox.ts) and the extractor core's build makes. Plain workerd
 * ignores an isolate's CPU limit, so a file that exhausts or takes over a
 * parser must never run in core's own process.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { nativeWorkerd, startSandboxSupervisor } from "./workerd-sandbox.ts";
import type { SandboxSupervisor } from "./workerd-sandbox.ts";
import { serveStandIn } from "./workerd-stand-in.ts";
import { cleanUp, tempDir } from "./workerd-test-server.ts";

const repo = path.join(import.meta.dirname, "..");
const uploads = path.join(repo, "apps/core/test/fixtures/assets/uploads");

/** How long core may take to answer another request meanwhile. */
const ANSWER_MS = 500;

/**
 * How long an extraction may take on the sandbox host here: longer than a
 * session waits for its owner's room (3 s), so a second extraction gives
 * up waiting while the first still holds the owner's share.
 */
const DEADLINE_MS = 6000;

const types = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
} as const;

/** Just under an upload's limit of 10 MiB. */
const NEARLY_LIMIT_BYTES = Math.floor(9.9 * 1024 * 1024);

const outcomeSchema = z.object({
  status: z.enum(["ok", "failed", "unavailable"]),
  text: z.string().optional(),
  code: z.string().optional(),
  error: z.string().optional(),
  busy: z.boolean().optional(),
  cause: z.string().nullable().optional(),
  ms: z.number(),
});

describe("extracting an upload on the on-prem sandbox", () => {
  let supervisor: SandboxSupervisor;
  let coreUrl: string;

  beforeAll(async () => {
    supervisor = await startSandboxSupervisor({
      workerd: nativeWorkerd,
      processes: 2,
      log: () => {},
    });
    // The extractor as core's build makes it, pdf.js and all.
    const assets = tempDir();
    execFileSync(
      process.execPath,
      [path.join(repo, "apps/core/build-extractor.ts"), assets],
      { cwd: path.join(repo, "apps/core"), stdio: "ignore" }
    );
    coreUrl = await serveStandIn(
      "extraction-worker.ts",
      supervisor.socket,
      { SANDBOX_DEADLINE_MS: String(DEADLINE_MS) },
      { EXTRACTOR: path.join(assets, "_extractor/extractor.js") }
    );
  }, 180_000);

  afterAll(async () => {
    await supervisor.stop();
    cleanUp();
  });

  const extract = async (
    file: string,
    query: string,
    route = "/extract"
  ): Promise<z.infer<typeof outcomeSchema>> => {
    const response = await fetch(`${coreUrl}${route.slice(1)}?${query}`, {
      method: "POST",
      body: readFileSync(path.join(uploads, file)),
    });
    return outcomeSchema.parse(await response.json());
  };

  /** How long core takes to answer a request that extracts nothing. */
  const answerTime = async (): Promise<number> => {
    const started = Date.now();
    const response = await fetch(coreUrl, {
      signal: AbortSignal.timeout(2000),
    });
    await response.text();
    return Date.now() - started;
  };

  it("reads a PDF, a Word and an Excel file on the sandbox host, not in core", async () => {
    // One at a time: the extractor's owner holds one of the two processes.
    const pdf = await extract("expense-policy.pdf", `type=${types.pdf}`);
    const docx = await extract("travel-policy.docx", `type=${types.docx}`);
    const xlsx = await extract("offices.xlsx", `type=${types.xlsx}`);

    expect({
      pdf: pdf.status,
      pdfPages: pdf.text?.includes("## Page 2"),
      docx: docx.status,
      docxHeading: docx.text?.includes("# Travel policy"),
      xlsx: xlsx.status,
      xlsxSheet: xlsx.text?.includes("Contacts"),
    }).toStrictEqual({
      pdf: "ok",
      pdfPages: true,
      docx: "ok",
      docxHeading: true,
      xlsx: "ok",
      xlsxSheet: true,
    });
  }, 60_000);

  it("reads a file larger than one message to the sandbox carries, whole and in order", async () => {
    // A Word file of 3 MiB, its parts' directory at its very end.
    const outcome = await extract(
      "travel-policy.docx",
      `type=${types.docx}&pad=${3 * 1024 * 1024}`
    );

    expect({
      status: outcome.status,
      heading: outcome.text?.includes("# Travel policy"),
    }).toStrictEqual({ status: "ok", heading: true });
  }, 60_000);

  it("reads an honest file just under the upload limit", async () => {
    const docx = readFileSync(path.join(uploads, "travel-policy.docx"));
    const outcome = await extract(
      "travel-policy.docx",
      `type=${types.docx}&pad=${NEARLY_LIMIT_BYTES - docx.byteLength - 4096}`
    );

    expect({
      status: outcome.status,
      heading: outcome.text?.includes("# Travel policy"),
    }).toStrictEqual({ status: "ok", heading: true });
  }, 60_000);

  it("refuses a second read of the file's start, so an extractor reads each chunk once", async () => {
    const outcome = await extract(
      "travel-policy.docx",
      `type=${types.docx}&extractor=reread`
    );

    expect({ status: outcome.status, text: outcome.text }).toStrictEqual({
      status: "ok",
      text: "# Refused",
    });
  }, 60_000);

  it("fails as too complex an extractor a file runs out of memory with a read in flight, every time", async () => {
    // Several in a row: the kill can reach core before the socket's close.
    const before = supervisor.stats();
    const outcomes = [];
    for (let run = 0; run < 3; run += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one process at a time
      const outcome = await extract(
        "travel-policy.docx",
        `type=${types.docx}&extractor=memory&pad=${3 * 1024 * 1024}`
      );
      outcomes.push(outcome.code ?? outcome.error);
    }
    const after = supervisor.stats();

    expect(outcomes).toStrictEqual([
      "upload.too_complex",
      "upload.too_complex",
      "upload.too_complex",
    ]);
    // Ended for its memory (or by V8 at its heap limit, as a crash).
    expect(
      after.memory - before.memory + (after.crashed - before.crashed)
    ).toBe(3);
  }, 120_000);

  it("fails as too complex an extractor that fills V8's own heap with a read in flight", async () => {
    const outcome = await extract(
      "travel-policy.docx",
      `type=${types.docx}&extractor=heap&pad=${3 * 1024 * 1024}`
    );

    expect({ status: outcome.status, code: outcome.code }).toStrictEqual({
      status: "failed",
      code: "upload.too_complex",
    });
  }, 60_000);

  it("fails as too complex an extractor that answers more than a session takes", async () => {
    const outcome = await extract(
      "expense-policy.pdf",
      `type=${types.pdf}&extractor=oversized`
    );

    expect({ status: outcome.status, code: outcome.code }).toStrictEqual({
      status: "failed",
      code: "upload.too_complex",
    });
  }, 60_000);

  it("ends an extractor a file keeps busy past its deadline as unavailable, to try again, and core answers meanwhile", async () => {
    // Its deadline here (6 s) comes before its CPU time (20 s), as load can
    // make it come: not the file's own verdict, so the extraction is tried
    // again rather than failed for good. Past its CPU time it fails as too
    // complex, as one that runs out of memory does.
    const running = extract(
      "expense-policy.pdf",
      `type=${types.pdf}&extractor=busy`
    );
    // Asked while the extractor spins on the sandbox host.
    await sleep(1000);
    const meanwhile = await answerTime();
    const outcome = await running;

    expect(meanwhile).toBeLessThan(ANSWER_MS);
    expect({
      status: outcome.status,
      error: outcome.error,
      busy: outcome.busy,
    }).toStrictEqual({
      status: "unavailable",
      error: "ExtractorUnavailableError",
      busy: false,
    });
    // At its deadline, not at the 60 s an extraction may take otherwise.
    expect(outcome.ms).toBeLessThan(DEADLINE_MS + 5000);
    await expect
      .poll(() => supervisor.stats().inFlight, { timeout: 5000, interval: 50 })
      .toBe(0);
  }, 60_000);

  it("asks for a kickoff's Word transcript again when its extractor runs past its deadline, and core answers meanwhile", async () => {
    const running = extract(
      "travel-policy.docx",
      "extractor=busy",
      "/transcript"
    );
    await sleep(1000);
    const meanwhile = await answerTime();
    const outcome = await running;

    expect(meanwhile).toBeLessThan(ANSWER_MS);
    expect({ status: outcome.status, code: outcome.code }).toStrictEqual({
      status: "failed",
      code: "kickoff.not_read",
    });
  }, 60_000);

  it("asks for a kickoff's transcript again, not for another file, when no extractor could try", async () => {
    const outcome = await extract(
      "travel-policy.docx",
      "unbound",
      "/transcript"
    );

    expect({ status: outcome.status, code: outcome.code }).toStrictEqual({
      status: "failed",
      code: "kickoff.not_read",
    });
  });

  it("holds extractions to one owner's share of the pool: past it, the extractor is busy, not failed", async () => {
    // Two processes, so one owner holds one: the second extraction waits
    // for the first's place, gives up while it's held, and is busy, which
    // the extraction workflow waits out (apps/core/test/uploads.test.ts).
    const first = extract(
      "expense-policy.pdf",
      `type=${types.pdf}&extractor=busy`
    );
    await sleep(500);
    const second = await extract(
      "expense-policy.pdf",
      `type=${types.pdf}&extractor=busy`
    );

    expect({
      status: second.status,
      error: second.error,
      busy: second.busy,
      cause: second.cause?.includes("as many calls in the sandbox as it may"),
    }).toStrictEqual({
      status: "unavailable",
      error: "ExtractorUnavailableError",
      busy: true,
      cause: true,
    });
    const ended = await first;

    expect(ended.status).toBe("unavailable");
  }, 60_000);

  it("refuses to extract where no sandbox bounds it, without loading the extractor in core", async () => {
    // As a deployment off Cloudflare that forgot `SANDBOX_HOST`: the stand-in's
    // Loader throws if core reaches for it.
    const outcome = await extract(
      "expense-policy.pdf",
      `type=${types.pdf}&unbound`
    );

    expect({
      status: outcome.status,
      error: outcome.error,
      refused: outcome.cause?.startsWith("SandboxUnavailableError"),
    }).toStrictEqual({
      status: "unavailable",
      error: "ExtractorUnavailableError",
      refused: true,
    });
    await expect(answerTime()).resolves.toBeLessThan(ANSWER_MS);
  });
});
