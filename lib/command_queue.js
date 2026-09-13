import { randomUUID } from "crypto";

import { db } from "./db.js";

import { readQueueFile, writeQueueFile } from "./helpers.js";

function makeCommandId() {
  return `cmd_${Date.now()}_${randomUUID()}`.slice(0, 64);
}

/**
 * Put a command into the same MySQL queue consumed by GMod /api/get.
 * The old JSON queue has no consumer in the deployed server path.
 */
async function enqueueCommand(text, adminSid64 = "", type = "console") {
  const commandText = String(text || "").trim();
  if (!commandText) throw new Error("EMPTY_COMMAND");
  if (commandText.length > 512) throw new Error("COMMAND_TOO_LONG");
  if (type !== "console") throw new Error("BAD_TYPE");

  const now = Math.floor(Date.now() / 1e3);
  const id = makeCommandId();
  await db().query(
    `INSERT INTO command_queue
      (id, type, text, admin_steamid64, done, processing, processing_time, time, tries, done_time, error)
     VALUES (?, ?, ?, ?, 0, 0, 0, ?, 0, 0, NULL)`,
    [ id, type, commandText, String(adminSid64 || ""), now ]
  );
  return id;
}

/**
 * One-time compatibility migration for commands written by the old JSON
 * writer before the site was switched to the MySQL queue.
 */
async function migrateLegacyQueue() {
  const legacy = readQueueFile();
  if (!Array.isArray(legacy) || legacy.length === 0) return 0;

  let migrated = 0;
  for (const command of legacy) {
    if (!command || !command.id || !command.text) continue;
    const id = String(command.id).slice(0, 64);
    const text = String(command.text).trim();
    if (!id || !text || text.length > 512) continue;
    await db().query(
      `INSERT IGNORE INTO command_queue
        (id, type, text, admin_steamid64, done, processing, processing_time, time, tries, done_time, error)
       VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)`, [
        id,
        "console",
        text,
        String(command.admin_steamid64 || command.admin_sid64 || ""),
        command.done ? 1 : 0,
        parseInt(command.time || Math.floor(Date.now() / 1e3), 10) || Math.floor(Date.now() / 1e3),
        parseInt(command.tries || 0, 10) || 0,
        parseInt(command.done_time || 0, 10) || 0,
        command.error ? String(command.error).slice(0, 64) : null
      ]
    );
    migrated++;
  }
  writeQueueFile([]);
  return migrated;
}

export { enqueueCommand, migrateLegacyQueue };
