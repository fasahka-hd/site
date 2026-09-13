import { Router } from "express";

import { db } from "../lib/db.js";

import { requirePerm } from "../lib/roles.js";

import { authGuard } from "../lib/guard.js";

import { decodeIfNeeded, logAdminAction, readQueueFile, writeQueueFile } from "../lib/helpers.js";

import { withQueueLock } from "../lib/queue_lock.js";

async function enqueueCommand(text, adminSid64) {
  try {
    return await withQueueLock(async () => {
      const data = readQueueFile();
      const now = Math.floor(Date.now() / 1e3);
      const id = "cmd_" + now + "_" + Math.floor(1e3 + Math.random() * 9e3);
      data.push({
        id: id,
        type: "console",
        text: text,
        admin_steamid64: String(adminSid64 || ""),
        done: false,
        processing: false,
        time: now
      });
      writeQueueFile(data);
      return id;
    });
  } catch (e) {
    console.error("duels enqueue:", e.message);
    return null;
  }
}

let ensured = false;

async function ensureTables(pool) {
  if (ensured) return;
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS duels_stats (
      steamid VARCHAR(20) NOT NULL,
      name VARCHAR(64) DEFAULT '',
      wins INT NOT NULL DEFAULT 0,
      losses INT NOT NULL DEFAULT 0,
      favourite VARCHAR(64) DEFAULT '',
      PRIMARY KEY (steamid)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    await pool.query(`CREATE TABLE IF NOT EXISTS duels_weapons (
      steamid VARCHAR(20) NOT NULL,
      weapon VARCHAR(64) NOT NULL,
      uses INT NOT NULL DEFAULT 0,
      PRIMARY KEY (steamid, weapon)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    await pool.query(`CREATE TABLE IF NOT EXISTS duels_history (
      id INT NOT NULL AUTO_INCREMENT,
      stamp INT NOT NULL DEFAULT 0,
      date VARCHAR(32) DEFAULT '',
      map VARCHAR(64) DEFAULT '',
      winner_sid VARCHAR(20) DEFAULT '',
      winner_name VARCHAR(64) DEFAULT '',
      loser_sid VARCHAR(20) DEFAULT '',
      loser_name VARCHAR(64) DEFAULT '',
      weapon VARCHAR(64) DEFAULT '',
      weapon_name VARCHAR(64) DEFAULT '',
      amount BIGINT NOT NULL DEFAULT 0,
      currency VARCHAR(16) DEFAULT 'money',
      donate TINYINT NOT NULL DEFAULT 0,
      rating TINYINT NOT NULL DEFAULT 0,
      armor TINYINT NOT NULL DEFAULT 0,
      result VARCHAR(16) DEFAULT 'win',
      duration INT NOT NULL DEFAULT 0,
      PRIMARY KEY (id),
      KEY idx_duels_hist_stamp (stamp),
      KEY idx_duels_hist_winner (winner_sid),
      KEY idx_duels_hist_loser (loser_sid)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    await pool.query(`CREATE TABLE IF NOT EXISTS duels_arenas (
      id INT NOT NULL AUTO_INCREMENT,
      map VARCHAR(64) DEFAULT '',
      name VARCHAR(64) DEFAULT '',
      p1x DOUBLE DEFAULT 0, p1y DOUBLE DEFAULT 0, p1z DOUBLE DEFAULT 0, a1y DOUBLE DEFAULT 0,
      p2x DOUBLE DEFAULT 0, p2y DOUBLE DEFAULT 0, p2z DOUBLE DEFAULT 0, a2y DOUBLE DEFAULT 0,
      in_use TINYINT NOT NULL DEFAULT 0,
      busy_until INT NOT NULL DEFAULT 0,
      PRIMARY KEY (id),
      KEY idx_duels_arena_map (map)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    await pool.query(`CREATE TABLE IF NOT EXISTS duels_active (
      id INT NOT NULL AUTO_INCREMENT,
      lobby_id INT NOT NULL DEFAULT 0,
      map VARCHAR(64) DEFAULT '',
      arena_id INT NOT NULL DEFAULT 0,
      arena_name VARCHAR(64) DEFAULT '',
      owner_sid VARCHAR(20) DEFAULT '',
      owner_name VARCHAR(64) DEFAULT '',
      target_sid VARCHAR(20) DEFAULT '',
      target_name VARCHAR(64) DEFAULT '',
      weapon VARCHAR(64) DEFAULT '',
      weapon_name VARCHAR(64) DEFAULT '',
      amount BIGINT NOT NULL DEFAULT 0,
      donate TINYINT NOT NULL DEFAULT 0,
      rating TINYINT NOT NULL DEFAULT 0,
      armor TINYINT NOT NULL DEFAULT 0,
      started TINYINT NOT NULL DEFAULT 0,
      start_stamp INT NOT NULL DEFAULT 0,
      end_stamp INT NOT NULL DEFAULT 0,
      updated INT NOT NULL DEFAULT 0,
      PRIMARY KEY (id),
      KEY idx_duels_active_map (map)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    ensured = true;
  } catch (e) {
    console.error("duels ensureTables:", e.message);
  }
}

function nick(v) {
  const s = decodeIfNeeded(v || "").trim();
  return s || "—";
}

function sid64(v) {
  const s = String(v || "").trim();
  return /^\d{17}$/.test(s) ? s : "";
}

function intOr(v, def = 0) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

function pct(w, l) {
  const total = w + l;
  if (!total) return 0;
  return Math.round(w / total * 1000) / 10;
}

function techDuelsRoutes(cfg, syncLimiter) {
  const r = Router();

  function gameAuth(req, res, next) {
    const pass = String(req.body?.password || req.headers["x-api-password"] || (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim() || "").trim();
    const secret = cfg?.WEB_SECRET || process.env.WEB_SECRET || "";
    if (!secret || pass !== secret) return res.status(403).json({ ok: false, error: "BAD_PASSWORD" });
    next();
  }

  const syncMw = syncLimiter ? [ syncLimiter, gameAuth ] : [ gameAuth ];

  r.post("/api/duels_sync", syncMw, async (req, res) => {
    try {
      const pool = db();
      await ensureTables(pool);

      const b = req.body || {};
      const action = String(b.action || "").toLowerCase();

      if (action === "finish") {
        const d = b.duel || {};
        await pool.query(`INSERT INTO duels_history
          (stamp, date, map, winner_sid, winner_name, loser_sid, loser_name, weapon, weapon_name, amount, currency, donate, rating, armor, result, duration)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
          intOr(d.stamp) || Math.floor(Date.now() / 1e3),
          String(d.date || "").slice(0, 32),
          String(d.map || "").slice(0, 64),
          sid64(d.winner_sid), String(d.winner_name || "").slice(0, 64),
          sid64(d.loser_sid), String(d.loser_name || "").slice(0, 64),
          String(d.weapon || "").slice(0, 64), String(d.weapon_name || "").slice(0, 64),
          intOr(d.amount), d.donate ? "donate" : "money",
          d.donate ? 1 : 0, d.rating ? 1 : 0, d.armor ? 1 : 0,
          d.draw ? "draw" : "win", intOr(d.duration)
        ]);

        if (d.rating && !d.draw) {
          const w = sid64(d.winner_sid), l = sid64(d.loser_sid);
          const wep = String(d.weapon || "").slice(0, 64);

          if (w) {
            await pool.query(`INSERT INTO duels_stats (steamid, name, wins, losses) VALUES (?,?,1,0)
              ON DUPLICATE KEY UPDATE wins = wins + 1, name = VALUES(name)`, [ w, String(d.winner_name || "").slice(0, 64) ]);
            if (wep) await pool.query(`INSERT INTO duels_weapons (steamid, weapon, uses) VALUES (?,?,1)
              ON DUPLICATE KEY UPDATE uses = uses + 1`, [ w, wep ]);
          }
          if (l) {
            await pool.query(`INSERT INTO duels_stats (steamid, name, wins, losses) VALUES (?,?,0,1)
              ON DUPLICATE KEY UPDATE losses = losses + 1, name = VALUES(name)`, [ l, String(d.loser_name || "").slice(0, 64) ]);
            if (wep) await pool.query(`INSERT INTO duels_weapons (steamid, weapon, uses) VALUES (?,?,1)
              ON DUPLICATE KEY UPDATE uses = uses + 1`, [ l, wep ]);
          }
          for (const sid of [ w, l ]) {
            if (!sid) continue;
            await pool.query(`UPDATE duels_stats SET favourite = COALESCE((
              SELECT weapon FROM (SELECT weapon FROM duels_weapons WHERE steamid = ? ORDER BY uses DESC LIMIT 1) t
            ), '') WHERE steamid = ?`, [ sid, sid ]);
          }
        }
        return res.json({ ok: true });
      }

      if (action === "state") {
        const map = String(b.map || "").slice(0, 64);
        const now = Math.floor(Date.now() / 1e3);

        await pool.query("DELETE FROM duels_active WHERE map = ?", [ map ]);
        for (const x of Array.isArray(b.active) ? b.active : []) {
          await pool.query(`INSERT INTO duels_active
            (lobby_id, map, arena_id, arena_name, owner_sid, owner_name, target_sid, target_name, weapon, weapon_name, amount, donate, rating, armor, started, start_stamp, end_stamp, updated)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
            intOr(x.lobby_id), map, intOr(x.arena_id), String(x.arena_name || "").slice(0, 64),
            sid64(x.owner_sid), String(x.owner_name || "").slice(0, 64),
            sid64(x.target_sid), String(x.target_name || "").slice(0, 64),
            String(x.weapon || "").slice(0, 64), String(x.weapon_name || "").slice(0, 64),
            intOr(x.amount), x.donate ? 1 : 0, x.rating ? 1 : 0, x.armor ? 1 : 0,
            x.started ? 1 : 0, intOr(x.start_stamp), intOr(x.end_stamp), now
          ]);
        }

        if (Array.isArray(b.arenas)) {
          await pool.query("DELETE FROM duels_arenas WHERE map = ?", [ map ]);
          for (const a of b.arenas) {
            await pool.query(`INSERT INTO duels_arenas (id, map, name, in_use) VALUES (?,?,?,?)
              ON DUPLICATE KEY UPDATE map = VALUES(map), name = VALUES(name), in_use = VALUES(in_use)`, [
              intOr(a.id) || null, map, String(a.name || "").slice(0, 64), a.busy ? 1 : 0
            ]);
          }
        }
        return res.json({ ok: true });
      }

      return res.status(400).json({ ok: false, error: "BAD_ACTION" });
    } catch (e) {
      console.error("duels_sync:", e.message);
      res.status(500).json({ ok: false, error: "DB_ERROR" });
    }
  });

  r.get("/api/tech_duels/overview", authGuard, requirePerm("view_money_logs"), async (req, res) => {
    try {
      const pool = db();
      await ensureTables(pool);

      const [[totals]] = await pool.query(`SELECT
        COUNT(*) AS players,
        COALESCE(SUM(wins),0) AS wins,
        COALESCE(SUM(losses),0) AS losses
        FROM duels_stats`);

      const [[hist]] = await pool.query(`SELECT
        COUNT(*) AS duels,
        COALESCE(SUM(CASE WHEN donate = 1 THEN amount ELSE 0 END),0) AS donate_sum,
        COALESCE(SUM(CASE WHEN donate = 0 THEN amount ELSE 0 END),0) AS money_sum,
        COALESCE(SUM(CASE WHEN result = 'draw' THEN 1 ELSE 0 END),0) AS draws,
        COALESCE(AVG(NULLIF(duration,0)),0) AS avg_duration
        FROM duels_history`);

      const [[today]] = await pool.query(`SELECT COUNT(*) AS c FROM duels_history
        WHERE stamp >= UNIX_TIMESTAMP(CURDATE())`);

      const [top] = await pool.query(`SELECT steamid, name, wins, losses, favourite
        FROM duels_stats WHERE wins > 0 ORDER BY wins DESC, losses ASC LIMIT 15`);

      const [weapons] = await pool.query(`SELECT weapon, SUM(uses) AS uses
        FROM duels_weapons GROUP BY weapon ORDER BY uses DESC LIMIT 10`);

      const [arenas] = await pool.query(`SELECT id, map, name, in_use, busy_until FROM duels_arenas ORDER BY map ASC, id ASC`);

      const [active] = await pool.query(`SELECT * FROM duels_active ORDER BY started DESC, id DESC LIMIT 50`);

      res.json({
        ok: true,
        totals: {
          players: intOr(totals?.players),
          wins: intOr(totals?.wins),
          losses: intOr(totals?.losses),
          duels: intOr(hist?.duels),
          draws: intOr(hist?.draws),
          donate_sum: intOr(hist?.donate_sum),
          money_sum: intOr(hist?.money_sum),
          avg_duration: Math.round(Number(hist?.avg_duration || 0)),
          today: intOr(today?.c)
        },
        top: top.map((x, i) => ({
          place: i + 1,
          steamid64: String(x.steamid || ""),
          name: nick(x.name),
          wins: intOr(x.wins),
          losses: intOr(x.losses),
          winrate: pct(intOr(x.wins), intOr(x.losses)),
          favourite: decodeIfNeeded(x.favourite || "")
        })),
        weapons: weapons.map(x => ({
          weapon: String(x.weapon || ""),
          uses: intOr(x.uses)
        })),
        arenas: arenas.map(x => ({
          id: x.id,
          map: String(x.map || ""),
          name: nick(x.name),
          busy: intOr(x.in_use) === 1
        })),
        active: active.map(x => ({
          id: x.id,
          lobby_id: intOr(x.lobby_id),
          map: String(x.map || ""),
          arena_name: nick(x.arena_name),
          owner_steamid64: String(x.owner_sid || ""),
          owner_name: nick(x.owner_name),
          target_steamid64: String(x.target_sid || ""),
          target_name: nick(x.target_name),
          weapon_name: decodeIfNeeded(x.weapon_name || x.weapon || ""),
          amount: intOr(x.amount),
          donate: intOr(x.donate) === 1,
          rating: intOr(x.rating) === 1,
          armor: intOr(x.armor) === 1,
          started: intOr(x.started) === 1,
          end_stamp: intOr(x.end_stamp)
        }))
      });
    } catch (e) {
      console.error("tech_duels overview:", e.message);
      res.status(500).json({ ok: false, error: "DB_ERROR" });
    }
  });

  r.get("/api/tech_duels/players", authGuard, requirePerm("view_money_logs"), async (req, res) => {
    try {
      const pool = db();
      await ensureTables(pool);

      const q = String(req.query.q || "").trim();
      const limit = Math.min(Math.max(intOr(req.query.limit, 100), 1), 500);

      let sql = `SELECT steamid, name, wins, losses, favourite FROM duels_stats`;
      const args = [];

      if (q) {
        sql += ` WHERE name LIKE ? OR steamid LIKE ?`;
        args.push(`%${q}%`, `%${q}%`);
      }

      sql += ` ORDER BY wins DESC, losses ASC LIMIT ${limit}`;

      const [rows] = await pool.query(sql, args);

      res.json({
        ok: true,
        total: rows.length,
        items: rows.map(x => ({
          steamid64: String(x.steamid || ""),
          name: nick(x.name),
          wins: intOr(x.wins),
          losses: intOr(x.losses),
          total: intOr(x.wins) + intOr(x.losses),
          winrate: pct(intOr(x.wins), intOr(x.losses)),
          favourite: decodeIfNeeded(x.favourite || "")
        }))
      });
    } catch (e) {
      console.error("tech_duels players:", e.message);
      res.status(500).json({ ok: false, error: "DB_ERROR" });
    }
  });

  r.get("/api/tech_duels/logs", authGuard, requirePerm("view_money_logs"), async (req, res) => {
    try {
      const pool = db();
      await ensureTables(pool);

      const q = String(req.query.q || "").trim();
      const currency = String(req.query.currency || "all").toLowerCase();
      const mode = String(req.query.mode || "all").toLowerCase();
      const limit = Math.min(Math.max(intOr(req.query.limit, 200), 1), 1000);

      const where = [];
      const args = [];

      if (q) {
        where.push(`(winner_name LIKE ? OR loser_name LIKE ? OR winner_sid LIKE ? OR loser_sid LIKE ? OR weapon_name LIKE ? OR weapon LIKE ?)`);
        args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
      }

      if (currency === "donate") where.push(`donate = 1`);
      else if (currency === "money") where.push(`donate = 0`);

      if (mode === "rating") where.push(`rating = 1`);
      else if (mode === "casual") where.push(`rating = 0`);
      else if (mode === "draw") where.push(`result = 'draw'`);

      const sql = `SELECT * FROM duels_history
        ${where.length ? "WHERE " + where.join(" AND ") : ""}
        ORDER BY id DESC LIMIT ${limit}`;

      const [rows] = await pool.query(sql, args);

      res.json({
        ok: true,
        total: rows.length,
        items: rows.map(x => ({
          id: x.id,
          stamp: intOr(x.stamp),
          date: String(x.date || ""),
          map: String(x.map || ""),
          winner_steamid64: String(x.winner_sid || ""),
          winner_name: nick(x.winner_name),
          loser_steamid64: String(x.loser_sid || ""),
          loser_name: nick(x.loser_name),
          weapon: String(x.weapon || ""),
          weapon_name: decodeIfNeeded(x.weapon_name || x.weapon || ""),
          amount: intOr(x.amount),
          donate: intOr(x.donate) === 1,
          rating: intOr(x.rating) === 1,
          armor: intOr(x.armor) === 1,
          draw: String(x.result || "") === "draw",
          duration: intOr(x.duration)
        }))
      });
    } catch (e) {
      console.error("tech_duels logs:", e.message);
      res.status(500).json({ ok: false, error: "DB_ERROR" });
    }
  });

  r.get("/api/tech_duels/player", authGuard, requirePerm("view_money_logs"), async (req, res) => {
    try {
      const pool = db();
      await ensureTables(pool);

      const sid = sid64(req.query.steamid64);
      if (!sid) return res.status(400).json({ ok: false, error: "BAD_STEAMID" });

      const [[st]] = await pool.query("SELECT steamid, name, wins, losses, favourite FROM duels_stats WHERE steamid = ? LIMIT 1", [ sid ]);

      const [weapons] = await pool.query("SELECT weapon, uses FROM duels_weapons WHERE steamid = ? ORDER BY uses DESC LIMIT 20", [ sid ]);

      const [history] = await pool.query(`SELECT * FROM duels_history
        WHERE winner_sid = ? OR loser_sid = ? ORDER BY id DESC LIMIT 100`, [ sid, sid ]);

      const [[sums]] = await pool.query(`SELECT
        COALESCE(SUM(CASE WHEN winner_sid = ? AND donate = 1 THEN amount ELSE 0 END),0) AS won_donate,
        COALESCE(SUM(CASE WHEN winner_sid = ? AND donate = 0 THEN amount ELSE 0 END),0) AS won_money,
        COALESCE(SUM(CASE WHEN loser_sid = ? AND donate = 1 THEN amount ELSE 0 END),0) AS lost_donate,
        COALESCE(SUM(CASE WHEN loser_sid = ? AND donate = 0 THEN amount ELSE 0 END),0) AS lost_money
        FROM duels_history WHERE winner_sid = ? OR loser_sid = ?`, [ sid, sid, sid, sid, sid, sid ]);

      const wins = intOr(st?.wins);
      const losses = intOr(st?.losses);

      res.json({
        ok: true,
        player: {
          steamid64: sid,
          name: nick(st?.name),
          wins: wins,
          losses: losses,
          total: wins + losses,
          winrate: pct(wins, losses),
          favourite: decodeIfNeeded(st?.favourite || ""),
          won_donate: intOr(sums?.won_donate),
          won_money: intOr(sums?.won_money),
          lost_donate: intOr(sums?.lost_donate),
          lost_money: intOr(sums?.lost_money)
        },
        weapons: weapons.map(x => ({
          weapon: String(x.weapon || ""),
          uses: intOr(x.uses)
        })),
        history: history.map(x => ({
          id: x.id,
          date: String(x.date || ""),
          won: String(x.winner_sid || "") === sid,
          draw: String(x.result || "") === "draw",
          opponent_name: String(x.winner_sid || "") === sid ? nick(x.loser_name) : nick(x.winner_name),
          opponent_steamid64: String(x.winner_sid || "") === sid ? String(x.loser_sid || "") : String(x.winner_sid || ""),
          weapon_name: decodeIfNeeded(x.weapon_name || x.weapon || ""),
          amount: intOr(x.amount),
          donate: intOr(x.donate) === 1,
          rating: intOr(x.rating) === 1,
          duration: intOr(x.duration)
        }))
      });
    } catch (e) {
      console.error("tech_duels player:", e.message);
      res.status(500).json({ ok: false, error: "DB_ERROR" });
    }
  });

  r.post("/api/tech_duels/reset", authGuard, requirePerm("view_money_logs"), async (req, res) => {
    try {
      const pool = db();
      await ensureTables(pool);

      const b = req.body || {};
      const scope = String(b.scope || "").toLowerCase();
      const admin = req.session?.user?.steamid64 || "";
      const wipeHistory = b.wipe_history === true || b.wipe_history === "1";
      const wipeWeapons = b.wipe_weapons === true || b.wipe_weapons === "1";

      if (scope === "player") {
        const sid = sid64(b.steamid64);
        if (!sid) return res.status(400).json({ ok: false, error: "BAD_STEAMID" });

        await pool.query("UPDATE duels_stats SET wins = 0, losses = 0 WHERE steamid = ?", [ sid ]);

        if (wipeWeapons) {
          await pool.query("DELETE FROM duels_weapons WHERE steamid = ?", [ sid ]);
          await pool.query("UPDATE duels_stats SET favourite = '' WHERE steamid = ?", [ sid ]);
        }

        if (wipeHistory) {
          await pool.query("DELETE FROM duels_history WHERE winner_sid = ? OR loser_sid = ?", [ sid, sid ]);
        }

        await enqueueCommand(`duels_reset_player ${sid} ${wipeWeapons ? 1 : 0}`, admin);

        await logAdminAction(pool, admin, "DUELS_RESET_PLAYER", sid, JSON.stringify({
          wipe_history: wipeHistory,
          wipe_weapons: wipeWeapons
        }));

        return res.json({ ok: true, affected: 1 });
      }

      if (scope === "all") {
        const [[cnt]] = await pool.query("SELECT COUNT(*) AS c FROM duels_stats");

        await pool.query("UPDATE duels_stats SET wins = 0, losses = 0");

        if (wipeWeapons) {
          await pool.query("DELETE FROM duels_weapons");
          await pool.query("UPDATE duels_stats SET favourite = ''");
        }

        if (wipeHistory) {
          await pool.query("DELETE FROM duels_history");
        }

        await enqueueCommand(`duels_reset_all ${wipeWeapons ? 1 : 0}`, admin);

        await logAdminAction(pool, admin, "DUELS_RESET_ALL", "*", JSON.stringify({
          players: intOr(cnt?.c),
          wipe_history: wipeHistory,
          wipe_weapons: wipeWeapons
        }));

        return res.json({ ok: true, affected: intOr(cnt?.c) });
      }

      return res.status(400).json({ ok: false, error: "BAD_SCOPE" });
    } catch (e) {
      console.error("tech_duels reset:", e.message);
      res.status(500).json({ ok: false, error: "DB_ERROR" });
    }
  });

  return r;
}

export { techDuelsRoutes as default };
