import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, openSync, fstatSync, readSync, closeSync, statSync, unlinkSync, renameSync } from "fs";

import { join, dirname } from "path";

import { fileURLToPath } from "url";

import { randomUUID } from "crypto";

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data");

const MSG_FILE = join(DATA_DIR, "messages.ndjson");

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, {
    recursive: true
  });
}

function appendMessage(msg) {
  ensureDir();
  const rec = {
    id: msg.id || randomUUID(),
    ts: msg.ts || Math.floor(Date.now() / 1e3),
    steamid64: String(msg.steamid64 || ""),
    nick: String(msg.nick || ""),
    role: String(msg.role || ""),
    text: String(msg.text || ""),
    attachments: Array.isArray(msg.attachments) ? msg.attachments : [],
    reply_to: msg.reply_to && typeof msg.reply_to === "object" ? {
      id: String(msg.reply_to.id || ""),
      steamid64: String(msg.reply_to.steamid64 || ""),
      nick: String(msg.reply_to.nick || ""),
      text: String(msg.reply_to.text || "").slice(0, 180)
    } : null
  };
  appendFileSync(MSG_FILE, JSON.stringify(rec) + "\n", "utf8");
  return rec;
}

function readLastMessages(limit = 100, beforeId = null) {
  ensureDir();
  if (!existsSync(MSG_FILE)) return {
    items: [],
    hasMore: false
  };
  let lines;
  try {
    const fd = openSync(MSG_FILE, "r");
    try {
      const size = fstatSync(fd).size;
      const chunk = Math.min(size, 1024 * 1024);
      const buf = Buffer.alloc(chunk);
      readSync(fd, buf, 0, chunk, size - chunk);
      let text = buf.toString("utf8");
      if (size > chunk) {
        const nl = text.indexOf("\n");
        if (nl >= 0) text = text.slice(nl + 1);
      }
      lines = text.split("\n").filter(Boolean);
    } finally {
      closeSync(fd);
    }
  } catch {
    return {
      items: [],
      hasMore: false
    };
  }
  const all = [];
  for (const l of lines) {
    try {
      all.push(JSON.parse(l));
    } catch {}
  }
  let slice = all;
  if (beforeId) {
    const idx = all.findIndex(m => m.id === beforeId);
    if (idx > 0) slice = all.slice(0, idx); else if (idx === 0) slice = [];
  }
  const items = slice.slice(-limit);
  const hasMore = slice.length > items.length;
  return {
    items: items,
    hasMore: hasMore
  };
}

function deleteMessage(id) {
  ensureDir();
  if (!existsSync(MSG_FILE)) return {
    ok: false,
    deleted: null
  };
  let deleted = null;
  try {
    const lines = readFileSync(MSG_FILE, "utf8").split("\n").filter(Boolean);
    const kept = [];
    for (const l of lines) {
      try {
        const m = JSON.parse(l);
        if (m.id === id) {
          deleted = m;
          continue;
        }
        kept.push(l);
      } catch {
        kept.push(l);
      }
    }
    const tmp = `${MSG_FILE}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, kept.join("\n") + (kept.length ? "\n" : ""), "utf8");
    try {
      renameSync(tmp, MSG_FILE);
    } catch (e) {
      try {
        unlinkSync(tmp);
      } catch {}
      throw e;
    }
  } catch {
    return {
      ok: false,
      deleted: null
    };
  }
  return {
    ok: !!deleted,
    deleted: deleted
  };
}

function messagesFileSize() {
  try {
    return existsSync(MSG_FILE) ? statSync(MSG_FILE).size : 0;
  } catch {
    return 0;
  }
}

export { appendMessage, deleteMessage, messagesFileSize, readLastMessages };
