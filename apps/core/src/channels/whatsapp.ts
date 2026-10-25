/**
 * WhatsApp as a door into core: the Chat SDK's WhatsApp adapter (Meta's
 * Cloud API), with every request it is handed checked here, before
 * anything of it reaches a handler, as really sent by Meta for this
 * client's business number.
 *
 * Threat model, and how each is closed:
 *
 * - Anyone on the internet posting here. Every request must carry Meta's
 *   signature (`x-hub-signature-256`): `sha256=` and the HMAC-SHA256,
 *   under the client's Meta app secret (`WHATSAPP_APP_SECRET`), of the
 *   body exactly as sent. One without it, or with another, is refused.
 * - Another business number on the same Meta app. Every change the request
 *   carries must name the client's own number (`WHATSAPP_PHONE_NUMBER_ID`)
 *   as the one written to; a request naming any other is refused whole.
 * - A captured request sent again. Meta signs no time, so the door takes
 *   each message once, by its id, for a day.
 * - Someone subscribing the webhook elsewhere, or reading whether it is
 *   ours. Meta's subscription check (a GET with `hub.verify_token`) is
 *   answered with its challenge only for the client's own verify token
 *   (`WHATSAPP_VERIFY_TOKEN`), compared in constant time; anything else
 *   gets a 403.
 * - Misconfiguration. Without the app secret, the number or the verify
 *   token the door answers 404 and every request would be refused.
 * - The adapter's own check. The adapter only takes a body the door has
 *   checked and handed it (`vouched`), and never checks with a secret of
 *   its own.
 * - A phone number standing for a person. WhatsApp's sender id is their
 *   number (or Meta's business-scoped id): it is only ever matched to a
 *   Grasp person through an account they linked themselves (who.ts).
 *
 * Everything the adapter sends goes out through connect, which holds the
 * client's access token: core builds the adapter with the placeholder
 * connect swaps for it (`channelCredentialPlaceholder`). The adapter's media
 * downloads aren't used: Stephen reads text only.
 */
import { WhatsAppAdapter } from "@chat-adapter/whatsapp";
import { channelCredentialPlaceholder } from "@grasp-os/shared/connect";
import { log } from "@grasp-os/shared/log";
import type { Logger } from "chat";
import { z } from "zod";

const signaturePattern = /^sha256=(?<mac>[0-9a-f]{64})$/u;

/** Bytes from lowercase hex. */
const hexBytes = (hex: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(hex.match(/../gu) ?? [], (pair) => Number.parseInt(pair, 16));

/** The changes a request carries, as far as their number is read. */
const numbersSchema = z.object({
  entry: z.array(
    z.object({
      changes: z.array(
        z.object({
          value: z.object({
            metadata: z.object({ phone_number_id: z.string() }).optional(),
          }),
        })
      ),
    })
  ),
});

/** Whether the deployment set WhatsApp up: its secret, number and verify token. */
export const whatsAppSetUp = (env: Env): boolean =>
  [
    env.WHATSAPP_APP_SECRET,
    env.WHATSAPP_PHONE_NUMBER_ID,
    env.WHATSAPP_VERIFY_TOKEN,
  ].every((value) => value !== undefined && value !== "");

/** Why a WhatsApp request was refused, as the log says it. */
type Refusal = "unconfigured" | "signature" | "mac" | "body" | "number";

/** Why `request` isn't Meta's, signed for this client's number, or undefined. */
const refusalOf = async (
  env: Env,
  request: Request,
  body: string
): Promise<Refusal | undefined> => {
  const secret = env.WHATSAPP_APP_SECRET;
  const number = env.WHATSAPP_PHONE_NUMBER_ID;
  if (
    secret === undefined ||
    secret === "" ||
    number === undefined ||
    number === ""
  ) {
    return "unconfigured";
  }
  const mac = signaturePattern.exec(
    request.headers.get("x-hub-signature-256") ?? ""
  )?.groups?.mac;
  if (mac === undefined) {
    return "signature";
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const signed = await crypto.subtle.verify(
    "HMAC",
    key,
    hexBytes(mac),
    new TextEncoder().encode(body)
  );
  if (!signed) {
    return "mac";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return "body";
  }
  const changes = numbersSchema.safeParse(parsed);
  if (!changes.success) {
    return "body";
  }
  const numbers = changes.data.entry.flatMap((entry) =>
    entry.changes.map(({ value }) => value.metadata?.phone_number_id)
  );
  return numbers.every((each) => each === number) ? undefined : "number";
};

/**
 * Whether `request`, with `body` as it was sent, is Meta's, signed for this
 * client's app and written to this client's number. A refusal is logged by
 * its reason, never with anything the request carried.
 */
export const verifiedWhatsAppRequest = async (
  env: Env,
  request: Request,
  body: string
): Promise<boolean> => {
  const refusal = await refusalOf(env, request, body);
  if (refusal !== undefined) {
    log.info("channel.refused", { platform: "whatsapp", reason: refusal });
    return false;
  }
  return true;
};

/** Whether `a` and `b` are the same text, compared in constant time. */
const sameText = (a: string, b: string): boolean => {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  return (
    left.byteLength === right.byteLength &&
    crypto.subtle.timingSafeEqual(left, right)
  );
};

/**
 * Meta's subscription check of the webhook: its challenge for the client's
 * own verify token, and a 403 for anything else.
 */
export const whatsAppSubscription = (env: Env, request: Request): Response => {
  const url = new URL(request.url);
  const token = env.WHATSAPP_VERIFY_TOKEN ?? "";
  const challenge = url.searchParams.get("hub.challenge") ?? "";
  const subscribes =
    url.searchParams.get("hub.mode") === "subscribe" &&
    token !== "" &&
    sameText(url.searchParams.get("hub.verify_token") ?? "", token) &&
    /^[\w-]{1,128}$/u.test(challenge);
  return subscribes
    ? new Response(challenge, {
        status: 200,
        headers: { "content-type": "text/plain" },
      })
    : new Response("Forbidden", { status: 403 });
};

/**
 * Chat SDK's logs stay out of core's but for what fails, as for Teams
 * (teams.ts): only the message of a warning or an error is kept.
 */
const silent = (): void => undefined;
const whatsAppLogger: Logger = {
  child: () => whatsAppLogger,
  debug: silent,
  info: silent,
  warn: (message) => {
    log.warn("channel.whatsapp", { message });
  },
  error: (message) => {
    log.error("channel.whatsapp", { message });
  },
};

/**
 * WhatsApp's adapter, sending through connect and taking only bodies the
 * door has checked: the SDK's adapter sends with the global fetch and checks
 * signatures with the app secret itself, so both are replaced here.
 */
class ConnectedWhatsAppAdapter extends WhatsAppAdapter {
  readonly #env: Env;
  readonly #vouched: (body: string) => boolean;

  constructor(env: Env, vouched: (body: string) => boolean) {
    super({
      accessToken: channelCredentialPlaceholder,
      // Never used: `verifySignature` below takes the door's word.
      appSecret: channelCredentialPlaceholder,
      phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID ?? "",
      verifyToken: env.WHATSAPP_VERIFY_TOKEN ?? "",
      userName: "Stephen",
      logger: whatsAppLogger,
    });
    this.#env = env;
    this.#vouched = vouched;
  }

  // oxlint-disable-next-line grasp/no-unbounded-rpc-target -- an SDK adapter, never an RPC target: the SDK's own hook
  protected override verifySignature(body: string): boolean {
    return this.#vouched(body);
  }

  // oxlint-disable-next-line grasp/no-unbounded-rpc-target -- an SDK adapter, never an RPC target: the SDK's own hook
  protected override async graphApiRequest<T = unknown>(
    path: string,
    body: unknown
  ): Promise<T> {
    const response = await this.#env.CONNECT.channelFetch(
      "whatsapp",
      new Request(`${this.graphApiUrl}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${channelCredentialPlaceholder}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      })
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`WhatsApp refused the request (${response.status})`);
    }
    return await response.json<T>();
  }
}
export type { ConnectedWhatsAppAdapter };

/**
 * WhatsApp's adapter for this client's number, taking only the bodies
 * `vouched` says the door checked (`verifiedWhatsAppRequest`): none unless
 * told otherwise.
 */
export const whatsAppAdapter = (
  env: Env,
  vouched: (body: string) => boolean = () => false
): ConnectedWhatsAppAdapter => new ConnectedWhatsAppAdapter(env, vouched);
