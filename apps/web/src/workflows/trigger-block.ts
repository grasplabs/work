import type { TriggerKind } from "@grasp-os/shared/workflow-triggers";
import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

import type { TriggerBlock } from "./overview.ts";

// Why a live workflow starts nothing, in one sentence, on its row and its
// page: its trigger waits for an admin to allow it (by what it is), or it
// can't start it at all (refused, stopped, its source deleted).

const waitingWords: Readonly<Record<TriggerKind, MessageDescriptor>> = {
  email: msg`Waiting for an admin to allow its email trigger`,
  schedule: msg`Waiting for an admin to allow its schedule`,
  connector: msg`Waiting for an admin to allow its connection trigger`,
  webhook: msg`Waiting for an admin to allow its webhook`,
};

export const triggerBlockText = (block: TriggerBlock, i18n: I18n): string =>
  block.why === "waiting"
    ? i18n._(waitingWords[block.kind])
    : i18n._(msg`Its trigger can't start it`);
