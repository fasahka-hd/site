import { Router } from "express";

import { timingSafeEqual } from "crypto";

import { db } from "../lib/db.js";

import { requirePerm } from "../lib/roles.js";

import { authGuard } from "../lib/guard.js";

import { decodeIfNeeded, logAdminAction, readQueueFile, writeQueueFile } from "../lib/helpers.js";

import { withQueueLock } from "../lib/queue_lock.js";

let _tablesEnsured = false;

async function ensureDuelsTables() {
  if (_tablesEnsured) return;
  const pool = db();
  await pool.query(`CREATE TABLE IF NOT EXISTS panel_duels_stats (
    steamid64 VARCHAR(20) NOT NULL,
    name VARCHAR(128) NOT NULL DEFAULT '',
    wins INT NOT NULL DEFAULT 0,
    losses INT NOT NULL DEFAULT 0,
    favourite VARCHAR(128) NOT NULL DEFAULT '',
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (steamid64)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS panel_duels_weapons (
    steamid64 VARCHAR(20) NOT NULL,
    weapon VARCHAR(128) NOT NULL,
    uses INT NOT NULL DEFAULT 0,
    PRIMARY KEY (steamid64, weapon)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS panel_duels_history (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    rowid INT NOT NULL DEFAULT 0,
    steamid64 VARCHAR(20) NOT NULL DEFAULT '',
    name VARCHAR(128) NOT NULL DEFAULT '',
    opponent VARCHAR(128) NOT NULL DEFAULT '',
    weapon VARCHAR(128) NOT NULL DEFAULT '',
    amount BIGINT NOT NULL DEFAULT 0,
    donate TINYINT(1) NOT NULL DEFAULT 0,
    result VARCHAR(16) NOT NULL DEFAULT '',
    stamp INT UNSIGNED NOT NULL DEFAULT 0,
    PRIMARY KEY (id),
    UNIQUE KEY uq_duel_row (steamid64, rowid),
    KEY idx_duel_stamp (stamp),
    KEY idx_duel_name (name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  _tablesEnsured = true;
}





const lobbyState = {
  updatedAt: 0,
  items: []
};

const syncState = {
  lastStatsPush: 0,
  lastHistoryPush: 0,
  statsPlayers: 0
};

const LOBBY_STALE_MS = 2e4;

function safeCompare(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    const tmp = Buffer.alloc(bufA.length);
    timingSafeEqual(bufA, tmp);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function intNum(v, dflt = 0) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
}

function cleanStr(v, max = 128) {
  return String(v == null ? "" : v).slice(0, max);
}

function sidOk(v) {
  return /^\d{5,20}$/.test(String(v || ""));
}

async function ensureReady() {
  await ensureDuelsTables();
}

async function pushStatsBatch(pool, stats, weapons, reset) {
  const conn = pool;
  if (reset) {
    await conn.query("DELETE FROM panel_duels_stats");
    await conn.query("DELETE FROM panel_duels_weapons");
  }
  if (Array.isArray(stats) && stats.length) {
    const ph = stats.map(() => "(?, ?, ?, ?, ?)").join(",");
    const args = [];
    for (const s of stats) {
      args.push(cleanStr(s.steamid, 24), decodeIfNeeded(cleanStr(s.name, 128)), Math.max(0, intNum(s.wins)), Math.max(0, intNum(s.losses)), cleanStr(s.favourite, 128));
    }
    await conn.query(`INSERT INTO panel_duels_stats (steamid64, name, wins, losses, favourite) VALUES ${ph} ON DUPLICATE KEY UPDATE name=VALUES(name), wins=VALUES(wins), losses=VALUES(losses), favourite=VALUES(favourite)`, args);
  }
  if (Array.isArray(weapons) && weapons.length) {
    const ph = weapons.map(() => "(?, ?, ?)").join(",");
    const args = [];
    for (const w of weapons) {
      args.push(cleanStr(w.steamid, 24), cleanStr(w.weapon, 128), Math.max(0, intNum(w.uses)));
    }
    await conn.query(`INSERT INTO panel_duels_weapons (steamid64, weapon, uses) VALUES ${ph} ON DUPLICATE KEY UPDATE uses=VALUES(uses)`, args);
  }
}

async function enqueueConsole(text, adminSid64) {
  const cmdId = await withQueueLock(async () => {
    const data = readQueueFile();
    const now = Math.floor(Date.now() / 1e3);
    const id = "cmd_" + now + "_" + Math.floor(1e3 + Math.random() * 9e3);
    data.push({
      id: id,
      type: "console",
      text: text,
      admin_steamid64: adminSid64 || "",
      done: false,
      processing: false,
      time: now
    });
    writeQueueFile(data);
    return id;
  });
  return cmdId;
}

function lobbyOut(l) {
  return {
    id: intNum(l.id),
    owner_sid: cleanStr(l.owner_sid, 24),
    owner_name: cleanStr(l.owner_name, 128),
    target_sid: cleanStr(l.target_sid, 24),
    target_name: cleanStr(l.target_name, 128),
    amount: Math.max(0, intNum(l.amount)),
    armor: !!l.armor,
    donate: !!l.donate,
    rating: !!l.rating,
    weapon: cleanStr(l.weapon, 128),
    weapon_name: cleanStr(l.weapon_name, 128),
    victories: Math.max(0, intNum(l.victories)),
    losses: Math.max(0, intNum(l.losses)),
    started: !!l.started,
    time_left: Math.max(0, intNum(l.time_left)),
    arena: intNum(l.arena)
  };
}



function pick(obj, keys) {
  if (!obj || typeof obj !== "object") return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (v === undefined || v === null || v === "") continue;
    if (typeof v === "object") {
      const inner = pick(v, [ "sid", "steamid", "steamid64", "id" ]) || pick(v, [ "name", "nick" ]);
      if (inner !== undefined) return inner;
      continue;
    }
    return v;
  }
  return undefined;
}

function pickBool(obj, keys) {
  const v = pick(obj, keys);
  if (v === undefined) return false;
  return v === true || v === 1 || v === "1" || v === "true";
}

function normLobby(l) {
  if (!l || typeof l !== "object") return null;
  const ownerObj = typeof l.owner === "object" && l.owner ? l.owner : {};
  const targetObj = typeof l.target === "object" && l.target ? l.target : {};
  const out = lobbyOut({
    id: pick(l, [ "id", "lobby_id", "index" ]),
    owner_sid: pick(l, [ "owner_sid", "owner_steamid", "owner_steamid64", "ownerid" ]) || pick(ownerObj, [ "sid", "steamid", "steamid64", "id" ]) || pick(l, [ "owner" ]),
    owner_name: pick(l, [ "owner_name", "owner_nick", "ownername" ]) || pick(ownerObj, [ "name", "nick" ]),
    target_sid: pick(l, [ "target_sid", "target_steamid", "target_steamid64", "targetid", "opponent_sid" ]) || pick(targetObj, [ "sid", "steamid", "steamid64", "id" ]) || (typeof l.target === "string" || typeof l.target === "number" ? l.target : undefined),
    target_name: pick(l, [ "target_name", "target_nick", "targetname", "opponent_name" ]) || pick(targetObj, [ "name", "nick" ]),
    amount: pick(l, [ "amount", "bet", "stake", "sum" ]),
    armor: pickBool(l, [ "armor", "witharmor", "with_armor" ]),
    donate: pickBool(l, [ "donate", "isdonate", "is_donate" ]),
    rating: pickBool(l, [ "rating", "israting", "is_rating", "rated" ]),
    weapon: pick(l, [ "weapon", "weapon_class", "class" ]),
    weapon_name: pick(l, [ "weapon_name", "weaponname", "weapon_print", "weapon_title" ]),
    victories: pick(l, [ "victories", "owner_victories", "owner_wins", "wins" ]),
    losses: pick(l, [ "losses", "owner_losses" ]),
    started: pickBool(l, [ "started", "isstarted", "is_started", "active", "live" ]),
    time_left: pick(l, [ "time_left", "timeleft", "left" ]),
    arena: pick(l, [ "arena", "arena_index", "arena_id" ])
  });
  return out.id > 0 ? out : null;
}

function normStat(s) {
  if (!s || typeof s !== "object") return null;
  const out = {
    steamid: pick(s, [ "steamid", "sid", "steamid64", "steam_id" ]),
    name: pick(s, [ "name", "nick", "nickname" ]),
    wins: pick(s, [ "wins", "victories" ]),
    losses: pick(s, [ "losses", "defeats" ]),
    favourite: pick(s, [ "favourite", "favorite", "fav", "fav_weapon" ])
  };
  return sidOk(out.steamid) ? out : null;
}

function normWeapon(w) {
  if (!w || typeof w !== "object") return null;
  const out = {
    steamid: pick(w, [ "steamid", "sid", "steamid64" ]),
    weapon: pick(w, [ "weapon", "class", "weapon_class" ]),
    uses: pick(w, [ "uses", "count" ])
  };
  return sidOk(out.steamid) && out.weapon ? out : null;
}

function normHistoryRow(h) {
  if (!h || typeof h !== "object") return null;
  const rid = intNum(pick(h, [ "rowid", "id", "idx" ]), 0);
  if (!rid) return null;
  const out = {
    rowid: rid,
    steamid: pick(h, [ "steamid", "sid", "steamid64" ]),
    name: pick(h, [ "name", "nick", "nickname" ]),
    opponent: pick(h, [ "opponent", "opponent_name", "enemy", "vs" ]),
    weapon: pick(h, [ "weapon", "class", "weapon_class" ]),
    amount: pick(h, [ "amount", "bet", "stake" ]),
    donate: pickBool(h, [ "donate", "isdonate", "is_donate" ]),
    result: pick(h, [ "result", "outcome" ]),
    stamp: pick(h, [ "stamp", "time", "timestamp", "date" ])
  };
  return sidOk(out.steamid) ? out : null;
}

const ACTION_ALIASES = new Map([ [ "push_lobbies", "push_lobbies" ], [ "lobbies", "push_lobbies" ], [ "lobby", "push_lobbies" ], [ "active", "push_lobbies" ], [ "active_lobbies", "push_lobbies" ], [ "lobby_sync", "push_lobbies" ], [ "sync_lobbies", "push_lobbies" ], [ "push_lobby", "push_lobbies" ], [ "push_stats", "push_stats" ], [ "stats", "push_stats" ], [ "stats_sync", "push_stats" ], [ "sync_stats", "push_stats" ], [ "full_stats", "push_stats" ], [ "stats_snapshot", "push_stats" ], [ "snapshot", "push_stats" ], [ "push_snapshot", "push_stats" ], [ "sync", "push_stats" ], [ "push_history", "push_history" ], [ "history", "push_history" ], [ "history_sync", "push_history" ], [ "sync_history", "push_history" ], [ "logs", "push_history" ], [ "duel_logs", "push_history" ], [ "push_logs", "push_history" ] ]);

function resolveSyncAction(params) {
  const raw = String(params?.action || params?.type || "").trim().toLowerCase();
  if (ACTION_ALIASES.has(raw)) return ACTION_ALIASES.get(raw);
  if (Array.isArray(params?.lobbies)) return "push_lobbies";
  if (Array.isArray(params?.rows)) return "push_history";
  if (Array.isArray(params?.stats) || Array.isArray(params?.weapons)) return "push_stats";
  return null;
}

function duelsRoutes(cfg) {
  const r = Router();
  function requirePassword(req, res) {
    const pass = String(req.body?.password || req.query?.password || req.headers["x-api-password"] || (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim() || "").trim();
    if (!cfg.WEB_SECRET || !safeCompare(pass, cfg.WEB_SECRET)) {
      res.status(403).json({
        ok: false,
        error: "BAD_PASSWORD"
      });
      return false;
    }
    return true;
  }
  r.all("/api/duels_sync", async (req, res) => {
    if (!requirePassword(req, res)) return;
    try {
      await ensureReady();
      const pool = db();
      const params = req.body && Object.keys(req.body).length ? req.body : req.query;
      const action = resolveSyncAction(params);
      if (action === "push_lobbies") {
        const list = Array.isArray(params.lobbies) ? params.lobbies : [];
        lobbyState.updatedAt = Date.now();
        lobbyState.items = list.map(normLobby).filter(Boolean);
        return res.json({
          ok: true,
          count: lobbyState.items.length
        });
      }
      if (action === "push_stats") {
        const stats = Array.isArray(params.stats) ? params.stats.map(normStat).filter(Boolean) : [];
        const weapons = Array.isArray(params.weapons) ? params.weapons.map(normWeapon).filter(Boolean) : [];
        const resetRaw = params.reset;
        const reset = resetRaw === true || [ "1", "true", "yes" ].includes(String(resetRaw || "").toLowerCase());
        await pushStatsBatch(pool, stats, weapons, reset);
        syncState.lastStatsPush = Date.now();
        if (reset) syncState.statsPlayers = 0;
        syncState.statsPlayers += stats.length;
        return res.json({
          ok: true,
          received: stats.length,
          weapons: weapons.length
        });
      }
      if (action === "push_history") {
        const rows = Array.isArray(params.rows) ? params.rows.map(normHistoryRow).filter(Boolean) : [];
        let maxId = 0;
        if (rows.length) {
          const values = [];
          const args = [];
          for (const h of rows) {
            values.push("(?, ?, ?, ?, ?, ?, ?, ?, ?)");
            args.push(h.rowid, cleanStr(h.steamid, 24), decodeIfNeeded(cleanStr(h.name, 128)), decodeIfNeeded(cleanStr(h.opponent, 128)), cleanStr(h.weapon, 128), Math.max(0, intNum(h.amount)), h.donate ? 1 : 0, cleanStr(h.result, 16), Math.max(0, intNum(h.stamp)));
            if (h.rowid > maxId) maxId = h.rowid;
          }
          if (values.length) {
            await pool.query(`INSERT IGNORE INTO panel_duels_history (rowid, steamid64, name, opponent, weapon, amount, donate, result, stamp) VALUES ${values.join(",")}`, args);
          }
        }
        syncState.lastHistoryPush = Date.now();
        return res.json({
          ok: true,
          received: rows.length,
          max_id: maxId
        });
      }
      

      

      console.warn("[duels_sync] unknown action ignored:", String(params?.action || params?.type || "(нет action)").slice(0, 64), JSON.stringify(params || {}).slice(0, 300));
      res.json({
        ok: true,
        ignored: true,
        hint: "неизвестный формат пакета — панель его пропустила"
      });
    } catch (e) {
      console.error("duels_sync error:", e.message);
      res.status(500).json({
        ok: false,
        error: "DB_ERROR"
      });
    }
  });
  r.get("/api/tech_duels/overview", authGuard, requirePerm("view_money_logs"), async (req, res) => {
    try {
      await ensureReady();
      const pool = db();
      const [[s]] = await pool.query("SELECT COUNT(*) AS players, COALESCE(SUM(wins),0) AS total_wins, COALESCE(SUM(losses),0) AS total_losses FROM panel_duels_stats");
      const [[h]] = await pool.query("SELECT COUNT(*) AS total, COALESCE(MAX(stamp),0) AS last_stamp FROM panel_duels_history");
      const ratingWins = intNum(s.total_wins);
      const ratingLosses = intNum(s.total_losses);
      res.json({
        ok: true,
        stats: {
          players: intNum(s.players),
          total_wins: ratingWins,
          total_losses: ratingLosses,
          total_duels: ratingWins + ratingLosses,
          history_rows: intNum(h.total),
          last_history_stamp: intNum(h.last_stamp)
        },
        sync: {
          lobbies_at: lobbyState.updatedAt,
          stats_at: syncState.lastStatsPush,
          history_at: syncState.lastHistoryPush,
          lobbies_fresh: lobbyState.updatedAt > 0 && Date.now() - lobbyState.updatedAt < LOBBY_STALE_MS
        },
        lobbies: lobbyState.items
      });
    } catch (e) {
      console.error("tech_duels overview error:", e.message);
      res.status(500).json({
        ok: false,
        error: "DB_ERROR"
      });
    }
  });
  r.get("/api/tech_duels/top", authGuard, requirePerm("view_money_logs"), async (req, res) => {
    try {
      await ensureReady();
      const pool = db();
      const limit = Math.min(100, Math.max(1, intNum(req.query.limit, 10)));
      const [rows] = await pool.query("SELECT steamid64, name, wins, losses, favourite FROM panel_duels_stats WHERE wins > 0 OR losses > 0 ORDER BY wins DESC, losses ASC LIMIT ?", [ limit ]);
      res.json({
        ok: true,
        items: rows.map(x => ({
          steamid64: String(x.steamid64 || ""),
          name: String(x.name || "—"),
          wins: intNum(x.wins),
          losses: intNum(x.losses),
          favourite: String(x.favourite || ""),
          winrate: intNum(x.wins) + intNum(x.losses) > 0 ? Math.round(intNum(x.wins) / (intNum(x.wins) + intNum(x.losses)) * 100) : 0
        }))
      });
    } catch (e) {
      console.error("tech_duels top error:", e.message);
      res.status(500).json({
        ok: false,
        error: "DB_ERROR"
      });
    }
  });
  r.get("/api/tech_duels/players", authGuard, requirePerm("view_money_logs"), async (req, res) => {
    try {
      await ensureReady();
      const pool = db();
      const q = String(req.query.q || "").trim();
      const sort = [ "wins", "losses", "total", "name" ].includes(String(req.query.sort)) ? String(req.query.sort) : "total";
      const orderSql = sort === "name" ? "name ASC" : sort === "wins" ? "wins DESC, losses ASC" : sort === "losses" ? "losses DESC, wins DESC" : "(wins + losses) DESC, wins DESC";
      const args = [];
      let where = "";
      if (q) {
        where = "WHERE name LIKE ? OR steamid64 LIKE ?";
        args.push(`%${q}%`, `%${q}%`);
      }
      const [[c]] = await pool.query(`SELECT COUNT(*) AS total FROM panel_duels_stats ${where}`, args);
      const total = intNum(c.total);
      const perPage = Math.min(100, Math.max(10, intNum(req.query.per_page, 50)));
      const pages = Math.max(1, Math.ceil(total / perPage));
      const page = Math.min(pages, Math.max(1, intNum(req.query.page, 1)));
      const [rows] = await pool.query(`SELECT steamid64, name, wins, losses, favourite, UNIX_TIMESTAMP(updated_at) AS updated_ts FROM panel_duels_stats ${where} ORDER BY ${orderSql} LIMIT ? OFFSET ?`, [ ...args, perPage, (page - 1) * perPage ]);
      res.json({
        ok: true,
        total: total,
        page: page,
        pages: pages,
        items: rows.map(x => ({
          steamid64: String(x.steamid64 || ""),
          name: String(x.name || "—"),
          wins: intNum(x.wins),
          losses: intNum(x.losses),
          favourite: String(x.favourite || ""),
          updated_ts: intNum(x.updated_ts),
          winrate: intNum(x.wins) + intNum(x.losses) > 0 ? Math.round(intNum(x.wins) / (intNum(x.wins) + intNum(x.losses)) * 100) : 0
        }))
      });
    } catch (e) {
      console.error("tech_duels players error:", e.message);
      res.status(500).json({
        ok: false,
        error: "DB_ERROR"
      });
    }
  });
  r.get("/api/tech_duels/player", authGuard, requirePerm("view_money_logs"), async (req, res) => {
    try {
      await ensureReady();
      const pool = db();
      const sid = String(req.query.sid || "").trim();
      if (!sidOk(sid)) return res.status(400).json({
        ok: false,
        error: "BAD_STEAMID"
      });
      const [[st]] = await pool.query("SELECT steamid64, name, wins, losses, favourite, UNIX_TIMESTAMP(updated_at) AS updated_ts FROM panel_duels_stats WHERE steamid64 = ? LIMIT 1", [ sid ]);
      const [weapons] = await pool.query("SELECT weapon, uses FROM panel_duels_weapons WHERE steamid64 = ? ORDER BY uses DESC LIMIT 20", [ sid ]);
      const [history] = await pool.query("SELECT rowid, name, opponent, weapon, amount, donate, result, stamp FROM panel_duels_history WHERE steamid64 = ? ORDER BY stamp DESC, rowid DESC LIMIT 50", [ sid ]);
      const lobby = lobbyState.items.find(l => l.owner_sid === sid || l.target_sid === sid) || null;
      res.json({
        ok: true,
        stats: st ? {
          steamid64: String(st.steamid64 || ""),
          name: String(st.name || "—"),
          wins: intNum(st.wins),
          losses: intNum(st.losses),
          favourite: String(st.favourite || ""),
          updated_ts: intNum(st.updated_ts),
          winrate: intNum(st.wins) + intNum(st.losses) > 0 ? Math.round(intNum(st.wins) / (intNum(st.wins) + intNum(st.losses)) * 100) : 0
        } : null,
        weapons: weapons.map(w => ({
          weapon: String(w.weapon || ""),
          uses: intNum(w.uses)
        })),
        history: history.map(h2 => ({
          rowid: intNum(h2.rowid),
          name: String(h2.name || "—"),
          opponent: String(h2.opponent || "—"),
          weapon: String(h2.weapon || ""),
          amount: intNum(h2.amount),
          donate: !!h2.donate,
          result: String(h2.result || ""),
          stamp: intNum(h2.stamp)
        })),
        lobby: lobby
      });
    } catch (e) {
      console.error("tech_duels player error:", e.message);
      res.status(500).json({
        ok: false,
        error: "DB_ERROR"
      });
    }
  });
  r.get("/api/tech_duels/history", authGuard, requirePerm("view_money_logs"), async (req, res) => {
    try {
      await ensureReady();
      const pool = db();
      const q = String(req.query.q || "").trim();
      const result = String(req.query.result || "all");
      const args = [];
      const conds = [];
      if (q) {
        conds.push("(name LIKE ? OR opponent LIKE ? OR steamid64 LIKE ? OR weapon LIKE ?)");
        args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
      }
      if (result === "win" || result === "lose") {
        conds.push("result = ?");
        args.push(result);
      }
      const where = conds.length ? "WHERE " + conds.join(" AND ") : "";
      const [[c]] = await pool.query(`SELECT COUNT(*) AS total FROM panel_duels_history ${where}`, args);
      const total = intNum(c.total);
      const perPage = Math.min(100, Math.max(10, intNum(req.query.per_page, 50)));
      const pages = Math.max(1, Math.ceil(total / perPage));
      const page = Math.min(pages, Math.max(1, intNum(req.query.page, 1)));
      const [rows] = await pool.query(`SELECT rowid, steamid64, name, opponent, weapon, amount, donate, result, stamp FROM panel_duels_history ${where} ORDER BY stamp DESC, rowid DESC LIMIT ? OFFSET ?`, [ ...args, perPage, (page - 1) * perPage ]);
      res.json({
        ok: true,
        total: total,
        page: page,
        pages: pages,
        items: rows.map(h2 => ({
          rowid: intNum(h2.rowid),
          steamid64: String(h2.steamid64 || ""),
          name: String(h2.name || "—"),
          opponent: String(h2.opponent || "—"),
          weapon: String(h2.weapon || ""),
          amount: intNum(h2.amount),
          donate: !!h2.donate,
          result: String(h2.result || ""),
          stamp: intNum(h2.stamp)
        }))
      });
    } catch (e) {
      console.error("tech_duels history error:", e.message);
      res.status(500).json({
        ok: false,
        error: "DB_ERROR"
      });
    }
  });
  r.post("/api/tech_duels/action", authGuard, requirePerm("view_money_logs"), async (req, res) => {
    try {
      await ensureReady();
      const pool = db();
      const b = req.body || {};
      const action = String(b.action || "").toLowerCase();
      const admin = String(req.session?.user?.steamid64 || "");
      if (action === "reset_player") {
        const sid = String(b.steamid64 || "").trim();
        if (!/^\d{17}$/.test(sid)) return res.status(400).json({
          ok: false,
          error: "BAD_STEAMID"
        });
        await pool.query("UPDATE panel_duels_stats SET wins = 0, losses = 0, favourite = '' WHERE steamid64 = ?", [ sid ]);
        await pool.query("DELETE FROM panel_duels_weapons WHERE steamid64 = ?", [ sid ]);
        await enqueueConsole(`duels_reset_stats ${sid}`, admin);
        await logAdminAction(pool, admin, "DUEL_RESET_PLAYER", sid, JSON.stringify({
          action: "reset_player",
          steamid64: sid
        }));
        return res.json({
          ok: true
        });
      }
      if (action === "reset_all") {
        await pool.query("UPDATE panel_duels_stats SET wins = 0, losses = 0, favourite = ''");
        await pool.query("DELETE FROM panel_duels_weapons");
        await enqueueConsole("duels_reset_stats_all", admin);
        await logAdminAction(pool, admin, "DUEL_RESET_ALL", "all", JSON.stringify({
          action: "reset_all"
        }));
        return res.json({
          ok: true
        });
      }
      res.status(400).json({
        ok: false,
        error: "BAD_ACTION"
      });
    } catch (e) {
      console.error("tech_duels action error:", e.message);
      res.status(500).json({
        ok: false,
        error: "DB_ERROR"
      });
    }
  });
  return r;
}

export { duelsRoutes as default };
