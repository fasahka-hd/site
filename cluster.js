import cluster from "cluster";
import { availableParallelism } from "os";
// ВАЖНО: каждый воркер запускает своего Discord-бота и Telegram-поллер.
// Два воркера с одним токеном = конфликт Telegram getUpdates (409),
// двойные ответы бота и лишние подключения к Discord-шлюзу.
// Поэтому по умолчанию 1 воркер. Хочешь больше — задай WEB_CONCURRENCY=N.
const WORKERS = Math.max(1, Math.min(availableParallelism(), parseInt(process.env.WEB_CONCURRENCY || "1", 10) || 1));
const replaceOnExit = new Set();
function startWorker() {
  const worker = cluster.fork();
  console.log(`[MASTER] Worker ${worker.process.pid} started`);
}
if (process.env.PM2_ID !== undefined || process.env.PM2_HOME) {
  await import("./server.js");
} else if (cluster.isPrimary) {
  console.log(`[MASTER] PID ${process.pid} starting ${WORKERS} workers…`);
  for (let i = 0; i < WORKERS; i++) startWorker();
  cluster.on("exit", (worker, code, signal) => {
    if (worker.exitedAfterDisconnect) {
      console.log(`[MASTER] Worker ${worker.process.pid} exited gracefully.`);
      if (replaceOnExit.has(worker.id)) {
        replaceOnExit.delete(worker.id);
        startWorker();
      }
    } else {
      console.error(`[MASTER] Worker ${worker.process.pid} died (code=${code}, signal=${signal}). Respawning…`);
      startWorker();
    }
  });
  let reloading = false;
  const reloadWorkers = () => {
    if (reloading) return;
    reloading = true;
    console.log("[MASTER] Reloading workers…");
    const workers = Object.values(cluster.workers || {});
    let idx = 0;
    function replaceNext() {
      if (idx >= workers.length) {
        reloading = false;
        console.log("[MASTER] Reload complete.");
        return;
      }
      const w = workers[idx++];
      if (!w || w.isDead()) {
        replaceNext();
        return;
      }
      replaceOnExit.add(w.id);
      w.disconnect();
      const t = setTimeout(() => {
        if (!w.isDead()) {
          console.error(`[MASTER] Worker ${w.process.pid} did not exit in 30s, killing.`);
          w.kill("SIGTERM");
        }
      }, 3e4);
      w.on("exit", () => {
        clearTimeout(t);
        replaceNext();
      });
    }
    replaceNext();
  };
  process.on("SIGUSR2", reloadWorkers);
  process.on("SIGHUP", reloadWorkers);
  process.on("SIGTERM", () => {
    console.log("[MASTER] SIGTERM received, disconnecting workers…");
    for (const w of Object.values(cluster.workers || {})) {
      if (w && !w.isDead()) w.disconnect();
    }
    setTimeout(() => process.exit(0), 3e4).unref();
  });
} else {
  await import("./server.js");
}
