import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Each file starts with the Brain's database at its committed migrations.
await applyD1Migrations(env.BRAIN, env.BRAIN_MIGRATIONS);
