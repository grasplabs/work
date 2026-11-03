import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Each file starts with the Brain's database at its committed migrations.
await applyD1Migrations(env.BRAIN, env.BRAIN_MIGRATIONS);
await applyD1Migrations(env.RESTORED, env.BRAIN_MIGRATIONS);
