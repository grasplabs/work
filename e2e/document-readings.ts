import type {
  DocumentReading,
  OnboardingDocument,
} from "@grasp-os/shared/onboarding-documents";
import type { Page } from "@playwright/test";
import { z } from "zod";

// Core reads a shared document through the model gateway (core's
// onboarding/documents.ts), which the local stack doesn't reach: every
// share would fail there. So the page's documents calls are answered here
// as core answers them once a document is read, from readings given by
// name. Each such call still reaches core, as the list of documents, so
// the connection numbers its calls as it would; only the answer is
// replaced. Cap'n Web writes a call as `["push", ["pipeline", stub,
// path, args]]`, an array in a value as `[[...items]]`, and answers a
// call by its number, counted from 1 on each connection.

const makesCall = /^\["(?:push|stream)",/u;
const listPath = ["onboarding", "documents"];

const callSchema = z.tuple([
  z.literal("push"),
  z.tuple([
    z.literal("pipeline"),
    z.number(),
    z.array(z.string()),
    z.array(z.unknown()),
  ]),
]);
const shareArgsSchema = z.tuple([z.object({ name: z.string() })]);
const answerArgsSchema = z.tuple([z.string(), z.string()]);
const resolveSchema = z.tuple([z.literal("resolve"), z.number(), z.unknown()]);
const listSchema = z.tuple([z.array(z.unknown())]);

/** A value as Cap'n Web writes it: arrays wrapped once more. */
const written = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return [value.map(written)];
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, each]) => [key, written(each)])
    );
  }
  return value;
};

/** What the page is answered on one call, once core has answered it. */
type Answer =
  | { kind: "share"; name: string; reading: DocumentReading }
  | { kind: "answer"; id: string; answer: string }
  | { kind: "list" };

/** The answer due on a call, with `readings` and what is `kept`; none for a call core answers itself. */
const answerFor = (
  path: string[],
  args: unknown[],
  readings: Record<string, DocumentReading>,
  kept: OnboardingDocument[]
): Answer | undefined => {
  const method = path.join(".");
  const share = shareArgsSchema.safeParse(args);
  if (method === "onboarding.shareDocument" && share.success) {
    const [{ name }] = share.data;
    const reading = readings[name];
    return reading === undefined ? undefined : { kind: "share", name, reading };
  }
  const answered = answerArgsSchema.safeParse(args);
  if (method === "onboarding.answerDocument" && answered.success) {
    const [id, answer] = answered.data;
    return kept.some((each) => each.id === id)
      ? { kind: "answer", id, answer }
      : undefined;
  }
  return method === "onboarding.documents" ? { kind: "list" } : undefined;
};

/** What the page is told for `answer`, given what core answered. */
const valueOf = (
  answer: Answer,
  core: unknown,
  kept: OnboardingDocument[]
): unknown => {
  if (answer.kind === "share") {
    const read: OnboardingDocument = {
      id: crypto.randomUUID(),
      name: answer.name,
      at: new Date().toISOString(),
      reading: answer.reading,
      answer: null,
    };
    // Core lists the newest first.
    kept.unshift(read);
    return written(read);
  }
  if (answer.kind === "answer") {
    const read = kept.find((each) => each.id === answer.id);
    if (read !== undefined) {
      read.answer = answer.answer;
    }
    return written(read);
  }
  // Core's own, after the ones answered here.
  const listed = listSchema.safeParse(core);
  const own = listed.success ? listed.data[0] : [];
  return [[...kept.map((each) => written(each)), ...own]];
};

/**
 * Answers the page's documents calls as core does once each document is
 * read, with `readings` by file name, and keeps what is shared and
 * answered, as core would. A file without a reading goes to core as it is.
 */
export const readDocumentsAs = async (
  page: Page,
  readings: Record<string, DocumentReading>
): Promise<void> => {
  const kept: OnboardingDocument[] = [];
  await page.routeWebSocket("**/rpc", (socket) => {
    const server = socket.connectToServer();
    const answers = new Map<number, Answer>();
    let calls = 0;
    socket.onMessage((message) => {
      const text = String(message);
      if (!makesCall.test(text)) {
        server.send(message);
        return;
      }
      calls += 1;
      const call = callSchema.safeParse(JSON.parse(text));
      if (!call.success) {
        server.send(message);
        return;
      }
      const [, [, stub, path, args]] = call.data;
      const answer = answerFor(path, args, readings, kept);
      if (answer !== undefined) {
        answers.set(calls, answer);
      }
      // A share or an answer given here reaches core as the list, which changes nothing.
      server.send(
        answer === undefined || answer.kind === "list"
          ? message
          : JSON.stringify(["push", ["pipeline", stub, listPath, []]])
      );
    });
    server.onMessage((message) => {
      const resolved = resolveSchema.safeParse(JSON.parse(String(message)));
      if (!resolved.success) {
        socket.send(message);
        return;
      }
      const [, id, core] = resolved.data;
      const answer = answers.get(id);
      if (answer === undefined) {
        socket.send(message);
        return;
      }
      answers.delete(id);
      socket.send(JSON.stringify(["resolve", id, valueOf(answer, core, kept)]));
    });
  });
};
