import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  boundSecrets,
  cfRunner,
  neededSecrets,
  setUpAccount,
} from "./cloudflare-account-setup.ts";
import type { Cf, Report, SetupOptions } from "./cloudflare-account-setup.ts";

// The fresh-account setup (scripts/cloudflare-account-setup.ts) against a
// stand-in for the cf CLI, the one outside system: it creates what a fresh
// account lacks, in the EU where it should, creates nothing a second time,
// waits on what needs a deployed Worker or the zone, says what cf can't do
// yet, refuses to change what points elsewhere, and never sends or says a
// secret.

const accountId = "0123456789abcdef0123456789abcdef";
const zoneId = "zone-1";

/** A Cloudflare account and zone, as far as the script reads and writes them. */
interface FakeState {
  namespaces: string[];
  d1: { name: string; jurisdiction?: string }[];
  r2: { name: string; jurisdiction: string }[];
  kv: string[];
  stores: string[];
  secrets: string[];
  /** The zone: none, added but not delegated yet, or active. */
  zone: "none" | "pending" | "active";
  workers: string[];
  dns: { type: string; name: string; content: string; proxied: boolean }[];
  emailRouting: boolean;
  /** The catch-all: on or off, and where it sends mail. */
  catchAll: { enabled: boolean; type: string; to: string } | null;
}

/** A command's flags, by name: `--name x` is `{ name: "x" }`. */
const flagsOf = (args: readonly string[]): Map<string, string> => {
  const flags = new Map<string, string>();
  for (const [at, arg] of args.entries()) {
    if (arg.startsWith("--")) {
      flags.set(arg.slice(2), args[at + 1] ?? "");
    }
  }
  return flags;
};

/** A field of a command's `--body`, as text. */
const bodyField = (flags: Map<string, string>, key: string): string => {
  const body: unknown = JSON.parse(flags.get("body") ?? "null");
  return typeof body === "object" && body !== null
    ? String(Reflect.get(body, key))
    : "";
};

/** One page of `items`, as cf answers a paged list. */
const pageOf = (items: unknown[], flags: Map<string, string>): unknown[] => {
  const page = Number(flags.get("page") ?? 1);
  const size = Number(flags.get("per-page") ?? items.length);
  return items.slice((page - 1) * size, page * size);
};

/** The fake's answers, by command (the arguments before the first flag). */
const commandsOf = (
  state: FakeState
): Record<string, (flags: Map<string, string>) => unknown> => ({
  "workers-for-platforms dispatch-namespaces list": () =>
    state.namespaces.map((name) => ({ namespace_name: name })),
  "workers-for-platforms dispatch-namespaces create": (flags) => {
    state.namespaces.push(flags.get("name") ?? "");
    return {};
  },
  "d1 list": (flags) =>
    pageOf(
      state.d1.filter(({ name }) => name === flags.get("name")),
      flags
    ),
  "d1 create": (flags) => {
    state.d1.push({
      name: flags.get("name") ?? "",
      jurisdiction: flags.get("jurisdiction") ?? "default",
    });
    return {};
  },
  "r2 buckets list": (flags) => ({
    buckets: state.r2.filter(
      ({ name, jurisdiction }) =>
        name.includes(flags.get("name-contains") ?? "") &&
        jurisdiction === (flags.get("cf-r2-jurisdiction") ?? "default")
    ),
  }),
  "r2 buckets create": (flags) => {
    state.r2.push({
      name: flags.get("name") ?? "",
      jurisdiction: flags.get("cf-r2-jurisdiction") ?? "default",
    });
    return {};
  },
  "kv namespaces list": (flags) =>
    pageOf(
      state.kv.map((title) => ({ title, id: title })),
      flags
    ),
  "kv namespaces create": (flags) => {
    state.kv.push(flags.get("title") ?? "");
    return {};
  },
  "secrets-store stores list": (flags) =>
    pageOf(
      state.stores.map((id) => ({ id, name: id })),
      flags
    ),
  "secrets-store secrets list": (flags) =>
    pageOf(
      state.secrets.map((name) => ({ name })),
      flags
    ),
  "zones list": (flags) =>
    state.zone !== "none" && flags.get("account-id") === accountId
      ? [
          {
            id: zoneId,
            name: flags.get("name"),
            status: state.zone,
            name_servers: ["kay.ns.cloudflare.com", "trey.ns.cloudflare.com"],
          },
        ]
      : [],
  "workers list": (flags) =>
    pageOf(
      state.workers.map((name) => ({ id: `id-${name}`, name })),
      flags
    ),
  "dns records list": (flags) =>
    pageOf(
      state.dns.filter(
        ({ name, type }) =>
          name === flags.get("name") && type === (flags.get("type") ?? type)
      ),
      flags
    ),
  "dns records create": (flags) => {
    state.dns.push({
      type: bodyField(flags, "type"),
      name: bodyField(flags, "name"),
      content: bodyField(flags, "content"),
      proxied: bodyField(flags, "proxied") === "true",
    });
    return {};
  },
  "email-routing settings get": () => ({ enabled: state.emailRouting }),
  "email-routing enable": () => {
    state.emailRouting = true;
    return {};
  },
  "email-routing rules catch-all get": () => ({
    enabled: state.catchAll?.enabled ?? false,
    actions:
      state.catchAll === null
        ? [{ type: "drop" }]
        : [{ type: state.catchAll.type, value: [state.catchAll.to] }],
  }),
  "email-routing rules catch-all update": () => {
    state.catchAll = { enabled: true, type: "worker", to: "grasp-work-router" };
    return null;
  },
});

/** The commands that change something, by their last word. */
const changing = new Set(["create", "enable", "update", "put", "delete"]);

/** A stand-in for cf, on one account, starting as `start` says. */
const fakeCf = (start: Partial<FakeState> = {}) => {
  const state: FakeState = {
    namespaces: [],
    d1: [],
    r2: [],
    kv: [],
    stores: ["store-1"],
    secrets: [],
    zone: "active",
    workers: [],
    dns: [],
    emailRouting: start.catchAll !== undefined && start.catchAll !== null,
    catchAll: null,
    ...start,
  };
  const commands = commandsOf(state);
  const writes: string[] = [];
  const everything: string[] = [];
  const cf: Cf = async (args) => {
    await Promise.resolve();
    const firstFlag = args.findIndex((arg) => arg.startsWith("-"));
    const words = args.slice(0, firstFlag === -1 ? args.length : firstFlag);
    const command = words.join(" ");
    const flags = flagsOf(args);
    everything.push(args.join(" "));
    if (changing.has(words.at(-1) ?? "")) {
      writes.push(command);
    }
    const zoned =
      command.startsWith("dns") || command.startsWith("email-routing");
    if (zoned && flags.get("zone") !== zoneId) {
      throw new Error(`${command} without the zone`);
    }
    const answer = commands[command];
    if (answer === undefined) {
      throw new Error(`cf has no command ${command}`);
    }
    return answer(flags);
  };
  return { state, writes, everything, cf };
};

const optionsFor = (
  cf: Cf,
  more: Partial<SetupOptions> = {}
): SetupOptions => ({
  accountId,
  domain: "ongrasp.app",
  adminHost: "admin.ongrasp.app",
  dryRun: false,
  cf,
  secrets: ["CLIENT_KEY", "ROUTER_KEY"],
  ...more,
});

/** Each step's outcome, by step. */
const outcomes = (reports: Report[]) =>
  Object.fromEntries(reports.map(({ step, outcome }) => [step, outcome]));

describe("setting up a fresh account", () => {
  it("creates what the account lacks, in the EU where it should, and nothing again on a second run", async () => {
    const cloudflare = fakeCf({
      workers: ["grasp-work-admin", "grasp-work-router"],
    });

    const first = await setUpAccount(optionsFor(cloudflare.cf));
    const writesFirst = cloudflare.writes.length;
    const second = await setUpAccount(optionsFor(cloudflare.cf));

    expect({
      first: outcomes(first),
      second: new Set(second.map(({ outcome }) => outcome)),
      writesAgain: cloudflare.writes.slice(writesFirst),
      d1: cloudflare.state.d1,
      r2: cloudflare.state.r2,
      dns: cloudflare.state.dns,
      catchAll: cloudflare.state.catchAll,
    }).toStrictEqual({
      first: {
        "dispatch namespace grasp-work-clients": "created",
        "D1 database grasp-work-admin (eu)": "created",
        "R2 bucket grasp-work-releases (eu)": "created",
        "KV namespace grasp-work-router-hosts": "created",
        "Secrets Store": "exists",
        "Secrets Store secrets": "missing",
        "zone ongrasp.app": "exists",
        "DNS record *.ongrasp.app": "created",
        "route *.ongrasp.app/*": "manual",
        "custom domain admin.ongrasp.app": "manual",
        "Email Routing on ongrasp.app": "created",
        "Email Routing catch-all": "created",
      },
      // Only the secrets the operator still has to put in stay missing, and
      // what cf can't do yet stays the operator's.
      second: new Set(["exists", "missing", "manual"]),
      writesAgain: [],
      d1: [{ name: "grasp-work-admin", jurisdiction: "eu" }],
      r2: [{ name: "grasp-work-releases", jurisdiction: "eu" }],
      dns: [
        {
          type: "AAAA",
          name: "*.ongrasp.app",
          content: "100::",
          proxied: true,
        },
      ],
      catchAll: { enabled: true, type: "worker", to: "grasp-work-router" },
    });
  });

  it("names the secrets the store lacks, and never creates or changes one", async () => {
    const cloudflare = fakeCf({ secrets: ["ROUTER_KEY"] });

    const reports = await setUpAccount(optionsFor(cloudflare.cf));

    expect({
      report: reports.find(({ step }) => step === "Secrets Store secrets"),
      // Every secrets command run: the list of names, nothing else.
      secretCommands: cloudflare.everything
        .filter((command) => command.startsWith("secrets-store secrets"))
        .map((command) => command.split(" --")[0]),
    }).toStrictEqual({
      report: {
        step: "Secrets Store secrets",
        outcome: "missing",
        detail: "put these in: CLIENT_KEY",
      },
      secretCommands: ["secrets-store secrets list"],
    });
  });

  it("says to create the store by hand when the account has none, since cf can't", async () => {
    const cloudflare = fakeCf({ stores: [] });

    const reports = await setUpAccount(optionsFor(cloudflare.cf));

    expect({
      store: outcomes(reports)["Secrets Store"],
      secrets: reports.find(({ step }) => step === "Secrets Store secrets"),
      stores: cloudflare.state.stores,
    }).toStrictEqual({
      store: "manual",
      secrets: {
        step: "Secrets Store secrets",
        outcome: "missing",
        detail:
          "create a Secrets Store named grasp-work in the dashboard, put these in: CLIENT_KEY, ROUTER_KEY, then run again",
      },
      stores: [],
    });
  });

  it("waits on the router's first deploy for the catch-all, and on the zone for everything on it", async () => {
    const undeployed = fakeCf();
    const noZone = fakeCf({ zone: "none" });

    const beforeDeploy = outcomes(
      await setUpAccount(optionsFor(undeployed.cf))
    );
    const withoutZone = await setUpAccount(optionsFor(noZone.cf));

    expect({
      catchAll: beforeDeploy["Email Routing catch-all"],
      emailRouting: beforeDeploy["Email Routing on ongrasp.app"],
      zone: outcomes(withoutZone)["zone ongrasp.app"],
      zoneSteps: withoutZone
        .map(({ step }) => step)
        .filter(
          (step) => step.includes("ongrasp.app") || step.startsWith("Email")
        ),
      zoneWrites: noZone.writes.filter(
        (write) => write.startsWith("dns") || write.startsWith("email-routing")
      ),
    }).toStrictEqual({
      catchAll: "pending",
      emailRouting: "created",
      zone: "pending",
      zoneSteps: ["zone ongrasp.app"],
      zoneWrites: [],
    });
  });

  it("prepares a zone that isn't delegated yet, and leaves Email Routing until it is", async () => {
    const cloudflare = fakeCf({ zone: "pending" });

    const reports = await setUpAccount(optionsFor(cloudflare.cf));
    const byStep = outcomes(reports);

    expect({
      zone: reports.find(({ step }) => step === "zone ongrasp.app"),
      wildcard: byStep["DNS record *.ongrasp.app"],
      emailRouting: byStep["Email Routing on ongrasp.app"],
      emailWrites: cloudflare.writes.filter((write) =>
        write.startsWith("email-routing")
      ),
    }).toStrictEqual({
      zone: {
        step: "zone ongrasp.app",
        outcome: "pending",
        detail:
          "point its nameservers at kay.ns.cloudflare.com and trey.ns.cloudflare.com, then run again",
      },
      wildcard: "created",
      emailRouting: "pending",
      emailWrites: [],
    });
  });

  it("only reads, and says what it would create, on a dry run", async () => {
    const cloudflare = fakeCf({
      workers: ["grasp-work-admin", "grasp-work-router"],
    });

    const reports = await setUpAccount(
      optionsFor(cloudflare.cf, { dryRun: true })
    );

    expect({
      writes: cloudflare.writes,
      outcomes: new Set(reports.map(({ outcome }) => outcome)),
    }).toStrictEqual({
      writes: [],
      outcomes: new Set([
        "would_create",
        "exists",
        "missing",
        "manual",
        "pending",
      ]),
    });
  });
});

const deployed = ["grasp-work-admin", "grasp-work-router"];

describe("what points elsewhere already", () => {
  it("refuses to repoint an Email Routing catch-all that sends mail somewhere else, on or off", async () => {
    const on = { enabled: true, type: "worker", to: "someone-elses-worker" };
    const off = { enabled: false, type: "forward", to: "someone@example.com" };
    const enabled = fakeCf({ workers: deployed, catchAll: on });
    const disabled = fakeCf({ workers: deployed, catchAll: off });

    await expect(setUpAccount(optionsFor(enabled.cf))).rejects.toThrow(
      "sends mail somewhere other than grasp-work-router"
    );
    await expect(setUpAccount(optionsFor(disabled.cf))).rejects.toThrow(
      "sends mail somewhere other than grasp-work-router"
    );
    expect({
      catchAlls: [enabled.state.catchAll, disabled.state.catchAll],
      catchAllWrites: [...enabled.writes, ...disabled.writes].filter((write) =>
        write.includes("catch-all")
      ),
    }).toStrictEqual({ catchAlls: [on, off], catchAllWrites: [] });
  });

  it("refuses to turn Email Routing on over the zone's own mail", async () => {
    const mx = {
      type: "MX",
      name: "ongrasp.app",
      content: "mail.example.com",
      proxied: false,
    };
    const cloudflare = fakeCf({ workers: deployed, dns: [mx] });

    await expect(setUpAccount(optionsFor(cloudflare.cf))).rejects.toThrow(
      "already has MX records for other mail"
    );
    expect({
      emailRouting: cloudflare.state.emailRouting,
      writes: cloudflare.writes.filter((write) => write.startsWith("email")),
      mx: cloudflare.state.dns.filter(({ type }) => type === "MX"),
    }).toStrictEqual({ emailRouting: false, writes: [], mx: [mx] });
  });

  it("refuses a wildcard record that isn't the router's own proxied one", async () => {
    const unproxied = {
      type: "AAAA",
      name: "*.ongrasp.app",
      content: "100::",
      proxied: false,
    };
    const elsewhere = {
      type: "CNAME",
      name: "*.ongrasp.app",
      content: "someone.example.com",
      proxied: true,
    };

    for (const record of [unproxied, elsewhere]) {
      const cloudflare = fakeCf({ dns: [record] });
      // oxlint-disable-next-line no-await-in-loop -- one zone at a time
      await expect(setUpAccount(optionsFor(cloudflare.cf))).rejects.toThrow(
        "already has a record that isn't the router's proxied 100::"
      );
      expect(cloudflare.state.dns).toStrictEqual([record]);
    }
  });

  it("refuses a database it can't tell is in the EU", async () => {
    const cloudflare = fakeCf({ d1: [{ name: "grasp-work-admin" }] });

    await expect(setUpAccount(optionsFor(cloudflare.cf))).rejects.toThrow(
      "D1 database grasp-work-admin exists in jurisdiction undefined, not eu"
    );
  });
});

describe("reading cf's lists", () => {
  it("stops when a list keeps answering full pages, as if cf ignored --page", async () => {
    const full = Array.from({ length: 100 }, (_, at) => ({
      title: `kv-${at}`,
    }));
    const cf: Cf = async (args) => {
      await Promise.resolve();
      return args.includes("kv") ? full : [];
    };

    await expect(setUpAccount(optionsFor(cf))).rejects.toThrow(
      "answered more than 100 full pages"
    );
  });
});

// A stand-in `cf` executable on PATH: it prints what it was run with, or
// fails as cf does, on stderr.
const withFakeCf = async <T>(
  script: string,
  test: () => Promise<T>
): Promise<T> => {
  const bin = await mkdtemp(path.join(tmpdir(), "fake-cf-"));
  await writeFile(path.join(bin, "cf"), `#!/bin/sh\n${script}\n`);
  await chmod(path.join(bin, "cf"), 0o755);
  const saved = { ...process.env };
  process.env.PATH = `${bin}${path.delimiter}${saved.PATH ?? ""}`;
  process.env.CLOUDFLARE_API_TOKEN = "a-token-cf-must-not-use";
  try {
    return await test();
  } finally {
    process.env = saved;
    await rm(bin, { recursive: true });
  }
};

describe(cfRunner, () => {
  it("runs cf on the account with its own login, never a token, and reads its JSON", async () => {
    const answer = await withFakeCf(
      `printf '{"args":"%s","account":"%s","token":"%s"}' "$*" "$CLOUDFLARE_ACCOUNT_ID" "$CLOUDFLARE_API_TOKEN"`,
      async () => await cfRunner(accountId)(["d1", "list", "--name", "x"])
    );

    expect(answer).toStrictEqual({
      args: "d1 list --name x",
      account: accountId,
      token: "",
    });
  });

  it("names the command and what cf said when it fails", async () => {
    await expect(
      withFakeCf(
        "echo 'Not authorized for this account' >&2; exit 1",
        async () => await cfRunner(accountId)(["kv", "namespaces", "list"])
      )
    ).rejects.toThrow(
      "cf kv namespaces list failed: Not authorized for this account"
    );
  });
});

describe(neededSecrets, () => {
  it("takes every secret the admin and the router bind, once each", () => {
    const configs: Record<string, string> = {
      "apps/admin/wrangler.jsonc":
        '{ "secret_name": "ROUTER_KEY" }, { "secret_name": "CLIENT_KEY" }',
      "apps/router/wrangler.jsonc": '{ "secret_name": "ROUTER_KEY" }',
    };
    expect({
      names: neededSecrets((file) => configs[file] ?? ""),
      real: neededSecrets().includes("ROUTER_KEY"),
      parsed: boundSecrets('"secret_name": "A", "secret_name":"B"'),
    }).toStrictEqual({
      names: ["CLIENT_KEY", "ROUTER_KEY"],
      real: true,
      parsed: ["A", "B"],
    });
  });
});
