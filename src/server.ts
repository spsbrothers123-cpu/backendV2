import { buildApp } from "./app.js";
import { env } from "./config/env.js";
import { purgeExpiredRecoveryArtifacts } from "./lib/recoveryRetention.js";

async function main() {
  const app = await buildApp();
  try {
    await app.listen({ port: env.PORT, host: "0.0.0.0" });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  // Hourly purge of long-dead recovery grants/challenges. unref() so it never
  // keeps the process alive; failures are logged, never fatal.
  const timer = setInterval(() => {
    purgeExpiredRecoveryArtifacts().catch((err) => app.log.error({ err }, "recovery purge failed"));
  }, 60 * 60_000);
  timer.unref();
}

main();
