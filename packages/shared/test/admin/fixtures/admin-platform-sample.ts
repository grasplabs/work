import type {
  Deploy,
  Platform,
  PlatformResource,
  Release,
  UsageDay,
} from "../../../src/admin/admin-platform.ts";

/**
 * What the console holds about the sample organizations' own platforms, made up like the
 * organizations themselves, and the releases every company shares: so the admin's tools say how
 * every company's platform stands once the admin reads the console.
 */

export const SAMPLE_RELEASES: Release[] = [
  {
    id: "r418-3f9c2ab",
    commit: "3f9c2ab",
    on: "2026-10-14",
    changes: [
      "Workflows drawn left to right, with the apps over the steps",
      "Interviews keep their place when the connection drops",
      "Connect: fewer token refreshes for Microsoft 365",
    ],
    migrations: 1,
  },
  {
    id: "r412-91d0e47",
    commit: "91d0e47",
    on: "2026-10-07",
    changes: [
      "The brain answers with where it read it",
      "AI use counted per workflow",
    ],
    migrations: 0,
  },
  {
    id: "r405-c27b18f",
    commit: "c27b18f",
    on: "2026-09-30",
    changes: [
      "Sign-in with Google Workspace",
      "Teams cards on the organization page",
    ],
    migrations: 2,
  },
  {
    id: "r399-0a6e5d3",
    commit: "0a6e5d3",
    on: "2026-09-23",
    changes: ["First release with connect as a Worker of its own"],
    migrations: 1,
  },
];

/** Fourteen days of requests, from a weekday load and a share of errors, the last day today. */
const daysOf = (
  load: number,
  errors: number,
  last: string,
  lastErrors?: number
): UsageDay[] => {
  const end = Date.parse(`${last}T12:00:00Z`);
  return Array.from({ length: 14 }, (_, index) => {
    const on = new Date(end - (13 - index) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const weekday = new Date(`${on}T12:00:00Z`).getUTCDay();
    const requests = Math.round(
      load *
        (weekday === 0 || weekday === 6 ? 0.18 : 0.9 + ((index * 7) % 5) / 20)
    );
    const share =
      index === 13 && lastErrors !== undefined ? lastErrors : errors;
    return { on, requests, errors: Math.round(requests * share) };
  });
};

const deploy = (
  id: string,
  release: string,
  at: string,
  by: string,
  minutes: number,
  rest: Partial<Deploy> = {}
): Deploy => ({
  id,
  release,
  kind: "release",
  status: "done",
  step: "router",
  by,
  at,
  minutes,
  ...rest,
});

const RESOURCES = (
  client: string,
  sizes: [number, number]
): PlatformResource[] => [
  {
    kind: "d1",
    name: "grasp-core",
    holds: "The company’s workspace: people, workflows, runs",
    size: sizes[0],
  },
  {
    kind: "d1",
    name: "grasp-connect",
    holds: "Its connections and their tokens, sealed",
    size: 4,
  },
  {
    kind: "r2",
    name: "grasp-files",
    holds: "Files, transcripts and exports, in the EU",
    size: sizes[1],
  },
  {
    kind: "gateway",
    name: `grasp-${client}`,
    holds: "Every model call, counted and capped",
  },
  {
    kind: "secrets",
    name: "Secrets Store",
    holds: "The keys the Workers sign and seal with",
  },
];

export const SAMPLE_PLATFORMS: Record<
  "hartog" | "noordkade" | "veldkamp" | "vanrijn",
  Platform
> = {
  hartog: {
    client: "hartog",
    status: "active",
    address: "hartog.joingrasp.com",
    account: {
      id: "7c1e0d9a4b2f48e6a1c3d5f7b9e0a2c4",
      name: "Grasp · Hartog Groothandel",
    },
    workersDev: "grasp-hartog",
    ring: 0,
    pinned: null,
    provisioning: null,
    signIn: {
      providers: ["entra"],
      domains: ["hartog-groothandel.nl"],
      admins: ["Mirjam Kok"],
    },
    secrets: { generation: 3, rotated: "2026-10-13", live: false },
    configChanged: "2026-10-15",
    resources: RESOURCES("hartog", [182, 1240]),
    workers: [
      {
        name: "core",
        script: "grasp-core",
        release: "r418-3f9c2ab",
        version: "v-9a1f",
        deployed: "2026-10-14",
        live: [{ version: "v-9a1f", share: 100 }],
      },
      {
        name: "connect",
        script: "grasp-connect",
        release: "r418-3f9c2ab",
        version: "v-4c7e",
        deployed: "2026-10-14",
        live: [{ version: "v-4c7e", share: 100 }],
      },
    ],
    deploys: [
      deploy("d-hg-7", "r418-3f9c2ab", "2026-10-15T09:12:00Z", "Nick", 3, {
        kind: "settings_and_secrets",
        status: "failed",
        step: "workers",
        error: "smoke_timeout",
      }),
      deploy(
        "d-hg-6",
        "r418-3f9c2ab",
        "2026-10-14T08:02:00Z",
        "Rollout r418, ring 0",
        6
      ),
      deploy(
        "d-hg-5",
        "r412-91d0e47",
        "2026-10-07T08:05:00Z",
        "Rollout r412, ring 0",
        5
      ),
      deploy(
        "d-hg-4",
        "r405-c27b18f",
        "2026-09-30T08:04:00Z",
        "Rollout r405, ring 0",
        7
      ),
    ],
    usage: {
      requestsMonth: 214_380,
      cpuMsMonth: 3_912_000,
      aiUsdMonth: 186.4,
      days: daysOf(16_200, 0.003, "2026-10-15", 0.018),
    },
    url: "https://console.joingrasp.com/clients/hartog",
  },
  noordkade: {
    client: "noordkade",
    status: "active",
    address: "noordkade.joingrasp.com",
    account: {
      id: "2b8d4f6a0c1e43a5b7d9f1e3c5a7b9d0",
      name: "Grasp · Noordkade Finance",
    },
    workersDev: "grasp-noordkade",
    ring: 1,
    pinned: null,
    provisioning: null,
    signIn: {
      providers: ["entra", "google"],
      domains: ["noordkadefinance.nl"],
      admins: ["Sanne de Wit", "Pieter de Boer"],
    },
    secrets: { generation: 1, rotated: null, live: true },
    configChanged: null,
    resources: RESOURCES("noordkade", [96, 412]),
    workers: [
      {
        name: "core",
        script: "grasp-core",
        release: "r418-3f9c2ab",
        version: "v-9a1f",
        deployed: "2026-10-14",
        live: [{ version: "v-9a1f", share: 100 }],
      },
      {
        name: "connect",
        script: "grasp-connect",
        release: "r418-3f9c2ab",
        version: "v-4c7e",
        deployed: "2026-10-14",
        live: [{ version: "v-4c7e", share: 100 }],
      },
    ],
    deploys: [
      deploy(
        "d-nk-3",
        "r418-3f9c2ab",
        "2026-10-14T13:40:00Z",
        "Rollout r418, ring 1",
        5
      ),
      deploy(
        "d-nk-2",
        "r412-91d0e47",
        "2026-10-08T09:10:00Z",
        "Rollout r412, ring 1",
        4
      ),
      deploy(
        "d-nk-1",
        "r405-c27b18f",
        "2026-10-01T10:31:00Z",
        "Provisioning, by Jakob",
        9
      ),
    ],
    usage: {
      requestsMonth: 98_420,
      cpuMsMonth: 1_604_000,
      aiUsdMonth: 71.9,
      days: daysOf(7400, 0.002, "2026-10-15"),
    },
    url: "https://console.joingrasp.com/clients/noordkade",
  },
  veldkamp: {
    client: "veldkamp",
    status: "active",
    address: "veldkamp.joingrasp.com",
    account: {
      id: "e4a6c8e0b2d44f61a3c5e7b9d1f3a5c7",
      name: "Grasp · Veldkamp Installatie",
    },
    workersDev: "grasp-veldkamp",
    ring: 2,
    pinned: null,
    provisioning: null,
    signIn: {
      providers: ["google"],
      domains: ["veldkamp-installatie.nl"],
      admins: ["Wim Brouwer"],
    },
    secrets: { generation: 1, rotated: null, live: true },
    configChanged: null,
    resources: RESOURCES("veldkamp", [41, 88]),
    workers: [
      {
        name: "core",
        script: "grasp-core",
        release: "r412-91d0e47",
        version: "v-77b2",
        deployed: "2026-10-09",
        live: [{ version: "v-77b2", share: 100 }],
      },
      {
        name: "connect",
        script: "grasp-connect",
        release: "r412-91d0e47",
        version: "v-30d9",
        deployed: "2026-10-09",
        live: [{ version: "v-30d9", share: 100 }],
      },
    ],
    deploys: [
      deploy(
        "d-vk-2",
        "r412-91d0e47",
        "2026-10-09T08:20:00Z",
        "Rollout r412, ring 2",
        4
      ),
      deploy(
        "d-vk-1",
        "r405-c27b18f",
        "2026-09-29T14:02:00Z",
        "Provisioning, by Ruben",
        11
      ),
    ],
    usage: {
      requestsMonth: 31_050,
      cpuMsMonth: 512_000,
      aiUsdMonth: 18.2,
      days: daysOf(2300, 0.001, "2026-10-15"),
    },
    url: "https://console.joingrasp.com/clients/veldkamp",
  },
  vanrijn: {
    client: "vanrijn",
    status: "none",
    address: "vanrijn.joingrasp.com",
    account: null,
    workersDev: null,
    ring: 2,
    pinned: null,
    provisioning: null,
    signIn: null,
    secrets: { generation: 1, rotated: null, live: true },
    configChanged: null,
    resources: [],
    workers: [],
    deploys: [],
    usage: { requestsMonth: 0, cpuMsMonth: 0, aiUsdMonth: 0, days: [] },
    url: null,
  },
};
