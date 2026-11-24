/**
 * Email Sending, the one outside system mail goes to, as a test stands it
 * in for the `EMAIL` binding: it keeps every message it is given, and
 * answers each with the next answer the test planned (an `E_…` code Email
 * Sending throws), or sends it. Set through an onboarding store's env,
 * which every object in the tests' runtime shares, until the file ends
 * (start-each-file.ts puts the env back).
 */
import { runInDurableObject } from "cloudflare:test";

import type { Onboarding } from "../src/onboarding/store.ts";

/** A store, as a test reaches it. */
type Store = DurableObjectStub<Onboarding>;

/** What the stand-in kept: every message given, and those it sent. */
export interface CapturedMail {
  tried: EmailMessageBuilder[];
  sent: EmailMessageBuilder[];
  /** Answers for the next sends, in order: an `E_…` code, or `sent`. */
  plan: string[];
}

/** An error as Email Sending throws it: its code, and a message. */
const sendingError = (code: string): Error =>
  Object.assign(new Error(`Email Sending refused it: ${code}`), { code });

/**
 * Sets vars on the store's own env, which in the tests' runtime is every
 * object's, and the tests' `env` too. Returns what they were, to put back.
 */
export const setStoreEnv = async (
  store: Store,
  vars: Record<string, unknown>
): Promise<Record<string, unknown>> =>
  await runInDurableObject(store, (instance) => {
    const objectEnv: unknown = Reflect.get(instance, "env");
    if (typeof objectEnv !== "object" || objectEnv === null) {
      throw new TypeError("The Onboarding object has no env");
    }
    const was = Object.fromEntries(
      Object.keys(vars).map((name) => [name, Reflect.get(objectEnv, name)])
    );
    for (const [name, value] of Object.entries(vars)) {
      Reflect.set(objectEnv, name, value);
    }
    return was;
  });

/** Stands Email Sending in for the `EMAIL` binding, from now on. */
export const captureMail = async (
  store: Store,
  ...plan: string[]
): Promise<CapturedMail> => {
  const captured: CapturedMail = { tried: [], sent: [], plan };
  const binding = {
    send: async (message: EmailMessageBuilder): Promise<EmailSendResult> => {
      captured.tried.push(message);
      const answer = captured.plan.shift() ?? "sent";
      if (answer !== "sent") {
        throw sendingError(answer);
      }
      captured.sent.push(message);
      return await Promise.resolve({
        messageId: `<${crypto.randomUUID()}@mail.grasp.test>`,
      });
    },
  };
  await setStoreEnv(store, { EMAIL: binding });
  return captured;
};
