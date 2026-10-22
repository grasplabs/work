import type { LinkChannel, LinkDecision } from "@grasp-os/sdk/host";
import type {
  LinkIntent,
  PageLinkMessage,
} from "@grasp-os/shared/app-link-limits";
import { describe, expect, it } from "vite-plus/test";

import { openLinkPort } from "./screen-links.ts";
import type { LinkPage } from "./screen-links.ts";

// The page's side of a screen's link port: a link opens only as core
// answered it, directly after the person's click in the frame, otherwise
// once they confirmed it in the page's dialog naming its origin; and the
// frame hears only whether it opened. Core's own decisions are
// app-links.test.ts's in core.

/** What the fake core decided, and how it was asked. */
interface Asked {
  checked: string[];
  opened: { url: string; intent: LinkIntent }[];
}

/**
 * Core's link channel, deciding `decision` for any URL (or refusing with
 * `refusal`), recording what it was asked.
 */
const coreDeciding = (
  decision: Partial<LinkDecision>,
  refusal?: string
): { channel: LinkChannel; asked: Asked } => {
  const asked: Asked = { checked: [], opened: [] };
  const answer = async (url: string): Promise<LinkDecision> => {
    if (refusal !== undefined) {
      throw Object.assign(new Error("Refused."), { code: refusal });
    }
    return await Promise.resolve({
      url,
      origin: "https://help.example.com",
      confirm: false,
      ...decision,
    });
  };
  return {
    asked,
    channel: {
      check: async (_resource, url) => {
        asked.checked.push(url);
        return await answer(url);
      },
      open: async (_resource, url, intent) => {
        asked.opened.push({ url, intent });
        return await answer(url);
      },
    },
  };
};

/** The page, as a test drives it: whether the person clicked, and confirms. */
const pageWith = ({
  clicked = false,
  stillActive = true,
  confirms = true,
}: {
  clicked?: boolean;
  stillActive?: boolean;
  confirms?: boolean;
}) => {
  const seen: { confirmed: string[]; opened: string[] } = {
    confirmed: [],
    opened: [],
  };
  const page: LinkPage = {
    take: () => clicked,
    active: () => stillActive,
    confirm: async ({ origin, url }) => {
      seen.confirmed.push(url === undefined ? origin : `${origin} ${url}`);
      return await Promise.resolve(confirms);
    },
    open: (url) => {
      seen.opened.push(url);
    },
  };
  return { page, seen };
};

/** What the page answers the frame for one message `data`. */
const answerTo = async (
  data: unknown,
  channel: LinkChannel | undefined,
  page: LinkPage
): Promise<PageLinkMessage> => {
  const { port1, port2 } = new MessageChannel();
  const close = openLinkPort(port1, channel, page);
  const { promise, resolve } = Promise.withResolvers<PageLinkMessage>();
  port2.addEventListener("message", (event: MessageEvent<PageLinkMessage>) => {
    resolve(event.data);
  });
  port2.start();
  port2.postMessage(data);
  try {
    return await promise;
  } finally {
    close();
    port2.close();
  }
};

const open = (url = "https://help.example.com/guide") => ({
  type: "open",
  call: 1,
  resource: "help",
  url,
});

describe("a screen's link port", () => {
  it("opens a link right after the person's click, as core answered it, asking nothing", async () => {
    const core = coreDeciding({ url: "https://xn--bcher-kva.example/k" });
    const { page, seen } = pageWith({ clicked: true });

    expect({
      answer: await answerTo(
        open("https://bücher.example/k"),
        core.channel,
        page
      ),
      asked: core.asked,
      seen,
    }).toStrictEqual({
      answer: { type: "opened", call: 1 },
      asked: {
        checked: ["https://bücher.example/k"],
        opened: [{ url: "https://bücher.example/k", intent: "activation" }],
      },
      // Core's URL opens, never the frame's text.
      seen: { confirmed: [], opened: ["https://xn--bcher-kva.example/k"] },
    });
  });

  it("asks the person, naming the origin core checked, when they didn't click", async () => {
    const core = coreDeciding({});
    const { page, seen } = pageWith({ clicked: false });

    expect({
      answer: await answerTo(open(), core.channel, page),
      intents: core.asked.opened.map(({ intent }) => intent),
      seen,
    }).toStrictEqual({
      answer: { type: "opened", call: 1 },
      intents: ["confirmation"],
      seen: {
        confirmed: ["https://help.example.com"],
        opened: ["https://help.example.com/guide"],
      },
    });
  });

  it("asks too when the click's activation lapsed while core answered, or the App read restricted data", async () => {
    const lapsed = pageWith({ clicked: true, stillActive: false });
    const restricted = pageWith({ clicked: true });

    await answerTo(open(), coreDeciding({}).channel, lapsed.page);
    await answerTo(
      open(),
      coreDeciding({ confirm: true }).channel,
      restricted.page
    );

    expect([lapsed.seen.confirmed, restricted.seen.confirmed]).toStrictEqual([
      // Lapsed throughout: asked again once core recorded the open, and
      // once more when even the dialog's Open gave none to open with.
      [
        "https://help.example.com",
        "https://help.example.com",
        "https://help.example.com",
      ],
      // Restricted: the whole URL is shown too.
      ["https://help.example.com https://help.example.com/guide"],
    ]);
  });

  it("asks when the activation lapsed while core recorded the open, rather than open a window the browser blocks", async () => {
    const core = coreDeciding({});
    let checks = 0;
    const { page, seen } = pageWith({ clicked: true });
    const lapsing: LinkPage = {
      ...page,
      // Still active when core checked, lapsed once it recorded the open,
      // active again from the dialog's Open.
      active: () => {
        checks += 1;
        return checks !== 2;
      },
    };

    expect({
      answer: await answerTo(open(), core.channel, lapsing),
      intents: core.asked.opened.map(({ intent }) => intent),
      seen,
    }).toStrictEqual({
      answer: { type: "opened", call: 1 },
      intents: ["activation"],
      seen: {
        confirmed: ["https://help.example.com"],
        opened: ["https://help.example.com/guide"],
      },
    });
  });

  it("asks once more when the dialog's activation lapsed while core decided again, opening only with one", async () => {
    const core = coreDeciding({});
    const { page, seen } = pageWith({ clicked: true });
    // Active as core checked; lapsed once it recorded the open; lapsed
    // again while it decided after the dialog's Open (a slow answer); held
    // after the next Open.
    const activations = [true, false, false, true];
    const slow: LinkPage = {
      ...page,
      active: () => activations.shift() ?? false,
    };

    expect({
      answer: await answerTo(open(), core.channel, slow),
      checked: core.asked.checked.length,
      seen,
    }).toStrictEqual({
      answer: { type: "opened", call: 1 },
      // Before the open, and after each confirmation.
      checked: 3,
      seen: {
        confirmed: ["https://help.example.com", "https://help.example.com"],
        opened: ["https://help.example.com/guide"],
      },
    });
  });

  it("refuses, opening nothing, when even the dialog's Open leaves no activation to open with", async () => {
    const core = coreDeciding({});
    const { page, seen } = pageWith({ clicked: false, stillActive: false });

    expect({
      answer: await answerTo(open(), core.channel, page),
      asked: seen.confirmed.length,
      opened: seen.opened,
    }).toStrictEqual({
      answer: {
        type: "failed",
        call: 1,
        error: { code: "link.declined", message: "The link wasn't opened." },
      },
      asked: 3,
      opened: [],
    });
  });

  it("opens nothing the person turned down, and nothing is recorded as opened", async () => {
    const core = coreDeciding({});
    const { page, seen } = pageWith({ clicked: false, confirms: false });

    expect({
      answer: await answerTo(open(), core.channel, page),
      opened: core.asked.opened,
      seen: seen.opened,
    }).toStrictEqual({
      answer: {
        type: "failed",
        call: 1,
        error: { code: "link.declined", message: "The link wasn't opened." },
      },
      opened: [],
      seen: [],
    });
  });

  it("passes core's refusal on, asking and opening nothing", async () => {
    const core = coreDeciding({}, "link.not_allowed");
    const { page, seen } = pageWith({ clicked: true });

    expect({
      answer: await answerTo(open(), core.channel, page),
      seen,
    }).toStrictEqual({
      answer: {
        type: "failed",
        call: 1,
        error: { code: "link.not_allowed", message: "Refused." },
      },
      seen: { confirmed: [], opened: [] },
    });
  });

  it("refuses what isn't an open, and every open of a preview, which has no channel", async () => {
    const { page } = pageWith({ clicked: true });

    expect({
      extra: await answerTo(
        { ...open(), target: "_top" },
        coreDeciding({}).channel,
        page
      ),
      preview: await answerTo(open(), undefined, page),
    }).toMatchObject({
      extra: { type: "failed", call: 1, error: { code: "link.invalid" } },
      preview: { type: "failed", call: 1, error: { code: "link.unavailable" } },
    });
  });

  it("answers an open still under way when the port closes, so the frame's caller never waits for ever", async () => {
    const { port1, port2 } = new MessageChannel();
    const held = Promise.withResolvers<never>();
    const asked = Promise.withResolvers<null>();
    const channel: LinkChannel = {
      check: async () => {
        asked.resolve(null);
        return await held.promise;
      },
      open: async () => await held.promise,
    };
    const close = openLinkPort(port1, channel, pageWith({}).page);
    const answered = Promise.withResolvers<PageLinkMessage>();
    port2.addEventListener(
      "message",
      (event: MessageEvent<PageLinkMessage>) => {
        answered.resolve(event.data);
      }
    );
    port2.start();
    port2.postMessage(open());
    // The page's check is out when the frame stops.
    await asked.promise;
    close();

    await expect(answered.promise).resolves.toMatchObject({
      type: "failed",
      call: 1,
      error: { code: "link.unavailable" },
    });
    port2.close();
  });

  it("refuses a second open under a call number still under way, and stops the first with the port", async () => {
    const { port1, port2 } = new MessageChannel();
    const held = Promise.withResolvers<LinkDecision>();
    const asked = Promise.withResolvers<null>();
    // Reached only if the page took the second open as one of its own.
    const checkedTwice = Promise.withResolvers<null>();
    // The first open reaching core after the port closed.
    const reachedOpen = Promise.withResolvers<null>();
    let checks = 0;
    const channel: LinkChannel = {
      check: async (_resource, url) => {
        checks += 1;
        asked.resolve(null);
        if (checks === 2) {
          checkedTwice.resolve(null);
        }
        await held.promise;
        return { url, origin: "https://help.example.com", confirm: false };
      },
      open: async (_resource, url) => {
        reachedOpen.resolve(null);
        return await Promise.resolve({
          url,
          origin: "https://help.example.com",
          confirm: false,
        });
      },
    };
    const { page, seen } = pageWith({ clicked: true });
    const close = openLinkPort(port1, channel, page);
    const answers: PageLinkMessage[] = [];
    const second = Promise.withResolvers<null>();
    port2.addEventListener(
      "message",
      (event: MessageEvent<PageLinkMessage>) => {
        answers.push(event.data);
        second.resolve(null);
      }
    );
    port2.start();
    port2.postMessage(open());
    await asked.promise;
    port2.postMessage(open("https://help.example.com/other"));
    await Promise.race([second.promise, checkedTwice.promise]);
    close();
    // The first's check answers only after the port closed: it opens nothing.
    held.resolve({
      url: "https://help.example.com/guide",
      origin: "https://help.example.com",
      confirm: false,
    });
    // Past core's answer to the open, and every task after it.
    await reachedOpen.promise;
    const drained = Promise.withResolvers<null>();
    setTimeout(() => {
      drained.resolve(null);
    }, 0);
    await drained.promise;

    expect({
      first: answers[0],
      opened: seen.opened,
    }).toMatchObject({
      first: { type: "failed", call: 1, error: { code: "link.invalid" } },
      opened: [],
    });
    port2.close();
  });

  it("asks again, showing the whole URL, when the App read restricted data after the person saw only the origin", async () => {
    let calls = 0;
    const channel: LinkChannel = {
      check: async (_resource, url) =>
        await Promise.resolve({
          url,
          origin: "https://help.example.com",
          confirm: false,
        }),
      open: async (_resource, url) => {
        calls += 1;
        return await Promise.resolve({
          url,
          origin: "https://help.example.com",
          confirm: true,
        });
      },
    };
    const { page, seen } = pageWith({ clicked: false });

    expect({
      answer: await answerTo(open(), channel, page),
      calls,
      seen: seen.confirmed,
    }).toStrictEqual({
      answer: { type: "opened", call: 1 },
      calls: 1,
      seen: [
        "https://help.example.com",
        "https://help.example.com https://help.example.com/guide",
      ],
    });
  });

  it("opens nothing confirmed after core revoked the link while the dialog waited", async () => {
    let revoked = false;
    const decision = (url: string): LinkDecision => {
      if (revoked) {
        throw Object.assign(new Error("Refused."), {
          code: "link.not_allowed",
        });
      }
      return { url, origin: "https://help.example.com", confirm: false };
    };
    const channel: LinkChannel = {
      check: async (_resource, url) => await Promise.resolve(decision(url)),
      open: async (_resource, url) => await Promise.resolve(decision(url)),
    };
    let checks = 0;
    const { page, seen } = pageWith({ clicked: true });
    const revoking: LinkPage = {
      ...page,
      // The click's activation held when core checked, and lapsed once it
      // recorded the open: the page asks in its dialog.
      active: () => {
        checks += 1;
        return checks === 1;
      },
      // The permission is revoked while the person reads that dialog; then
      // they confirm.
      confirm: async (question) => {
        const confirmed = await page.confirm(question);
        revoked = true;
        return confirmed;
      },
    };

    expect({
      answer: await answerTo(open(), channel, revoking),
      seen,
    }).toStrictEqual({
      answer: {
        type: "failed",
        call: 1,
        error: { code: "link.not_allowed", message: "Refused." },
      },
      seen: { confirmed: ["https://help.example.com"], opened: [] },
    });
  });

  it("opens nothing confirmed after the frame ended while the dialog waited", async () => {
    const { port1, port2 } = new MessageChannel();
    const core = coreDeciding({});
    const { page, seen } = pageWith({ clicked: true, stillActive: false });
    const asking = Promise.withResolvers<null>();
    const answer = Promise.withResolvers<boolean>();
    const close = openLinkPort(port1, core.channel, {
      ...page,
      confirm: async () => {
        asking.resolve(null);
        return await answer.promise;
      },
    });
    port2.start();
    port2.postMessage(open());
    await asking.promise;
    close();
    answer.resolve(true);
    const drained = Promise.withResolvers<null>();
    setTimeout(() => {
      drained.resolve(null);
    }, 0);
    await drained.promise;

    expect({
      checked: core.asked.checked.length,
      opened: seen.opened,
    }).toStrictEqual({
      // Only the check before the dialog: core isn't asked to open again.
      checked: 1,
      opened: [],
    });
    port2.close();
  });
});
