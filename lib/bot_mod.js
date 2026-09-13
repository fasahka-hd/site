import crypto from "node:crypto";

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";

import { db } from "./db.js";

import { decodeIfNeeded, logAdminAction, readQueueFile, writeQueueFile } from "./helpers.js";

import { sendWarnLog } from "./discord_state.js";

import { withQueueLock } from "./queue_lock.js";

import { normSteam, getTexLogs } from "../routes/tex_public.js";

const PENDING_TTL_MS = 2 * 60 * 1e3;

const MAX_BAN_SECONDS = 10 * 365 * 24 * 3600;

const pendingModActions = new Map;

const ACTIVE_BAN_SQL = `(COALESCE(unban_reason,'') REGEXP '^[0-9]+\\\\[STEAM_' OR COALESCE(unban_reason,'') = '') AND ((ban_len = 0 AND unban_time = 0) OR (ban_len <> 0 AND (unban_time > UNIX_TIMESTAMP() OR (unban_time = 0 AND ban_time + ban_len > UNIX_TIMESTAMP()))))`;

const COLORS = {
  info: 5793266,
  ban: 15548997,
  warn: 16096779,
  ok: 5763719,
  cancel: 9807270,
  confirm: 16705372
};

const ACTION_META = {
  ban: {
    emoji: "🔨",
    doneTitle: "Бан выдан",
    confirmTitle: "🛑 Подтверждение бана",
    question: "Точно забанить игрока?",
    yes: "✅ Да, забанить",
    color: COLORS.ban
  },
  warn: {
    emoji: "⚠️",
    doneTitle: "Варн выдан",
    confirmTitle: "⚠️ Подтверждение варна",
    question: "Точно выдать варн игроку?",
    yes: "✅ Да, выдать варн",
    color: COLORS.warn
  },
  unban: {
    emoji: "🕊️",
    doneTitle: "Игрок разбанен",
    confirmTitle: "🕊️ Подтверждение разбана",
    question: "Точно разбанить игрока?",
    yes: "✅ Да, разбанить",
    color: COLORS.ok
  },
  unwarn: {
    emoji: "✅",
    doneTitle: "Варн снят",
    confirmTitle: "✅ Подтверждение снятия варна",
    question: "Точно снять последний варн игрока?",
    yes: "✅ Да, снять варн",
    color: COLORS.ok
  }
};

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function fmtMoney(v) {
  v = Number(v || 0);
  return `${v > 0 ? "+" : ""}${Math.round(v).toLocaleString("ru-RU")} ₽`;
}

function ruPlural(n, one, few, many) {
  const n10 = Math.abs(n) % 10;
  const n100 = Math.abs(n) % 100;
  if (n10 === 1 && n100 !== 11) return one;
  if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) return few;
  return many;
}

function parseBanDurationToken(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return null;
  if (/^(perm|perma|перм|перманент|перманентно|навсегда|0)$/.test(s)) return {
    seconds: 0
  };
  const m = s.match(/^(\d{1,4})\s*(mo|мес|mi|min|мин|м|m|h|ч|d|д|w|н)$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2].toLowerCase();
  let seconds = 0;
  if (unit === "mo" || unit === "мес") seconds = n * 2592e3; else if (unit === "mi" || unit === "min" || unit === "мин" || unit === "м" || unit === "m") seconds = n * 60; else if (unit === "h" || unit === "ч") seconds = n * 3600; else if (unit === "d" || unit === "д") seconds = n * 86400; else if (unit === "w" || unit === "н") seconds = n * 604800;
  seconds = Math.min(seconds, MAX_BAN_SECONDS);
  return {
    seconds: seconds
  };
}

function fmtDuration(seconds) {
  seconds = parseInt(seconds || 0, 10);
  if (!seconds) return "Перманентно";
  const units = [ [ 2592e3, "месяц", "месяца", "месяцев" ], [ 604800, "неделя", "недели", "недель" ], [ 86400, "день", "дня", "дней" ], [ 3600, "час", "часа", "часов" ], [ 60, "минута", "минуты", "минут" ] ];
  for (const [sec, one, few, many] of units) {
    if (seconds % sec === 0) {
      const n = seconds / sec;
      return `${n} ${ruPlural(n, one, few, many)}`;
    }
  }
  return `${seconds} сек.`;
}

function fmtDate(ts) {
  ts = parseInt(ts || 0, 10);
  if (!ts) return "—";
  try {
    return new Date(ts * 1e3).toLocaleDateString("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric"
    });
  } catch {
    return "—";
  }
}

function banIsActiveCalc(b, now) {
  const unbanReason = String(b.unban_reason || "").trim();
  if (unbanReason && !/^\d+\[STEAM_/.test(unbanReason)) return false;
  const banLen = parseInt(b.ban_len || 0, 10);
  const unbanTime = parseInt(b.unban_time || 0, 10);
  if (banLen === 0) return unbanTime === 0;
  if (unbanTime > 0) return now < unbanTime;
  const bt = parseInt(b.ban_time || 0, 10);
  return bt > 0 ? now < bt + banLen : false;
}

function errorText(err) {
  const code = String(err || "DB_ERROR");
  if (code === "NO_ACTIVE_BAN") return "У игрока нет активного бана.";
  if (code === "NO_WARNS") return "У игрока нет варнов.";
  return code.replace(/[<>&]/g, "");
}

async function getBotPlayerName(pool, steamid64) {
  const sid = String(steamid64 || "");
  if (!/^\d{17}$/.test(sid)) return "";
  try {
    const [r] = await pool.query("SELECT Name FROM player_data WHERE CAST(SteamID AS CHAR) = ? LIMIT 1", [ sid ]);
    if (r[0]?.Name) return decodeIfNeeded(r[0].Name);
  } catch {}
  try {
    const [r] = await pool.query("SELECT name FROM ba_users WHERE CAST(steamid AS CHAR) = ? LIMIT 1", [ sid ]);
    if (r[0]?.name) return decodeIfNeeded(r[0].name);
  } catch {}
  try {
    const [r] = await pool.query("SELECT Nick FROM GMDonate_Players WHERE CAST(SteamID64 AS CHAR) = ? LIMIT 1", [ sid ]);
    if (r[0]?.Nick) return decodeIfNeeded(r[0].Nick);
  } catch {}
  return "";
}

async function resolveAdminSid(platform, author) {
  if (platform === "discord") {
    try {
      const [rows] = await db().query("SELECT steamid64 FROM donate_discord_users WHERE discord_id = ? LIMIT 1", [ String(author?.id || "") ]);
      if (rows[0]?.steamid64) return String(rows[0].steamid64);
    } catch {}
  }
  return String(author?.id || "0");
}

function adminDisplayName(platform, author) {
  if (platform === "discord") return author?.tag || `Discord:${author?.id}`;
  const a = author || {};
  return [ a.first_name, a.last_name ].filter(Boolean).join(" ") || a.username || `TG:${a.id}`;
}

async function cmdLookup(term) {
  const pool = db();
  const like = `%${term}%`;
  const out = [];
  const push = (sid64, name) => {
    if (sid64 && /^\d{17}$/.test(String(sid64))) out.push({
      sid64: String(sid64),
      name: decodeIfNeeded(name || "")
    });
  };
  try {
    const [pd] = await pool.query("SELECT CAST(SteamID AS CHAR) AS sid, Name FROM player_data WHERE Name LIKE ? LIMIT 15", [ like ]);
    for (const r of pd) push(r.sid, r.Name);
  } catch {}
  try {
    const [bu] = await pool.query("SELECT CAST(steamid AS CHAR) AS sid, name FROM ba_users WHERE name LIKE ? LIMIT 15", [ like ]);
    for (const r of bu) push(r.sid, r.name);
  } catch {}
  try {
    const [gp] = await pool.query("SELECT CAST(SteamID64 AS CHAR) AS sid, Nick FROM GMDonate_Players WHERE Nick LIKE ? LIMIT 15", [ like ]);
    for (const r of gp) push(r.sid, r.Nick);
  } catch {}
  const seen = new Set;
  const uniq = [];
  for (const o of out) {
    if (!seen.has(o.sid64)) {
      seen.add(o.sid64);
      uniq.push(o);
    }
  }
  return uniq.slice(0, 12);
}

async function cmdCheck(ids) {
  const pool = db();
  const sid64 = ids.steamid64, sid32 = ids.steamid;
  const name = await getBotPlayerName(pool, sid64);
  let donateBalance = 0, moneyBalance = 0;
  try {
    const [d] = await pool.query("SELECT Balance FROM GMDonate_Players WHERE SteamID64 = ? LIMIT 1", [ sid64 ]);
    donateBalance = Math.round(Number(d[0]?.Balance || 0));
  } catch {}
  try {
    const [pd] = await pool.query("SELECT Money FROM player_data WHERE SteamID = ? LIMIT 1", [ sid64 ]);
    moneyBalance = Math.round(Number(pd[0]?.Money || 0));
  } catch {}
  const logs = await getTexLogs(pool, sid64, 200, null);
  const moneyNet = Number(logs.totals.money_income || 0) + Number(logs.totals.money_expense || 0);
  const donateNet = Number(logs.totals.donate_income || 0) + Number(logs.totals.donate_expense || 0);
  const suspM = logs.money.filter(x => Math.abs(Number(x.money || 0)) >= 1e7 || /Передача денег|TakeMoney|AddMoney|списание|начисление/i.test(String(x.description || ""))).length;
  const suspD = logs.donate.filter(x => Math.abs(Number(x.sum || 0)) >= 1e6 || /given by|reward|refund|возврат|ручн|admin/i.test(String(x.note || ""))).length;
  let bans = [];
  try {
    const [b] = await pool.query("SELECT reason, ban_time, ban_len, unban_time, unban_reason, a_name FROM ba_bans WHERE steamid = ? OR steamid = ? ORDER BY ban_time DESC LIMIT 5", [ sid64, sid32 ]);
    bans = b;
  } catch {}
  const now = Math.floor(Date.now() / 1e3);
  for (const b of bans) b._active = banIsActiveCalc(b, now);
  let warnsCount = 0;
  try {
    const [w] = await pool.query("SELECT COUNT(*) AS c FROM ba_warns WHERE steamid = ? OR CAST(steamid AS CHAR) = ?", [ String(sid64), String(sid64) ]);
    warnsCount = parseInt(w[0]?.c || 0, 10);
  } catch {}
  return {
    ids: ids,
    name: name,
    donateBalance: donateBalance,
    moneyBalance: moneyBalance,
    moneyNet: moneyNet,
    donateNet: donateNet,
    suspM: suspM,
    suspD: suspD,
    bans: bans,
    warnsCount: warnsCount
  };
}

async function insertRow(pool, table, data) {
  const row = Object.assign({}, data);
  for (let attempt = 0; attempt < 10; attempt++) {
    const cols = Object.keys(row);
    try {
      await pool.query(`INSERT INTO \`${table}\` (${cols.map((c) => `\`${c}\``).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, cols.map((c) => row[c]));
      return;
    } catch (e) {
      const msg = String(e?.message || "");
      const miss = msg.match(/Field '([^']+)' doesn't have a default value/);
      if (miss && !Object.prototype.hasOwnProperty.call(row, miss[1])) {
        row[miss[1]] = 0;
        continue;
      }
      const wrong = msg.match(/Incorrect \w+ value:.*column '([^']+)'/) || msg.match(/Truncated incorrect .* value:.*column '([^']+)'/i);
      if (wrong && row[wrong[1]] === 0) {
        row[wrong[1]] = "";
        continue;
      }
      throw e;
    }
  }
  throw new Error("INSERT_FAILED");
}

async function cmdBan(ids, reason, adminLabel, durationSeconds = 0) {
  const pool = db();
  const name = await getBotPlayerName(pool, ids.steamid64) || "—";
  const len = Math.max(0, Math.min(MAX_BAN_SECONDS, parseInt(durationSeconds || 0, 10) || 0));
  await insertRow(pool, "ba_bans", {
    steamid: ids.steamid64,
    name: name,
    a_name: adminLabel.name,
    a_steamid: adminLabel.sid,
    reason: String(reason).slice(0, 250),
    ban_time: Math.floor(Date.now() / 1e3),
    ban_len: len,
    unban_time: 0,
    unban_reason: ""
  });
  return {
    ok: true,
    ids: ids,
    name: name,
    reason: reason,
    seconds: len
  };
}

async function cmdWarn(ids, reason, adminLabel) {
  const pool = db();
  const name = await getBotPlayerName(pool, ids.steamid64) || "—";
  let count = 0;
  try {
    const [w] = await pool.query("SELECT COUNT(*) AS c FROM ba_warns WHERE steamid = ? OR CAST(steamid AS CHAR) = ?", [ String(ids.steamid64), String(ids.steamid64) ]);
    count = parseInt(w[0]?.c || 0, 10);
  } catch {}
  try {
    await insertRow(pool, "ba_warns", {
      steamid: ids.steamid64,
      reason: String(reason).slice(0, 250),
      admin_steamid: adminLabel.sid,
      timestamp: new Date
    });
  } catch (e) {
    return {
      ok: false,
      error: e?.message || "DB_ERROR"
    };
  }
  try {
    await sendWarnLog({
      type: "warn",
      player_name: name,
      player_steamid64: ids.steamid64,
      admin_name: adminLabel.name,
      admin_steamid64: adminLabel.sid,
      reason: reason,
      warn_count: count + 1,
      warn_max: 5
    });
  } catch (e) {
    console.error("[BOT WARN] sendWarnLog error:", e?.message || e);
  }
  return {
    ok: true,
    ids: ids,
    name: name,
    reason: reason,
    count: count + 1
  };
}

async function cmdUnban(ids, reason, adminLabel) {
  const pool = db();
  const [rows] = await pool.query(`SELECT steamid, name, reason, ban_time, ban_len FROM ba_bans\n     WHERE (steamid = ? OR steamid = ?) AND ${ACTIVE_BAN_SQL}\n     ORDER BY ban_time DESC LIMIT 1`, [ ids.steamid64, ids.steamid ]);
  const ban = rows[0];
  if (!ban) return {
    ok: false,
    error: "NO_ACTIVE_BAN"
  };
  const unbanReason = `${String(reason).slice(0, 180)} — разбанил ${adminLabel.name}`.slice(0, 250);
  const [upd] = await pool.query("UPDATE ba_bans SET unban_time = UNIX_TIMESTAMP(), unban_reason = ? WHERE steamid = ? AND ban_time = ? LIMIT 1", [ unbanReason, String(ban.steamid), parseInt(ban.ban_time || 0, 10) ]);
  if (!upd?.affectedRows) return {
    ok: false,
    error: "NO_ACTIVE_BAN"
  };
  const name = decodeIfNeeded(ban.name || "") || await getBotPlayerName(pool, ids.steamid64) || "—";
  return {
    ok: true,
    ids: ids,
    name: name,
    liftedReason: decodeIfNeeded(ban.reason || "Без причины"),
    liftedLen: parseInt(ban.ban_len || 0, 10),
    reason: reason
  };
}

async function cmdUnwarn(ids, reason, adminLabel) {
  const pool = db();
  const [rows] = await pool.query("SELECT id, reason FROM ba_warns WHERE steamid = ? OR CAST(steamid AS CHAR) = ? ORDER BY timestamp DESC, id DESC LIMIT 1", [ ids.steamid64, String(ids.steamid64) ]);
  const warn = rows[0];
  if (!warn) return {
    ok: false,
    error: "NO_WARNS"
  };
  await pool.query("DELETE FROM ba_warns WHERE id = ? LIMIT 1", [ warn.id ]);
  let left = 0;
  try {
    const [[c]] = await pool.query("SELECT COUNT(*) AS c FROM ba_warns WHERE steamid = ? OR CAST(steamid AS CHAR) = ?", [ ids.steamid64, String(ids.steamid64) ]);
    left = parseInt(c?.c || 0, 10);
  } catch {}
  const name = await getBotPlayerName(pool, ids.steamid64) || "—";
  try {
    await sendWarnLog({
      type: "unwarn",
      player_name: name,
      player_steamid64: ids.steamid64,
      admin_name: adminLabel.name,
      admin_steamid64: adminLabel.sid,
      reason: `Снят варн: «${decodeIfNeeded(warn.reason || "Без причины")}». Основание: ${reason}`,
      warn_count: left,
      warn_max: 5
    });
  } catch (e) {
    console.error("[BOT UNWARN] sendWarnLog error:", e?.message || e);
  }
  return {
    ok: true,
    ids: ids,
    name: name,
    removedReason: decodeIfNeeded(warn.reason || "Без причины"),
    left: left,
    reason: reason
  };
}

async function cmdStats() {
  const pool = db();
  const out = {
    players: 0,
    bans: 0,
    activeBans: 0,
    warns: 0,
    bansToday: 0,
    warnsToday: 0,
    adminsToday: 0
  };
  const safe = async (fn, key) => {
    try {
      out[key] = await fn();
    } catch {}
  };
  await Promise.all([ safe(async () => {
    const [[r]] = await pool.query("SELECT COUNT(*) AS c FROM ba_users");
    return parseInt(r?.c || 0, 10);
  }, "players"), safe(async () => {
    const [[r]] = await pool.query("SELECT COUNT(*) AS c FROM ba_bans");
    return parseInt(r?.c || 0, 10);
  }, "bans"), safe(async () => {
    const [[r]] = await pool.query(`SELECT COUNT(*) AS c FROM ba_bans WHERE ${ACTIVE_BAN_SQL}`);
    return parseInt(r?.c || 0, 10);
  }, "activeBans"), safe(async () => {
    const [[r]] = await pool.query("SELECT COUNT(*) AS c FROM ba_warns");
    return parseInt(r?.c || 0, 10);
  }, "warns"), safe(async () => {
    const [[r]] = await pool.query("SELECT COUNT(*) AS c FROM ba_bans WHERE ban_time >= UNIX_TIMESTAMP(CURDATE())");
    return parseInt(r?.c || 0, 10);
  }, "bansToday"), safe(async () => {
    const [[r]] = await pool.query("SELECT COUNT(*) AS c FROM ba_warns WHERE timestamp >= CURDATE()");
    return parseInt(r?.c || 0, 10);
  }, "warnsToday"), safe(async () => {
    const [[r]] = await pool.query("SELECT COUNT(DISTINCT admin_steamid64) AS c FROM admin_logs WHERE timestamp >= UNIX_TIMESTAMP(CURDATE())");
    return parseInt(r?.c || 0, 10);
  }, "adminsToday") ]);
  return out;
}



async function pushConsole(text) {
  try {
    await withQueueLock(async () => {
      const queue = readQueueFile();
      const now = Math.floor(Date.now() / 1e3);
      const cmdId = "cmd_" + now + "_" + Math.floor(1e3 + Math.random() * 9e3);
      queue.push({
        id: cmdId,
        type: "console",
        text: text,
        done: false,
        processing: false,
        time: now
      });
      writeQueueFile(queue);
    });
  } catch (e) {
    console.error("[BOT GIVE] pushConsole error:", e?.message || e);
  }
}

async function tableHasColumn(pool, table, col) {
  try {
    const [rows] = await pool.query("SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1", [ table, col ]);
    return rows.length > 0;
  } catch {
    return false;
  }
}



async function cmdProps(ids) {
  const pool = db();
  const name = await getBotPlayerName(pool, ids.steamid64);
  let access = null;
  try {
    const [rows] = await pool.query("SELECT props_extra, setmodel, issued_by, UNIX_TIMESTAMP(updated_at) AS updated_at FROM panel_player_access WHERE steamid32 = ? LIMIT 1", [ ids.steamid ]);
    if (rows[0]) {
      access = {
        props_extra: parseInt(rows[0].props_extra || 0, 10),
        setmodel: !!rows[0].setmodel,
        issued_by: decodeIfNeeded(rows[0].issued_by || ""),
        updated_at: parseInt(rows[0].updated_at || 0, 10)
      };
    }
  } catch {}
  return {
    ids: ids,
    name: name,
    access: access
  };
}

async function cmdGiveProps(ids, amount, setmodel, adminLabel) {
  const n = Math.max(0, Math.min(10000, parseInt(amount || 0, 10) || 0));
  const sm = setmodel ? 1 : 0;
  const pool = db();
  const name = await getBotPlayerName(pool, ids.steamid64);
  await pool.query(`INSERT INTO panel_player_access (steamid32, props_extra, setmodel, issued_by, updated_at)
     VALUES (?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE props_extra=VALUES(props_extra), setmodel=VALUES(setmodel), issued_by=VALUES(issued_by), updated_at=NOW()`, [ ids.steamid, n, sm, adminLabel.name ]);
  await logAdminAction(pool, adminLabel.sid, "SET_PLAYER_ACCESS", ids.steamid, `props_extra: ${n}, setmodel: ${sm}`);
  await pushConsole(`panel_setprops ${ids.steamid} ${n}`);
  await pushConsole(`panel_setmodelaccess ${ids.steamid} ${sm}`);
  return {
    ok: true,
    ids: ids,
    name: name,
    amount: n,
    setmodel: sm
  };
}



async function cmdGiveQmenu(ids, type, adminLabel) {
  const pool = db();
  const name = await getBotPlayerName(pool, ids.steamid64);
  const [res] = await pool.query("INSERT IGNORE INTO panel_player_qmenu (steamid32, access_type, issued_by, issued_at) VALUES (?, ?, ?, NOW())", [ ids.steamid, type, adminLabel.name ]);
  const already = !res?.affectedRows;
  await logAdminAction(pool, adminLabel.sid, "GIVE_QMENU", ids.steamid, `type: ${type}`);
  await pushConsole(`giveqmenu ${ids.steamid} ${type}`);
  return {
    ok: true,
    already: already,
    ids: ids,
    name: name,
    type: type
  };
}

async function cmdRevokeQmenu(ids, type, adminLabel) {
  const pool = db();
  const name = await getBotPlayerName(pool, ids.steamid64);
  const [res] = await pool.query("DELETE FROM panel_player_qmenu WHERE steamid32 = ? AND access_type = ? LIMIT 1", [ ids.steamid, type ]);
  const already = !res?.affectedRows;
  await logAdminAction(pool, adminLabel.sid, "REVOKE_QMENU", ids.steamid, `type: ${type}`);
  await pushConsole(`removeqmenu ${ids.steamid} ${type}`);
  return {
    ok: true,
    already: already,
    ids: ids,
    name: name,
    type: type
  };
}



async function findJob(term) {
  const pool = db();
  const t = String(term || "").trim();
  if (!t) return [];
  if (/^\d+$/.test(t)) {
    try {
      const [r] = await pool.query("SELECT id, job_command, name FROM panel_jobs WHERE id = ? LIMIT 1", [ parseInt(t, 10) ]);
      if (r[0]) return [ {
        id: r[0].id,
        job_command: String(r[0].job_command),
        title: decodeIfNeeded(r[0].name || "")
      } ];
    } catch {}
  }
  const q = `%${t}%`;
  try {
    const [r] = await pool.query("SELECT id, job_command, name FROM panel_jobs WHERE name LIKE ? OR job_command LIKE ? ORDER BY id DESC LIMIT 5", [ q, q ]);
    return r.map(x => ({
      id: x.id,
      job_command: String(x.job_command),
      title: decodeIfNeeded(x.name || "")
    }));
  } catch {
    return [];
  }
}

async function listJobs(filter) {
  const pool = db();
  const q = filter ? `%${filter}%` : "%";
  try {
    const [r] = await pool.query("SELECT id, job_command, name FROM panel_jobs WHERE name LIKE ? OR job_command LIKE ? ORDER BY id DESC LIMIT 60", [ q, q ]);
    return r.map(x => ({
      id: x.id,
      job_command: String(x.job_command),
      title: decodeIfNeeded(x.name || "")
    }));
  } catch {
    return [];
  }
}

async function cmdGiveJob(ids, job, adminLabel) {
  const pool = db();
  const name = await getBotPlayerName(pool, ids.steamid64);
  const [res] = await pool.query("INSERT IGNORE INTO panel_player_jobs (steamid32, job_id, given_by, given_at) VALUES (?, ?, ?, NOW())", [ ids.steamid, job.id, adminLabel.name ]);
  const already = !res?.affectedRows;
  await logAdminAction(pool, adminLabel.sid, "GIVE_JOB", ids.steamid, `job: ${job.job_command}`);
  await pushConsole(`ba adddonate ${ids.steamid} ${job.job_command}`);
  return {
    ok: true,
    already: already,
    ids: ids,
    name: name,
    title: job.title,
    job_command: job.job_command
  };
}

async function cmdRevokeJob(ids, job, adminLabel) {
  const pool = db();
  const name = await getBotPlayerName(pool, ids.steamid64);
  const [res] = await pool.query("DELETE FROM panel_player_jobs WHERE steamid32 = ? AND job_id = ? LIMIT 1", [ ids.steamid, job.id ]);
  const already = !res?.affectedRows;
  await logAdminAction(pool, adminLabel.sid, "REVOKE_JOB", ids.steamid, `job: ${job.job_command}`);
  await pushConsole(`ba removedonate ${ids.steamid} ${job.job_command}`);
  return {
    ok: true,
    already: already,
    ids: ids,
    name: name,
    title: job.title,
    job_command: job.job_command
  };
}



async function findModel(term) {
  const pool = db();
  const t = String(term || "").trim();
  if (!t) return [];
  const q = `%${t}%`;
  const pick = rows => rows.map(x => ({
    id: x.id,
    model_path: String(x.model_path || ""),
    title: decodeIfNeeded(x.title || ""),
    workshop_id: x.workshop_id
  }));
  if (/^\d+$/.test(t)) {
    try {
      const [r] = await pool.query("SELECT id, model_path, title AS title, workshop_id FROM panel_models WHERE id = ? LIMIT 1", [ parseInt(t, 10) ]);
      if (r.length) return pick(r);
    } catch {}
    try {
      const [r] = await pool.query("SELECT id, model_path, name AS title, workshop_id FROM panel_models WHERE id = ? LIMIT 1", [ parseInt(t, 10) ]);
      return pick(r);
    } catch {
      return [];
    }
  }
  try {
    const [r] = await pool.query("SELECT id, model_path, title AS title, workshop_id FROM panel_models WHERE title LIKE ? OR model_path LIKE ? OR CAST(workshop_id AS CHAR) LIKE ? ORDER BY id DESC LIMIT 5", [ q, q, q ]);
    if (r.length) return pick(r);
  } catch {}
  try {
    const [r] = await pool.query("SELECT id, model_path, name AS title, workshop_id FROM panel_models WHERE name LIKE ? OR model_path LIKE ? OR CAST(workshop_id AS CHAR) LIKE ? ORDER BY id DESC LIMIT 5", [ q, q, q ]);
    return pick(r);
  } catch {
    return [];
  }
}

async function listModels(filter) {
  const pool = db();
  const q = filter ? `%${filter}%` : "%";
  const pick = rows => rows.map(x => ({
    id: x.id,
    model_path: String(x.model_path || ""),
    title: decodeIfNeeded(x.title || ""),
    workshop_id: x.workshop_id
  }));
  try {
    const [r] = await pool.query("SELECT id, model_path, title AS title, workshop_id FROM panel_models WHERE title LIKE ? OR model_path LIKE ? OR CAST(workshop_id AS CHAR) LIKE ? ORDER BY id DESC LIMIT 60", [ q, q, q ]);
    if (r.length) return pick(r);
  } catch {}
  try {
    const [r] = await pool.query("SELECT id, model_path, name AS title, workshop_id FROM panel_models WHERE name LIKE ? OR model_path LIKE ? OR CAST(workshop_id AS CHAR) LIKE ? ORDER BY id DESC LIMIT 60", [ q, q, q ]);
    return pick(r);
  } catch {
    return [];
  }
}

async function cmdGiveModel(ids, model, adminLabel) {
  const pool = db();
  const name = await getBotPlayerName(pool, ids.steamid64);
  const hasGivenBy = await tableHasColumn(pool, "panel_player_models", "given_by");
  let affectedRows = 0;
  if (hasGivenBy) {
    const [res] = await pool.query("INSERT IGNORE INTO panel_player_models (steamid32, model_id, given_by, given_at) VALUES (?, ?, ?, NOW())", [ ids.steamid, model.id, adminLabel.name ]);
    affectedRows = res?.affectedRows || 0;
  } else {
    const [res] = await pool.query("INSERT IGNORE INTO panel_player_models (steamid32, model_id, issued_by) VALUES (?, ?, ?)", [ ids.steamid, model.id, adminLabel.name ]);
    affectedRows = res?.affectedRows || 0;
  }
  await logAdminAction(pool, adminLabel.sid, "GIVE_MODEL", ids.steamid, `model: ${model.model_path}`);
  await pushConsole(`addmodel ${ids.steamid} ${model.model_path}`);
  return {
    ok: true,
    already: !affectedRows,
    ids: ids,
    name: name,
    title: model.title,
    model_path: model.model_path
  };
}

async function cmdRevokeModel(ids, model, adminLabel) {
  const pool = db();
  const name = await getBotPlayerName(pool, ids.steamid64);
  const [res] = await pool.query("DELETE FROM panel_player_models WHERE steamid32 = ? AND model_id = ? LIMIT 1", [ ids.steamid, model.id ]);
  const already = !res?.affectedRows;
  await logAdminAction(pool, adminLabel.sid, "REVOKE_MODEL", ids.steamid, `model: ${model.model_path}`);
  await pushConsole(`removemodel ${ids.steamid} ${model.model_path}`);
  return {
    ok: true,
    already: already,
    ids: ids,
    name: name,
    title: model.title,
    model_path: model.model_path
  };
}



async function cmdIp(ids) {
  const pool = db();
  const name = await getBotPlayerName(pool, ids.steamid64);
  const ips = [];
  const black = new Map;
  try {
    const [b] = await pool.query("SELECT ip, reason, active FROM chsp_ip_list");
    for (const r of b) black.set(String(r.ip || ""), {
      reason: decodeIfNeeded(r.reason || ""),
      active: !!r.active
    });
  } catch {}
  try {
    const [rows] = await pool.query("SELECT * FROM ba_iplog WHERE steamid = ? OR steamid = ? ORDER BY lastseen DESC LIMIT 30", [ ids.steamid64, ids.steamid ]);
    const seen = new Set;
    for (const r of rows) {
      const ip = String(r.ip || "").trim();
      if (!ip || seen.has(ip)) continue;
      seen.add(ip);
      ips.push({
        ip: ip,
        lastseen: parseInt(r.lastseen || 0, 10),
        black: black.get(ip) || null
      });
    }
  } catch {}
  return {
    ids: ids,
    name: name,
    ips: ips.slice(0, 15)
  };
}



async function altInfo(pool, sid, lastseen) {
  let nickname = "";
  try {
    const [r] = await pool.query("SELECT name FROM ba_users WHERE steamid = ? LIMIT 1", [ sid ]);
    nickname = decodeIfNeeded(r[0]?.name || "");
  } catch {}
  if (!nickname) {
    try {
      const [r] = await pool.query("SELECT Name FROM player_data WHERE CAST(SteamID AS CHAR) = ? LIMIT 1", [ sid ]);
      nickname = decodeIfNeeded(r[0]?.Name || "");
    } catch {}
  }
  let banned = false;
  let banReason = "";
  try {
    const [r] = await pool.query(`SELECT reason FROM ba_bans WHERE steamid = ? AND ${ACTIVE_BAN_SQL} ORDER BY ban_time DESC LIMIT 1`, [ sid ]);
    if (r[0]) {
      banned = true;
      banReason = decodeIfNeeded(r[0].reason || "");
    }
  } catch {}
  let chsp = false;
  try {
    const [r] = await pool.query("SELECT 1 FROM chsp_list WHERE steamid64 = ? AND active = 1 LIMIT 1", [ sid ]);
    chsp = r.length > 0;
  } catch {}
  return {
    sid: String(sid),
    nickname: nickname,
    lastseen: parseInt(lastseen || 0, 10),
    banned: banned,
    banReason: banReason,
    chsp: chsp
  };
}

async function cmdAlts(ids) {
  const pool = db();
  const name = await getBotPlayerName(pool, ids.steamid64);
  let myIps = [];
  try {
    const [rows] = await pool.query("SELECT DISTINCT ip FROM ba_iplog WHERE steamid = ? OR steamid = ?", [ ids.steamid64, ids.steamid ]);
    myIps = rows.map(r => String(r.ip || "").trim()).filter(Boolean);
  } catch {}
  if (!myIps.length) {
    return {
      ids: ids,
      name: name,
      groups: [],
      noIplog: true
    };
  }
  const groups = [];
  const seenAlts = new Set;
  for (const ip of myIps.slice(0, 12)) {
    let rows = [];
    try {
      const [r] = await pool.query("SELECT steamid, MAX(lastseen) AS lastseen FROM ba_iplog WHERE ip = ? GROUP BY steamid ORDER BY lastseen DESC", [ ip ]);
      rows = r;
    } catch {}
    const accs = [];
    for (const row of rows) {
      const sid = String(row.steamid || "").trim();
      if (!sid || sid === ids.steamid64 || sid === ids.steamid || seenAlts.has(sid)) continue;
      seenAlts.add(sid);
      accs.push(await altInfo(pool, sid, row.lastseen));
    }
    if (accs.length) groups.push({
      ip: ip,
      accs: accs
    });
  }
  return {
    ids: ids,
    name: name,
    groups: groups,
    noIplog: false
  };
}

function purgeExpiredPendings() {
  const now = Date.now();
  for (const [id, p] of pendingModActions) {
    if (now - p.createdAt > PENDING_TTL_MS) pendingModActions.delete(id);
  }
}

function createPending(data) {
  purgeExpiredPendings();
  const id = crypto.randomBytes(8).toString("hex");
  const meta = ACTION_META[data.action] || ACTION_META.ban;
  const pending = {
    id: id,
    createdAt: Date.now(),
    confirmYes: meta.yes,
    ...data
  };
  pendingModActions.set(id, pending);
  return pending;
}

async function executePending(pending) {
  if (pending.action === "ban") return cmdBan(pending.ids, pending.reason, pending.adminLabel, pending.durationSeconds);
  if (pending.action === "warn") return cmdWarn(pending.ids, pending.reason, pending.adminLabel);
  if (pending.action === "unban") return cmdUnban(pending.ids, pending.reason, pending.adminLabel);
  if (pending.action === "unwarn") return cmdUnwarn(pending.ids, pending.reason, pending.adminLabel);
  return {
    ok: false,
    error: "UNKNOWN_ACTION"
  };
}

async function resolvePendingMod(id, approved) {
  purgeExpiredPendings();
  const key = String(id || "");
  const pending = pendingModActions.get(key);
  if (!pending) return {
    status: "expired"
  };
  pendingModActions.delete(key);
  if (!approved) return {
    status: "cancelled",
    pending: pending
  };
  try {
    const result = await executePending(pending);
    if (!result?.ok) return {
      status: "error",
      pending: pending,
      error: result?.error || "DB_ERROR"
    };
    return {
      status: "done",
      pending: pending,
      result: result
    };
  } catch (e) {
    console.error("[BOT MOD] execute error:", e?.message || e);
    return {
      status: "error",
      pending: pending,
      error: e?.message || "DB_ERROR"
    };
  }
}

function playerLine(name, ids) {
  return {
    name: decodeIfNeeded(name || "") || "—",
    ids: ids
  };
}

function bansListDiscord(bans) {
  return bans.slice(0, 3).map(b => {
    const st = b._active ? "🟥" : "⬜";
    return `${st} **${decodeIfNeeded(b.reason || "Без причины")}** · ${fmtDuration(b.ban_len)} · ${decodeIfNeeded(b.a_name || "?")} (${fmtDate(b.ban_time)})`;
  }).join("\n");
}

function bansListTelegram(bans) {
  return bans.slice(0, 3).map(b => {
    const st = b._active ? "🟥" : "⬜";
    return `${st} ${esc(decodeIfNeeded(b.reason || "Без причины"))} · ${esc(fmtDuration(b.ban_len))} · ${esc(decodeIfNeeded(b.a_name || "?"))} (${fmtDate(b.ban_time)})`;
  }).join("\n");
}

function baseEmbed(title, color) {
  return (new EmbedBuilder).setTitle(title).setColor(color).setTimestamp(new Date).setFooter({
    text: "VibeRP · Бот модерации"
  });
}

function discordConfirmEmbed(p) {
  const meta = ACTION_META[p.action] || ACTION_META.ban;
  const e = baseEmbed(meta.confirmTitle, COLORS.confirm);
  const lines = [ `**${meta.question}**`, "", `👤 **Игрок:** ${decodeIfNeeded(p.name || "") || "—"}`, `🆔 \`${p.ids.steamid64}\`` ];
  if (p.action === "ban") lines.push(`⏳ **Срок:** ${fmtDuration(p.durationSeconds)}`);
  lines.push(`📝 **Причина:** ${p.reason}`);
  lines.push(`🛡 **Админ:** ${p.adminLabel.name}`);
  e.setDescription(lines.join("\n"));
  e.setFooter({
    text: "⏳ На подтверждение — 2 минуты"
  });
  return e;
}

function discordConfirmRow(id) {
  return (new ActionRowBuilder).addComponents((new ButtonBuilder).setCustomId(`mod_yes:${id}`).setLabel("Подтвердить").setEmoji("✅").setStyle(ButtonStyle.Success), (new ButtonBuilder).setCustomId(`mod_no:${id}`).setLabel("Отмена").setEmoji("❌").setStyle(ButtonStyle.Danger));
}

function discordOutcomeEmbed(out) {
  if (out.status === "expired") {
    return baseEmbed("⌛ Запрос устарел", COLORS.cancel).setDescription("Запрос устарел или уже обработан. Введи команду заново.");
  }
  const p = out.pending || {};
  const meta = ACTION_META[p.action] || ACTION_META.ban;
  if (out.status === "cancelled") {
    const e = baseEmbed("🚫 Действие отменено", COLORS.cancel);
    e.setDescription([ `${meta.emoji} ${meta.doneTitle} — **отменено**`, "", `👤 **Игрок:** ${decodeIfNeeded(p.name || "") || "—"}`, `🆔 \`${p.ids?.steamid64 || "—"}\`` ].join("\n"));
    return e;
  }
  if (out.status === "error") {
    const e = baseEmbed("❌ Не удалось выполнить", COLORS.ban);
    e.setDescription([ `${meta.emoji} ${meta.doneTitle} — **ошибка**`, "", `👤 **Игрок:** ${decodeIfNeeded(p.name || "") || "—"} (\`${p.ids?.steamid64 || "—"}\`)`, `📛 ${errorText(out.error)}` ].join("\n"));
    return e;
  }
  const r = out.result || {};
  const e = baseEmbed(`${meta.emoji} ${meta.doneTitle}`, meta.color);
  const lines = [ `👤 **Игрок:** ${decodeIfNeeded(r.name || p.name || "") || "—"}`, `🆔 \`${p.ids?.steamid64 || r.ids?.steamid64 || "—"}\` / \`${p.ids?.steamid || r.ids?.steamid || "—"}\`` ];
  if (p.action === "ban") lines.push(`⏳ **Срок:** ${fmtDuration(r.seconds ?? p.durationSeconds)}`);
  if (p.action === "warn") lines.push(`📛 **Варнов у игрока:** ${r.count}/5`);
  if (p.action === "unban") lines.push(`🔓 **Снятый бан:** ${r.liftedReason || "—"} (${fmtDuration(r.liftedLen)})`);
  if (p.action === "unwarn") lines.push(`📛 **Снятый варн:** ${r.removedReason || "—"}`, `🔢 **Осталось варнов:** ${r.left}/5`);
  lines.push(`📝 **Причина:** ${r.reason || p.reason || "—"}`);
  lines.push(`🛡 **Админ:** ${p.adminLabel?.name || "—"}`);
  e.setDescription(lines.join("\n"));
  return e;
}

function discordHelpEmbed() {
  const e = baseEmbed("📖 Команды бота (только ЛС)", COLORS.info);
  e.setDescription("Все команды работают только в личных сообщениях с ботом. `/ban`, `/warn`, `/unban`, `/unwarn` требуют подтверждения кнопкой.");
  e.addFields({
    name: "🛡 Модерация",
    value: [ "`/ban <STEAMID> [срок] [причина]` — забанить", "  сроки: `30mi` мин · `2h` час · `1d` день · `1w` нед · `1mo` мес · `perm`", "`/warn <STEAMID> [причина]` — выдать варн", "`/unban <STEAMID> [причина]` — разбанить", "`/unwarn <STEAMID> [причина]` — снять последний варн" ].join("\n"),
    inline: false
  }, {
    name: "📊 Информация",
    value: [ "`/lookup <ник>` — поиск игрока по нику", "`/check <STEAMID>` — карточка игрока", "`/stats` — статистика сервера" ].join("\n"),
    inline: false
  }, {
    name: "🕵️ Безопасность",
    value: [ "`/ip <STEAMID>` — история IP + проверка по ЧС IP", "`/alts <STEAMID>` — поиск альтов по общим IP", "`/props <STEAMID>` — лимит доп. пропов игрока" ].join("\n"),
    inline: false
  }, {
    name: "📦 Выдача",
    value: [ "`/giveprops <STEAMID> <кол-во> [setmodel]` — выдать доп. пропы", "`/giveqmenu <STEAMID> [qmenu|qmenuplus]` — выдать qmenu", "`/revokeqmenu <STEAMID> [qmenu|qmenuplus]` — снять qmenu", "`/givejob <STEAMID> <ID|название>` — выдать профессию", "`/revokejob <STEAMID> <ID|название>` — снять профессию", "`/givemodel <STEAMID> <ID|название>` — выдать модель", "`/revokemodel <STEAMID> <ID|название>` — снять модель", "`/jobs [фильтр]` · `/models [фильтр]` — списки" ].join("\n"),
    inline: false
  }, {
    name: "🧾 TEX",
    value: [ "`/tex <STEAMID> [7дней]` — выписка по игроку", "`/texinfo` — история TEX запросов" ].join("\n"),
    inline: false
  });
  return e;
}

function discordStatsEmbed(s) {
  const e = baseEmbed("📊 Статистика сервера", COLORS.info);
  e.addFields({
    name: "👥 Игроков всего",
    value: String(s.players),
    inline: true
  }, {
    name: "🔨 Банов всего",
    value: String(s.bans),
    inline: true
  }, {
    name: "⛔ Активных банов",
    value: String(s.activeBans),
    inline: true
  }, {
    name: "⚠️ Варнов всего",
    value: String(s.warns),
    inline: true
  }, {
    name: "📅 Банов сегодня",
    value: String(s.bansToday),
    inline: true
  }, {
    name: "📅 Варнов сегодня",
    value: String(s.warnsToday),
    inline: true
  }, {
    name: "🛡 Админов сегодня",
    value: String(s.adminsToday),
    inline: true
  });
  return e;
}

function discordCheckEmbed(r) {
  const activeBan = r.bans.find(b => b._active);
  const color = activeBan ? COLORS.ban : r.warnsCount > 0 ? COLORS.warn : COLORS.ok;
  const pl = playerLine(r.name, r.ids);
  const e = baseEmbed("🔎 Карточка игрока", color);
  e.setDescription([ `**${pl.name}**`, `\`${r.ids.steamid64}\` · \`${r.ids.steamid}\``, `[Steam профиль](https://steamcommunity.com/profiles/${r.ids.steamid64})` ].join("\n"));
  e.addFields({
    name: "💰 Донат",
    value: fmtMoney(r.donateBalance),
    inline: true
  }, {
    name: "💵 Деньги",
    value: fmtMoney(r.moneyBalance),
    inline: true
  }, {
    name: "⚠️ Варны",
    value: `${r.warnsCount}/5`,
    inline: true
  }, {
    name: "📈 Денег итог",
    value: `${fmtMoney(r.moneyNet)}${r.suspM ? ` · ⚠️${r.suspM}` : ""}`,
    inline: true
  }, {
    name: "📊 Донат итог",
    value: `${fmtMoney(r.donateNet)}${r.suspD ? ` · ⚠️${r.suspD}` : ""}`,
    inline: true
  }, {
    name: "🔨 Баны",
    value: `${r.bans.length}${activeBan ? " · **активен**" : ""}`,
    inline: true
  });
  if (r.bans.length) e.addFields({
    name: "Последние баны",
    value: bansListDiscord(r.bans),
    inline: false
  });
  return e;
}

function discordLookupEmbed(res, term) {
  const e = baseEmbed("🔎 Поиск по нику", COLORS.info);
  e.setDescription(`Запрос: \`${term}\``);
  if (!res.length) {
    e.addFields({
      name: "Результат",
      value: "Ничего не найдено"
    });
    return e;
  }
  e.addFields({
    name: `Найдено: ${res.length}`,
    value: res.map((o, i) => `**${i + 1}.** ${decodeIfNeeded(o.name) || "—"}\n\`${o.sid64}\``).join("\n")
  });
  return e;
}



function discordPropsEmbed(r) {
  const pl = playerLine(r.name, r.ids);
  const e = baseEmbed("🏗️ Доп. пропы игрока", COLORS.info);
  e.setDescription([ `**${pl.name}**`, `\`${r.ids.steamid64}\` · \`${r.ids.steamid}\``, `[Steam профиль](https://steamcommunity.com/profiles/${r.ids.steamid64})` ].join("\n"));
  if (!r.access) {
    e.addFields({
      name: "Лимит",
      value: "Не выдано (0 пропов, setmodel выключен)"
    });
    return e;
  }
  e.addFields({
    name: "🧱 Лимит доп. пропов",
    value: `**${r.access.props_extra}**`,
    inline: true
  }, {
    name: "🎭 Доступ !setmodel",
    value: r.access.setmodel ? "✅ включён" : "❌ выключен",
    inline: true
  }, {
    name: "👤 Выдал",
    value: r.access.issued_by || "—",
    inline: true
  }, {
    name: "🕒 Обновлено",
    value: r.access.updated_at ? fmtDate(r.access.updated_at) : "—",
    inline: true
  });
  return e;
}

function discordGiveEmbed(title, color, lines) {
  const e = baseEmbed(title, color);
  e.setDescription(lines.join("\n"));
  return e;
}

function discordGiveSuccessEmbed(r, what) {
  const lines = [ `👤 **Игрок:** ${decodeIfNeeded(r.name || "") || "—"}`, `🆔 \`${r.ids?.steamid64 || "—"}\` · \`${r.ids?.steamid || "—"}\`` ];
  if (what === "props") {
    lines.push(`🧱 **Лимит доп. пропов:** ${r.amount}`, `🎭 **setmodel:** ${r.setmodel ? "включён" : "выключен"}`);
  } else if (what === "qmenu") {
    lines.push(`📋 **Qmenu:** ${r.type === "qmenuplus" ? "Qmenu+ (расширенный)" : "обычный"}`);
  } else if (what === "job") {
    lines.push(`💼 **Профессия:** ${r.title || r.job_command}`);
  } else if (what === "model") {
    lines.push(`🧍 **Модель:** ${r.title || r.model_path}`);
  }
  if (r.already) lines.push("", "⚠️ У игрока это **уже было** — запись не дублирована, команда серверу отправлена.");
  return discordGiveEmbed(`✅ ${what === "props" ? "Пропы обновлены" : what === "qmenu" ? "Qmenu выдан" : what === "job" ? "Профессия выдана" : "Модель выдана"}`, COLORS.ok, lines);
}

function discordRevokeEmbed(r, what) {
  const lines = [ `👤 **Игрок:** ${decodeIfNeeded(r.name || "") || "—"}`, `🆔 \`${r.ids?.steamid64 || "—"}\` · \`${r.ids?.steamid || "—"}\`` ];
  if (what === "qmenu") lines.push(`📋 **Qmenu:** ${r.type === "qmenuplus" ? "Qmenu+ (расширенный)" : "обычный"}`);
  if (what === "job") lines.push(`💼 **Профессия:** ${r.title || r.job_command}`);
  if (what === "model") lines.push(`🧍 **Модель:** ${r.title || r.model_path}`);
  if (r.already) lines.push("", "⚠️ У игрока этого **не было**.");
  return discordGiveEmbed(`❌ ${what === "qmenu" ? "Qmenu снят" : what === "job" ? "Профессия снята" : "Модель снята"}`, COLORS.cancel, lines);
}

function discordPickEmbed(kind, term, items) {
  const e = baseEmbed(`🔀 Уточни: найдено ${items.length}`, COLORS.warn);
  e.setDescription(`Запрос: \`${term}\`\n\nУкажи **ID** или точное название ещё раз, например:\n\`/give${kind} <STEAMID> ${items[0].id}\``);
  e.addFields({
    name: "Варианты",
    value: items.map((x, i) => `**${x.id}.** ${x.title || x[kind === "job" ? "job_command" : "model_path"]}`).join("\n").slice(0, 1000)
  });
  return e;
}



function discordIpEmbed(r) {
  const pl = playerLine(r.name, r.ids);
  const e = baseEmbed("🌐 История IP", COLORS.info);
  e.setDescription([ `**${pl.name}**`, `\`${r.ids.steamid64}\` · \`${r.ids.steamid}\`` ].join("\n"));
  if (!r.ips.length) {
    e.addFields({
      name: "IP",
      value: "Нет записей в ba_iplog"
    });
    return e;
  }
  e.addFields({
    name: `Найдено IP: ${r.ips.length}`,
    value: r.ips.map(x => {
      const bl = x.black ? (x.black.active ? "🚫 **в ЧС IP**" : "⚪ был в ЧС") : "";
      return `\`${x.ip}\`${bl} · ${fmtDate(x.lastseen)}`;
    }).join("\n").slice(0, 1000)
  });
  return e;
}

function discordAltsEmbed(r) {
  const pl = playerLine(r.name, r.ids);
  const e = baseEmbed("🎭 Поиск альтов", COLORS.warn);
  e.setDescription([ `**${pl.name}**`, `\`${r.ids.steamid64}\` · \`${r.ids.steamid}\`` ].join("\n"));
  if (r.noIplog || !r.groups.length) {
    e.addFields({
      name: "Результат",
      value: r.noIplog ? "Нет записей в ba_iplog" : "Совпадений по IP не найдено 🎉"
    });
    return e;
  }
  let total = 0;
  for (const g of r.groups) total += g.accs.length;
  e.addFields({
    name: `Совпадений: ${total} (по ${r.groups.length} IP)`,
    value: r.groups.map(g => [ `\`${g.ip}\`:`, ...g.accs.map(a => {
      const flags = [ a.banned ? "🔨" : "", a.chsp ? "🚫" : "" ].join("");
      return `${a.nickname || a.sid} (\`${a.sid}\`)${flags} · ${fmtDate(a.lastseen)}`;
    }) ].join("\n")).join("\n\n").slice(0, 1000)
  });
  return e;
}

function discordJobsEmbed(items, filter) {
  const e = baseEmbed("💼 Список профессий", COLORS.info);
  e.setDescription(filter ? `Фильтр: \`${filter}\`` : "Все профессии");
  if (!items.length) {
    e.addFields({
      name: "Результат",
      value: "Ничего не найдено"
    });
    return e;
  }
  e.addFields({
    name: `Профессий: ${items.length}`,
    value: items.map(x => `**${x.id}.** ${x.title || x.job_command}\n\`${x.job_command}\``).join("\n").slice(0, 1000)
  });
  return e;
}

function discordModelsEmbed(items, filter) {
  const e = baseEmbed("🧍 Список моделей", COLORS.info);
  e.setDescription(filter ? `Фильтр: \`${filter}\`` : "Все модели");
  if (!items.length) {
    e.addFields({
      name: "Результат",
      value: "Ничего не найдено"
    });
    return e;
  }
  e.addFields({
    name: `Моделей: ${items.length}`,
    value: items.map(x => `**${x.id}.** ${x.title || x.model_path}`).join("\n").slice(0, 1000)
  });
  return e;
}

function telegramConfirmHtml(p) {
  const meta = ACTION_META[p.action] || ACTION_META.ban;
  const lines = [ `<b>${meta.confirmTitle}</b>`, "", `<b>${meta.question}</b>`, "", `👤 Игрок: <b>${esc(decodeIfNeeded(p.name || "") || "—")}</b>`, `🆔 <code>${p.ids.steamid64}</code>` ];
  if (p.action === "ban") lines.push(`⏳ Срок: <b>${esc(fmtDuration(p.durationSeconds))}</b>`);
  lines.push(`📝 Причина: <b>${esc(p.reason)}</b>`);
  lines.push(`🛡 Админ: ${esc(p.adminLabel.name)}`);
  lines.push("", "<i>⏳ На подтверждение — 2 минуты</i>");
  return lines.join("\n");
}

function telegramOutcomeHtml(out) {
  if (out.status === "expired") {
    return "⌛ <b>Запрос устарел</b>\n\nЗапрос устарел или уже обработан. Введи команду заново.";
  }
  const p = out.pending || {};
  const meta = ACTION_META[p.action] || ACTION_META.ban;
  if (out.status === "cancelled") {
    return [ `🚫 <b>Действие отменено</b>`, "", `${meta.emoji} ${esc(meta.doneTitle)} — <b>отменено</b>`, `👤 Игрок: <b>${esc(decodeIfNeeded(p.name || "") || "—")}</b>`, `🆔 <code>${p.ids?.steamid64 || "—"}</code>` ].join("\n");
  }
  if (out.status === "error") {
    return [ `❌ <b>Не удалось выполнить</b>`, "", `${meta.emoji} ${esc(meta.doneTitle)} — <b>ошибка</b>`, `👤 Игрок: <b>${esc(decodeIfNeeded(p.name || "") || "—")}</b> (<code>${p.ids?.steamid64 || "—"}</code>)`, `📛 ${esc(errorText(out.error))}` ].join("\n");
  }
  const r = out.result || {};
  const lines = [ `${meta.emoji} <b>${esc(meta.doneTitle)}</b>`, "", `👤 Игрок: <b>${esc(decodeIfNeeded(r.name || p.name || "") || "—")}</b>`, `🆔 <code>${p.ids?.steamid64 || r.ids?.steamid64 || "—"}</code>` ];
  if (p.action === "ban") lines.push(`⏳ Срок: <b>${esc(fmtDuration(r.seconds ?? p.durationSeconds))}</b>`);
  if (p.action === "warn") lines.push(`📛 Варнов у игрока: <b>${r.count}/5</b>`);
  if (p.action === "unban") lines.push(`🔓 Снятый бан: <b>${esc(r.liftedReason || "—")}</b> (${esc(fmtDuration(r.liftedLen))})`);
  if (p.action === "unwarn") lines.push(`📛 Снятый варн: <b>${esc(r.removedReason || "—")}</b>`, `🔢 Осталось варнов: <b>${r.left}/5</b>`);
  lines.push(`📝 Причина: <b>${esc(r.reason || p.reason || "—")}</b>`);
  lines.push(`🛡 Админ: ${esc(p.adminLabel?.name || "—")}`);
  return lines.join("\n");
}

function telegramHelpPayload() {
  return {
    text: [ "📖 <b>Команды бота</b> <i>(только личные сообщения)</i>", "", "🛡 <b>Модерация</b>", "<code>/ban</code> &lt;STEAMID&gt; [срок] [причина] — забанить", "   сроки: <code>30mi</code> мин · <code>2h</code> час · <code>1d</code> день · <code>1w</code> нед · <code>1mo</code> мес · <code>perm</code>", "<code>/warn</code> &lt;STEAMID&gt; [причина] — выдать варн", "<code>/unban</code> &lt;STEAMID&gt; [причина] — разбанить", "<code>/unwarn</code> &lt;STEAMID&gt; [причина] — снять последний варн", "", "📊 <b>Информация</b>", "<code>/lookup</code> &lt;ник&gt; — поиск игрока по нику", "<code>/check</code> &lt;STEAMID&gt; — карточка игрока", "<code>/stats</code> — статистика сервера", "", "🕵️ <b>Безопасность</b>", "<code>/ip</code> &lt;STEAMID&gt; — история IP + проверка по ЧС IP", "<code>/alts</code> &lt;STEAMID&gt; — поиск альтов по общим IP", "<code>/props</code> &lt;STEAMID&gt; — лимит доп. пропов игрока", "", "📦 <b>Выдача</b>", "<code>/giveprops</code> &lt;STEAMID&gt; &lt;кол-во&gt; [setmodel] — выдать доп. пропы", "<code>/giveqmenu</code> &lt;STEAMID&gt; [qmenu|qmenuplus] — выдать qmenu", "<code>/revokeqmenu</code> &lt;STEAMID&gt; [qmenu|qmenuplus] — снять qmenu", "<code>/givejob</code> &lt;STEAMID&gt; &lt;ID|название&gt; — выдать профессию", "<code>/revokejob</code> &lt;STEAMID&gt; &lt;ID|название&gt; — снять профессию", "<code>/givemodel</code> &lt;STEAMID&gt; &lt;ID|название&gt; — выдать модель", "<code>/revokemodel</code> &lt;STEAMID&gt; &lt;ID|название&gt; — снять модель", "<code>/jobs</code> [фильтр] · <code>/models</code> [фильтр] — списки", "", "🧾 <b>TEX</b>", "<code>/tex</code> &lt;STEAMID&gt; [7дней] — выписка по игроку", "<code>/texinfo</code> — история TEX запросов", "", "<i>/ban, /warn, /unban и /unwarn требуют подтверждения кнопкой ✅/❌</i>" ].join("\n")
  };
}

function telegramStatsPayload(s) {
  return {
    text: [ "📊 <b>Статистика сервера</b>", "", `👥 Игроков всего: <b>${s.players}</b>`, `🔨 Банов всего: <b>${s.bans}</b> (активных: <b>${s.activeBans}</b>)`, `⚠️ Варнов всего: <b>${s.warns}</b>`, "", `📅 Сегодня: банов <b>${s.bansToday}</b> · варнов <b>${s.warnsToday}</b>`, `🛡 Админов сегодня: <b>${s.adminsToday}</b>` ].join("\n")
  };
}

function telegramCheckPayload(r) {
  const activeBan = r.bans.find(b => b._active);
  const lines = [ "🔎 <b>Карточка игрока</b>", "", `<b>${esc(decodeIfNeeded(r.name || "") || "Ник не найден")}</b>`, `<code>${r.ids.steamid64}</code>`, `<code>${r.ids.steamid}</code>`, "", `💰 Донат: <b>${esc(fmtMoney(r.donateBalance))}</b>`, `💵 Деньги: <b>${esc(fmtMoney(r.moneyBalance))}</b>`, `📈 Денег итог: ${esc(fmtMoney(r.moneyNet))}${r.suspM ? ` (⚠️ ${r.suspM})` : ""}`, `📊 Донат итог: ${esc(fmtMoney(r.donateNet))}${r.suspD ? ` (⚠️ ${r.suspD})` : ""}`, "", `⚠️ Варны: <b>${r.warnsCount}/5</b>`, `🔨 Баны: <b>${r.bans.length}</b>${activeBan ? " — <b>активен</b>" : ""}` ];
  if (r.bans.length) lines.push("", "<b>Последние баны:</b>", bansListTelegram(r.bans));
  return {
    text: lines.join("\n"),
    keyboard: [ [ {
      text: "🔗 Steam профиль",
      url: `https://steamcommunity.com/profiles/${r.ids.steamid64}`
    } ] ]
  };
}

function telegramLookupPayload(res, term) {
  if (!res.length) {
    return {
      text: `🔎 <b>Поиск по нику:</b> <code>${esc(term)}</code>\n\nНичего не найдено.`
    };
  }
  return {
    text: [ `🔎 <b>Поиск по нику:</b> <code>${esc(term)}</code>`, `<i>Найдено: ${res.length}</i>`, "", ...res.map((o, i) => `<b>${i + 1}.</b> ${esc(decodeIfNeeded(o.name) || "—")}\n<code>${o.sid64}</code>`) ].join("\n")
  };
}

function telegramPropsPayload(r) {
  const lines = [ "🏗️ <b>Доп. пропы игрока</b>", "", `<b>${esc(decodeIfNeeded(r.name || "") || "Ник не найден")}</b>`, `<code>${r.ids.steamid64}</code>`, `<code>${r.ids.steamid}</code>`, "" ];
  if (!r.access) {
    lines.push("🧱 Лимит: <b>не выдано</b> (0 пропов, setmodel выключен)");
  } else {
    lines.push(`🧱 Лимит доп. пропов: <b>${r.access.props_extra}</b>`);
    lines.push(`🎭 Доступ !setmodel: <b>${r.access.setmodel ? "включён ✅" : "выключен ❌"}</b>`);
    lines.push(`👤 Выдал: <b>${esc(r.access.issued_by || "—")}</b>`);
    lines.push(`🕒 Обновлено: ${r.access.updated_at ? fmtDate(r.access.updated_at) : "—"}`);
  }
  return {
    text: lines.join("\n"),
    keyboard: [ [ {
      text: "🔗 Steam профиль",
      url: `https://steamcommunity.com/profiles/${r.ids.steamid64}`
    } ] ]
  };
}

function telegramGivePayload(r, what) {
  const lines = [ `✅ <b>${what === "props" ? "Пропы обновлены" : what === "qmenu" ? "Qmenu выдан" : what === "job" ? "Профессия выдана" : "Модель выдана"}</b>`, "", `👤 Игрок: <b>${esc(decodeIfNeeded(r.name || "") || "—")}</b>`, `🆔 <code>${r.ids?.steamid64 || "—"}</code>` ];
  if (what === "props") {
    lines.push(`🧱 Лимит доп. пропов: <b>${r.amount}</b>`, `🎭 setmodel: <b>${r.setmodel ? "включён" : "выключен"}</b>`);
  } else if (what === "qmenu") {
    lines.push(`📋 Qmenu: <b>${r.type === "qmenuplus" ? "Qmenu+ (расширенный)" : "обычный"}</b>`);
  } else if (what === "job") {
    lines.push(`💼 Профессия: <b>${esc(r.title || r.job_command)}</b>`);
  } else if (what === "model") {
    lines.push(`🧍 Модель: <b>${esc(r.title || r.model_path)}</b>`);
  }
  if (r.already) lines.push("", "⚠️ У игрока это <b>уже было</b> — запись не дублирована, команда серверу отправлена.");
  return {
    text: lines.join("\n"),
    keyboard: [ [ {
      text: "🔗 Steam профиль",
      url: `https://steamcommunity.com/profiles/${r.ids?.steamid64 || ""}`
    } ] ]
  };
}

function telegramRevokePayload(r, what) {
  const lines = [ `❌ <b>${what === "qmenu" ? "Qmenu снят" : what === "job" ? "Профессия снята" : "Модель снята"}</b>`, "", `👤 Игрок: <b>${esc(decodeIfNeeded(r.name || "") || "—")}</b>`, `🆔 <code>${r.ids?.steamid64 || "—"}</code>` ];
  if (what === "qmenu") lines.push(`📋 Qmenu: <b>${r.type === "qmenuplus" ? "Qmenu+ (расширенный)" : "обычный"}</b>`);
  if (what === "job") lines.push(`💼 Профессия: <b>${esc(r.title || r.job_command)}</b>`);
  if (what === "model") lines.push(`🧍 Модель: <b>${esc(r.title || r.model_path)}</b>`);
  if (r.already) lines.push("", "⚠️ У игрока этого <b>не было</b>.");
  return {
    text: lines.join("\n")
  };
}

function telegramPickPayload(kind, term, items) {
  return {
    text: [ `🔀 <b>Уточни: найдено ${items.length}</b>`, "", `Запрос: <code>${esc(term)}</code>`, "", ...items.map(x => `<b>${x.id}.</b> ${esc(x.title || x[kind === "job" ? "job_command" : "model_path"])}`), "", `Напиши ещё раз с ID, например: <code>/give${kind} &lt;STEAMID&gt; ${items[0].id}</code>` ].join("\n")
  };
}

function telegramIpPayload(r) {
  const lines = [ "🌐 <b>История IP</b>", "", `<b>${esc(decodeIfNeeded(r.name || "") || "Ник не найден")}</b>`, `<code>${r.ids.steamid64}</code>`, `<code>${r.ids.steamid}</code>`, "" ];
  if (!r.ips.length) {
    lines.push("Нет записей в ba_iplog.");
  } else {
    lines.push(`<b>Найдено IP: ${r.ips.length}</b>`, "", ...r.ips.map(x => {
      const bl = x.black ? (x.black.active ? " — 🚫 <b>в ЧС IP</b>" : " — ⚪ был в ЧС") : "";
      return `<code>${esc(x.ip)}</code>${bl} · ${fmtDate(x.lastseen)}`;
    }));
  }
  return {
    text: lines.join("\n"),
    keyboard: [ [ {
      text: "🔗 Steam профиль",
      url: `https://steamcommunity.com/profiles/${r.ids.steamid64}`
    } ] ]
  };
}

function telegramAltsPayload(r) {
  const lines = [ "🎭 <b>Поиск альтов</b>", "", `<b>${esc(decodeIfNeeded(r.name || "") || "Ник не найден")}</b>`, `<code>${r.ids.steamid64}</code>`, `<code>${r.ids.steamid}</code>`, "" ];
  if (r.noIplog || !r.groups.length) {
    lines.push(r.noIplog ? "Нет записей в ba_iplog." : "Совпадений по IP не найдено 🎉");
  } else {
    let total = 0;
    for (const g of r.groups) total += g.accs.length;
    lines.push(`<b>Совпадений: ${total}</b> (по ${r.groups.length} IP)`, "");
    for (const g of r.groups) {
      lines.push(`<code>${esc(g.ip)}</code>:`);
      for (const a of g.accs) {
        const flags = [ a.banned ? "🔨" : "", a.chsp ? "🚫" : "" ].join("");
        lines.push(` • ${esc(a.nickname || a.sid)} (<code>${a.sid}</code>)${flags} · ${fmtDate(a.lastseen)}`);
      }
      lines.push("");
    }
  }
  return {
    text: lines.join("\n"),
    keyboard: [ [ {
      text: "🔗 Steam профиль",
      url: `https://steamcommunity.com/profiles/${r.ids.steamid64}`
    } ] ]
  };
}

function telegramJobsPayload(items, filter) {
  const lines = [ "💼 <b>Список профессий</b>", filter ? `Фильтр: <code>${esc(filter)}</code>` : "Все профессии", "" ];
  if (!items.length) {
    lines.push("Ничего не найдено.");
  } else {
    lines.push(`<b>Профессий: ${items.length}</b>`, "", ...items.map(x => `<b>${x.id}.</b> ${esc(x.title || x.job_command)}\n<code>${esc(x.job_command)}</code>`));
  }
  return {
    text: lines.join("\n").slice(0, 4000)
  };
}

function telegramModelsPayload(items, filter) {
  const lines = [ "🧍 <b>Список моделей</b>", filter ? `Фильтр: <code>${esc(filter)}</code>` : "Все модели", "" ];
  if (!items.length) {
    lines.push("Ничего не найдено.");
  } else {
    lines.push(`<b>Моделей: ${items.length}</b>`, "", ...items.map(x => `<b>${x.id}.</b> ${esc(x.title || x.model_path)}`));
  }
  return {
    text: lines.join("\n").slice(0, 4000)
  };
}

function usagePayload(platform, cmd) {
  const map = {
    lookup: "Использование: /lookup <ник>",
    check: "Использование: /check <STEAMID>",
    ban: "Использование: /ban <STEAMID> [срок] [причина]\nСроки: 30mi · 2h · 1d · 1w · 1mo · perm",
    warn: "Использование: /warn <STEAMID> [причина]",
    unban: "Использование: /unban <STEAMID> [причина]",
    unwarn: "Использование: /unwarn <STEAMID> [причина]",
    props: "Использование: /props <STEAMID>",
    ip: "Использование: /ip <STEAMID>",
    alts: "Использование: /alts <STEAMID>",
    jobs: "Использование: /jobs [фильтр]",
    models: "Использование: /models [фильтр]",
    giveprops: "Использование: /giveprops <STEAMID> <кол-во> [setmodel]\nПример: /giveprops STEAM_0:1:12345 100 setmodel",
    giveqmenu: "Использование: /giveqmenu <STEAMID> [qmenu|qmenuplus]\nПо умолчанию: qmenu",
    revokeqmenu: "Использование: /revokeqmenu <STEAMID> [qmenu|qmenuplus]",
    givejob: "Использование: /givejob <STEAMID> <ID или название профессии>\nСписок: /jobs",
    revokejob: "Использование: /revokejob <STEAMID> <ID или название профессии>",
    givemodel: "Использование: /givemodel <STEAMID> <ID или название модели>\nСписок: /models",
    revokemodel: "Использование: /revokemodel <STEAMID> <ID или название модели>"
  };
  const text = map[cmd] || "Неизвестная команда. /help";
  if (platform === "telegram") return {
    text: `ℹ️ ${esc(text)}`
  };
  return `ℹ️ ${text}`;
}

async function runBotCommand({platform: platform, send: send, requestConfirm: requestConfirm, content: content, author: author}) {
  const text = String(content || "").trim();
  const m = text.match(/^[!／\/](check|lookup|ban|warn|unban|unwarn|stats|help|start|props|ip|alts|giveprops|giveqmenu|revokeqmenu|givejob|revokejob|givemodel|revokemodel|jobs|models)\b\s*([\s\S]*)$/i);
  if (!m) return false;
  const cmd = m[1].toLowerCase();
  const rest = (m[2] || "").trim();
  try {
    if (cmd === "help" || cmd === "start") {
      await send(platform === "discord" ? discordHelpEmbed() : telegramHelpPayload());
      return true;
    }
    if (cmd === "stats") {
      const s = await cmdStats();
      await send(platform === "discord" ? discordStatsEmbed(s) : telegramStatsPayload(s));
      return true;
    }
    if (cmd === "lookup") {
      if (!rest) {
        await send(usagePayload(platform, "lookup"));
        return true;
      }
      const res = await cmdLookup(rest);
      await send(platform === "discord" ? discordLookupEmbed(res, rest) : telegramLookupPayload(res, rest));
      return true;
    }
    if (cmd === "jobs") {
      const items = await listJobs(rest);
      await send(platform === "discord" ? discordJobsEmbed(items, rest) : telegramJobsPayload(items, rest));
      return true;
    }
    if (cmd === "models") {
      const items = await listModels(rest);
      await send(platform === "discord" ? discordModelsEmbed(items, rest) : telegramModelsPayload(items, rest));
      return true;
    }
    const tokens = rest.split(/\s+/).filter(Boolean);
    const ids = normSteam(tokens[0] || "");
    if (!ids) {
      await send(usagePayload(platform, cmd));
      return true;
    }
    if (cmd === "check") {
      const res = await cmdCheck(ids);
      await send(platform === "discord" ? discordCheckEmbed(res) : telegramCheckPayload(res));
      return true;
    }
    if (cmd === "props") {
      const res = await cmdProps(ids);
      await send(platform === "discord" ? discordPropsEmbed(res) : telegramPropsPayload(res));
      return true;
    }
    if (cmd === "ip") {
      const res = await cmdIp(ids);
      await send(platform === "discord" ? discordIpEmbed(res) : telegramIpPayload(res));
      return true;
    }
    if (cmd === "alts") {
      const res = await cmdAlts(ids);
      await send(platform === "discord" ? discordAltsEmbed(res) : telegramAltsPayload(res));
      return true;
    }
    const adminLabel = {
      name: adminDisplayName(platform, author),
      sid: await resolveAdminSid(platform, author)
    };
    const name = await getBotPlayerName(db(), ids.steamid64) || "—";
    if (cmd === "giveprops") {
      const amount = parseInt(tokens[1] || "", 10);
      if (!Number.isFinite(amount) || amount < 0) {
        await send(usagePayload(platform, "giveprops"));
        return true;
      }
      const setmodel = tokens.slice(2).some(t => /^(setmodel|sm|модель)$/i.test(t)) || (tokens[2] !== void 0 && /^(1|true|да|yes)$/i.test(tokens[2]));
      const res = await cmdGiveProps(ids, amount, setmodel, adminLabel);
      await send(platform === "discord" ? discordGiveSuccessEmbed(res, "props") : telegramGivePayload(res, "props"));
      return true;
    }
    if (cmd === "giveqmenu" || cmd === "revokeqmenu") {
      const type = String(tokens[1] || "qmenu").toLowerCase();
      if (![ "qmenu", "qmenuplus" ].includes(type)) {
        await send(usagePayload(platform, cmd));
        return true;
      }
      const res = cmd === "giveqmenu" ? await cmdGiveQmenu(ids, type, adminLabel) : await cmdRevokeQmenu(ids, type, adminLabel);
      await send(platform === "discord" ? (cmd === "giveqmenu" ? discordGiveSuccessEmbed(res, "qmenu") : discordRevokeEmbed(res, "qmenu")) : (cmd === "giveqmenu" ? telegramGivePayload(res, "qmenu") : telegramRevokePayload(res, "qmenu")));
      return true;
    }
    if (cmd === "givejob" || cmd === "revokejob") {
      const term = tokens.slice(1).join(" ");
      if (!term) {
        await send(usagePayload(platform, cmd));
        return true;
      }
      const found = await findJob(term);
      if (!found.length) {
        await send(platform === "discord" ? discordGiveEmbed("❌ Профессия не найдена", COLORS.ban, [ `Запрос: \`${term}\``, "Проверь список: `/jobs`" ]) : {
          text: `❌ <b>Профессия не найдена:</b> <code>${esc(term)}</code>\nПроверь список: <code>/jobs</code>`
        });
        return true;
      }
      if (found.length > 1) {
        await send(platform === "discord" ? discordPickEmbed("job", term, found) : telegramPickPayload("job", term, found));
        return true;
      }
      const res = cmd === "givejob" ? await cmdGiveJob(ids, found[0], adminLabel) : await cmdRevokeJob(ids, found[0], adminLabel);
      await send(platform === "discord" ? (cmd === "givejob" ? discordGiveSuccessEmbed(res, "job") : discordRevokeEmbed(res, "job")) : (cmd === "givejob" ? telegramGivePayload(res, "job") : telegramRevokePayload(res, "job")));
      return true;
    }
    if (cmd === "givemodel" || cmd === "revokemodel") {
      const term = tokens.slice(1).join(" ");
      if (!term) {
        await send(usagePayload(platform, cmd));
        return true;
      }
      const found = await findModel(term);
      if (!found.length) {
        await send(platform === "discord" ? discordGiveEmbed("❌ Модель не найдена", COLORS.ban, [ `Запрос: \`${term}\``, "Проверь список: `/models`" ]) : {
          text: `❌ <b>Модель не найдена:</b> <code>${esc(term)}</code>\nПроверь список: <code>/models</code>`
        });
        return true;
      }
      if (found.length > 1) {
        await send(platform === "discord" ? discordPickEmbed("model", term, found) : telegramPickPayload("model", term, found));
        return true;
      }
      const res = cmd === "givemodel" ? await cmdGiveModel(ids, found[0], adminLabel) : await cmdRevokeModel(ids, found[0], adminLabel);
      await send(platform === "discord" ? (cmd === "givemodel" ? discordGiveSuccessEmbed(res, "model") : discordRevokeEmbed(res, "model")) : (cmd === "givemodel" ? telegramGivePayload(res, "model") : telegramRevokePayload(res, "model")));
      return true;
    }
    if (cmd === "ban") {
      let seconds = 0;
      let reasonTokens = tokens.slice(1);
      const parsed = parseBanDurationToken(tokens[1]);
      if (parsed) {
        seconds = parsed.seconds;
        reasonTokens = tokens.slice(2);
      }
      const reason = reasonTokens.join(" ").trim() || "Без причины";
      const pending = createPending({
        action: "ban",
        platform: platform,
        ids: ids,
        name: name,
        reason: reason,
        durationSeconds: seconds,
        adminLabel: adminLabel
      });
      await requestConfirm(pending);
      return true;
    }
    if (cmd === "warn" || cmd === "unban" || cmd === "unwarn") {
      const reason = tokens.slice(1).join(" ").trim() || "Без причины";
      const pending = createPending({
        action: cmd,
        platform: platform,
        ids: ids,
        name: name,
        reason: reason,
        adminLabel: adminLabel
      });
      await requestConfirm(pending);
      return true;
    }
  } catch (e) {
    console.error("[BOT CMD] error:", e?.message || e);
    try {
      await send(platform === "telegram" ? {
        text: "❌ <b>Ошибка выполнения команды.</b>"
      } : "❌ Ошибка выполнения команды.");
    } catch {}
  }
  return true;
}

export { runBotCommand, resolvePendingMod, parseBanDurationToken, fmtDuration, insertRow, discordConfirmEmbed, discordConfirmRow, discordOutcomeEmbed, telegramConfirmHtml, telegramOutcomeHtml };
