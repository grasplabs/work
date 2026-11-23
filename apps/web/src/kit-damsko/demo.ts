import type { ComponentType } from "react";

/**
 * One small use of each of Damsko's components (packages/ui), by the
 * component's file name: what the local gallery draws
 * (routes/kit_.damsko.tsx). demos.test.ts holds them to the components
 * installed, so one added without a demo fails.
 */
export type Demos = Record<string, ComponentType>;
