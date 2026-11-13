import { buildApp } from "./app.js";
import { env } from "./config/env.js";
import { purgeExpiredRecoveryArtifacts } from "./lib/recoveryRetention.js";
import { startNotificationScheduler } from "./notifications/scheduler.js";
import { NOTIFICATION_JOBS } from "./notifications/jobs.js";

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

  // Phase 3 notification engine (D-23/D-24): in-process scheduler; the DB lock makes
  // it safe with several instances. Off in tests unless explicitly enabled.
  const schedulerOn = env.NOTIFICATION_SCHEDULER_ENABLED ?? env.NODE_ENV !== "test";
  if (schedulerOn) {
    const scheduler = startNotificationScheduler(NOTIFICATION_JOBS, {
      log: { info: (o, m) => app.log.info(o, m), error: (o, m) => app.log.error(o, m) },
    });
    app.addHook("onClose", async () => scheduler.stop());
    app.log.info({ instance: scheduler.instanceId }, "notification scheduler started");
  }
}

main();
