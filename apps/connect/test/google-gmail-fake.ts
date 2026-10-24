/**
 * Google, as Gmail's door reaches it through connect: the OpenID metadata
 * and key set Pub/Sub's tokens are signed under (accounts.google.com,
 * www.googleapis.com), the token endpoint that takes the mailbox's refresh
 * token (oauth2.googleapis.com), and the Gmail API calls the Chat SDK's
 * Gmail adapter makes on one mailbox (gmail.googleapis.com). A test sets
 * the keys, puts mail in the inbox, and reads back what was sent and asked.
 *
 * Self-contained, with nothing from outside the function: core's tests run
 * it inside the Worker that stands in for the internet behind connect
 * (core's test/connect-providers.ts embeds its source), connect's call it
 * straight from a fetch spy.
 */
/* oxlint-disable unicorn/consistent-function-scoping -- core embeds the fake's source alone, so nothing it uses may live outside it */
export const googleGmailFake = (account: {
  mailbox: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accessToken: string;
}) => {
  const metadataUrl =
    "https://accounts.google.com/.well-known/openid-configuration";
  const keysUrl = "https://www.googleapis.com/oauth2/v3/certs";
  const tokenUrl = "https://oauth2.googleapis.com/token";
  const prefix = `/gmail/v1/users/${encodeURIComponent(account.mailbox)}/`;
  let keys: unknown[] = [];
  let historyId = 1000;
  const inbox: {
    id: string;
    threadId: string;
    historyId: number;
    labelIds: string[];
    raw: string;
  }[] = [];
  const sent: { to: string; subject: string; text: string; raw: string }[] = [];
  const asked: { method: string; host: string; path: string; token: string }[] =
    [];

  const base64Url = (text: string): string =>
    btoa(String.fromCodePoint(...new TextEncoder().encode(text)))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
  const fromBase64Url = (value: string): string =>
    new TextDecoder().decode(
      Uint8Array.from(
        atob(value.replaceAll("-", "+").replaceAll("_", "/")),
        (char) => char.codePointAt(0) ?? 0
      )
    );
  const headerOf = (raw: string, name: string): string =>
    new RegExp(`^${name}: (.*)$`, "imu").exec(raw)?.[1]?.trim() ?? "";
  const notFound = () =>
    Response.json(
      { error: { errors: [{ reason: "notFound" }] } },
      { status: 404 }
    );

  /** The mailbox's own routes: its profile, watch, history, listing and sending. */
  const mailboxRoute = async (
    request: Request,
    url: URL,
    path: string
  ): Promise<Response | undefined> => {
    if (path === "profile") {
      return Response.json({
        emailAddress: account.mailbox,
        historyId: String(historyId),
      });
    }
    if (path === "watch") {
      return Response.json({
        historyId: String(historyId),
        expiration: String(Date.now() + 7 * 24 * 3600 * 1000),
      });
    }
    if (path === "history") {
      const since = Number(url.searchParams.get("startHistoryId") ?? "0");
      return Response.json({
        history: inbox
          .filter((message) => message.historyId > since)
          .map((message) => ({
            id: String(message.historyId),
            messagesAdded: [
              {
                message: {
                  id: message.id,
                  threadId: message.threadId,
                  labelIds: message.labelIds,
                },
              },
            ],
          })),
        historyId: String(historyId),
      });
    }
    if (path === "messages" && request.method === "GET") {
      return Response.json({
        messages: inbox.map(({ id, threadId }) => ({ id, threadId })),
      });
    }
    if (path === "messages/send") {
      const body: unknown = await request.json();
      const fields: [string, unknown][] =
        typeof body === "object" && body !== null ? Object.entries(body) : [];
      const sentRaw = fields.find(([key]) => key === "raw")?.[1];
      const encoded = typeof sentRaw === "string" ? sentRaw : "";
      const thread = fields.find(([key]) => key === "threadId")?.[1];
      const raw = fromBase64Url(encoded);
      // The body as a person reads it: base64 bodies decoded.
      const [head = "", ...rest] = raw.split(/\r?\n\r?\n/u);
      const content = rest.join("\n\n");
      const text = /^Content-Transfer-Encoding: base64$/imu.test(head)
        ? fromBase64Url(content.replaceAll(/\s/gu, ""))
        : content;
      sent.push({
        to: headerOf(raw, "To"),
        subject: headerOf(raw, "Subject"),
        text,
        raw: encoded,
      });
      return Response.json({
        id: `sent${sent.length}`,
        threadId:
          typeof thread === "string" ? thread : `sentthread${sent.length}`,
        labelIds: ["SENT"],
      });
    }
    return undefined;
  };

  const gmailAnswer = async (request: Request, url: URL): Promise<Response> => {
    const authorization = request.headers.get("authorization") ?? "";
    asked.push({
      method: request.method,
      host: url.hostname,
      path: url.pathname,
      token: authorization.replace(/^Bearer /u, ""),
    });
    if (authorization !== `Bearer ${account.accessToken}`) {
      return Response.json({ error: "authError" }, { status: 401 });
    }
    if (!url.pathname.startsWith(prefix)) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    const path = url.pathname.slice(prefix.length);
    const mailboxAnswer = await mailboxRoute(request, url, path);
    if (mailboxAnswer !== undefined) {
      return mailboxAnswer;
    }
    const messageId = /^messages\/(?<id>[\w-]+)$/u.exec(path)?.groups?.id;
    if (messageId !== undefined) {
      const found = inbox.find(({ id }) => id === messageId);
      if (found === undefined) {
        return notFound();
      }
      return Response.json({
        id: found.id,
        threadId: found.threadId,
        labelIds: found.labelIds,
        historyId: String(found.historyId),
        internalDate: String(Date.now()),
        raw: url.searchParams.get("format") === "raw" ? found.raw : "",
      });
    }
    const threadId = /^threads\/(?<id>[\w-]+)$/u.exec(path)?.groups?.id;
    if (threadId !== undefined) {
      const messages = inbox.filter((message) => message.threadId === threadId);
      return messages.length === 0
        ? notFound()
        : Response.json({
            id: threadId,
            messages: messages.map(({ id }) => ({ id, threadId })),
          });
    }
    return notFound();
  };

  return {
    metadataUrl,
    keysUrl,
    asked,
    sent,
    /** Serves `next` as Google's key set, each a public JWK. */
    setKeys: (next: unknown[]) => {
      keys = next;
    },
    /**
     * Puts a mail in the inbox, as Gmail keeps it: from `from`, with
     * `replyTo` if given, a new thread unless `threadId` names one.
     */
    deliver: ({
      from,
      replyTo,
      subject = "A question",
      text,
    }: {
      from: string;
      replyTo?: string;
      subject?: string;
      text: string;
    }): { id: string; threadId: string } => {
      historyId += 1;
      const id = `m${historyId}`;
      const message = {
        id,
        threadId: `t${historyId}`,
        historyId,
        labelIds: ["INBOX", "UNREAD"],
        raw: base64Url(
          [
            `From: ${from}`,
            `To: ${account.mailbox}`,
            ...(replyTo === undefined ? [] : [`Reply-To: ${replyTo}`]),
            `Subject: ${subject}`,
            `Message-ID: <${id}@mail.test>`,
            "MIME-Version: 1.0",
            "Content-Type: text/plain; charset=utf-8",
            "",
            text,
          ].join("\r\n")
        ),
      };
      inbox.push(message);
      return { id, threadId: message.threadId };
    },
    reset: () => {
      keys = [];
      inbox.length = 0;
      sent.length = 0;
      asked.length = 0;
    },
    answer: async (request: Request): Promise<Response | undefined> => {
      const url = new URL(request.url);
      if (url.href === metadataUrl) {
        return Response.json({
          issuer: "https://accounts.google.com",
          jwks_uri: keysUrl,
        });
      }
      if (url.href === keysUrl) {
        return Response.json({ keys });
      }
      if (url.href === tokenUrl) {
        const form = new URLSearchParams(await request.text());
        asked.push({
          method: request.method,
          host: url.hostname,
          path: url.pathname,
          token: "",
        });
        return form.get("grant_type") === "refresh_token" &&
          form.get("client_id") === account.clientId &&
          form.get("client_secret") === account.clientSecret &&
          form.get("refresh_token") === account.refreshToken
          ? Response.json({
              access_token: account.accessToken,
              expires_in: 3599,
              token_type: "Bearer",
            })
          : Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      if (url.hostname === "gmail.googleapis.com") {
        return await gmailAnswer(request, url);
      }
      return undefined;
    },
  };
};
