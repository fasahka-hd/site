import { Router } from "express";

import { timingSafeEqual } from "crypto";

import { db } from "../lib/db.js";

import { authGuard } from "../lib/guard.js";

import { steamid64ToSteamid, decodeIfNeeded, stripPort } from "../lib/helpers.js";

import { ensurePromoTables, isExpired, normalizeCode } from "./promos.js";

let _syncAccessTableEnsured = false;

async function ensureAccessTableSync() {
  if (_syncAccessTableEnsured) return;
  try {
    await db().query(`CREATE TABLE IF NOT EXISTS panel_player_access (\n      steamid32 VARCHAR(32) NOT NULL,\n      props_extra INT UNSIGNED NOT NULL DEFAULT 0,\n      setmodel TINYINT(1) NOT NULL DEFAULT 0,\n      issued_by VARCHAR(64) NOT NULL DEFAULT '',\n      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,\n      PRIMARY KEY (steamid32)\n    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    _syncAccessTableEnsured = true;
  } catch (e) {
    console.error("ensureAccessTableSync failed:", e.message);
  }
}

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

function serverSyncRoutes(cfg) {
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
  r.all("/api/chsp_sync", async (req, res) => {
    if (!requirePassword(req, res)) return;
    try {
      const pool = db();
      const params = req.body && Object.keys(req.body).length ? req.body : req.query;
      const action = String(params.action || "list").trim();
      if (action === "list") {
        const [players] = await pool.query("SELECT steamid64, steamid, nickname, ip, reason, added_by, active, added_at, updated_at FROM chsp_list");
        players.forEach(p => {
          p.ip = stripPort(p.ip || "");
        });
        const [ips] = await pool.query("SELECT ip, reason, added_by, active, added_at FROM chsp_ip_list");
        ips.forEach(i => {
          i.ip = stripPort(i.ip || "");
        });
        return res.json({
          ok: true,
          players: players,
          ips: ips
        });
      }
      if (action === "upsert_player") {
        const sid64 = String(params.steamid64 || "").trim();
        if (!sid64 || !/^\d{17}$/.test(sid64)) return res.status(400).json({
          ok: false,
          error: "BAD_STEAMID64"
        });
        const steamid = String(params.steamid || "").trim() || steamid64ToSteamid(sid64);
        const nickname = String(params.nickname || "").trim();
        const ip = stripPort(params.ip || "");
        const reason = String(params.reason || "").trim();
        const addedBy = String(params.added_by || "Server").trim();
        const active = params.active ? 1 : 0;
        await pool.query(`INSERT INTO chsp_list (steamid64, steamid, nickname, ip, reason, added_by, active)\n           VALUES (?, ?, ?, ?, ?, ?, ?)\n           ON DUPLICATE KEY UPDATE steamid=VALUES(steamid), nickname=VALUES(nickname), ip=VALUES(ip),\n           reason=VALUES(reason), added_by=VALUES(added_by), active=VALUES(active), updated_at=CURRENT_TIMESTAMP`, [ sid64, steamid, nickname, ip, reason, addedBy, active ]);
        if (ip && active) {
          await pool.query(`INSERT INTO chsp_ip_list (ip, reason, added_by, active) VALUES (?, ?, ?, 1)\n             ON DUPLICATE KEY UPDATE reason=VALUES(reason), added_by=VALUES(added_by), active=1`, [ ip, reason, addedBy ]).catch(() => {});
        }
        return res.json({
          ok: true
        });
      }
      if (action === "delete_player") {
        const sid64 = String(params.steamid64 || "").trim();
        if (!sid64 || !/^\d{17}$/.test(sid64)) return res.status(400).json({
          ok: false,
          error: "BAD_STEAMID64"
        });
        await pool.query("DELETE FROM chsp_list WHERE steamid64 = ? LIMIT 1", [ sid64 ]);
        return res.json({
          ok: true
        });
      }
      if (action === "upsert_ip") {
        const ip = stripPort(params.ip || "");
        if (!ip) return res.status(400).json({
          ok: false,
          error: "NO_IP"
        });
        const reason = String(params.reason || "").trim();
        const addedBy = String(params.added_by || "Server").trim();
        const active = params.active ? 1 : 0;
        await pool.query(`INSERT INTO chsp_ip_list (ip, reason, added_by, active) VALUES (?, ?, ?, ?)\n           ON DUPLICATE KEY UPDATE reason=VALUES(reason), added_by=VALUES(added_by), active=VALUES(active)`, [ ip, reason, addedBy, active ]);
        return res.json({
          ok: true
        });
      }
      if (action === "delete_ip") {
        const ip = stripPort(params.ip || "");
        if (!ip) return res.status(400).json({
          ok: false,
          error: "NO_IP"
        });
        await pool.query("DELETE FROM chsp_ip_list WHERE ip = ? LIMIT 1", [ ip ]);
        return res.json({
          ok: true
        });
      }
      res.status(400).json({
        ok: false,
        error: "UNKNOWN_ACTION"
      });
    } catch (e) {
      console.error("chsp_sync error:", e.message);
      res.status(500).json({
        ok: false,
        error: "DB_ERROR"
      });
    }
  });
  r.all("/api/models_sync", async (req, res) => {
    if (!requirePassword(req, res)) return;
    try {
      const pool = db();
      const params = req.body && Object.keys(req.body).length ? req.body : req.query;
      const action = String(params.action || "list_player_models").trim();
      if (action === "list_player_models") {
        const steamid32 = String(params.steamid32 || "").trim();
        if (!steamid32) return res.json({
          ok: true,
          items: []
        });
        const [rows] = await pool.query(`SELECT m.id, m.model_path, m.name AS title, m.workshop_id, m.size_bytes,\n           pm.issued_by, UNIX_TIMESTAMP(pm.issued_at) AS issued_at\n           FROM panel_player_models pm JOIN panel_models m ON m.id = pm.model_id\n           WHERE pm.steamid32 = ? ORDER BY pm.issued_at DESC`, [ steamid32 ]);
        const items = rows.map(r2 => ({
          id: r2.id,
          model_path: String(r2.model_path),
          title: decodeIfNeeded(r2.title || ""),
          workshop_id: String(r2.workshop_id || ""),
          size_bytes: r2.size_bytes != null ? Number(r2.size_bytes) : null,
          issued_by: decodeIfNeeded(r2.issued_by || ""),
          issued_at: parseInt(r2.issued_at || 0, 10)
        }));
        return res.json({
          ok: true,
          items: items
        });
      }
      if (action === "has_model") {
        const steamid32 = String(params.steamid32 || "").trim();
        const modelPath = String(params.model_path || "").trim();
        if (!steamid32 || !modelPath) return res.status(400).json({
          ok: false,
          error: "BAD_PARAMS"
        });
        const [rows] = await pool.query("SELECT 1 FROM panel_player_models pm JOIN panel_models m ON m.id=pm.model_id WHERE pm.steamid32=? AND m.model_path=? LIMIT 1", [ steamid32, modelPath ]);
        return res.json({
          ok: true,
          has: rows.length > 0
        });
      }
      if (action === "grant_model") {
        const steamid32 = String(params.steamid32 || "").trim();
        const modelPath = String(params.model_path || "").trim();
        const title = String(params.title || "").trim() || modelPath;
        const workshopId = String(params.workshop_id || "").trim();
        const by = String(params.by || "Server").trim();
        if (!steamid32 || !modelPath) return res.status(400).json({
          ok: false,
          error: "BAD_PARAMS"
        });
        await pool.query("INSERT INTO panel_models (name, model_path, workshop_id) VALUES (?, ?, NULLIF(?,'')) ON DUPLICATE KEY UPDATE name=VALUES(name), workshop_id=VALUES(workshop_id)", [ title, modelPath, workshopId ]);
        const [[modelRow]] = await pool.query("SELECT id FROM panel_models WHERE model_path = ? LIMIT 1", [ modelPath ]);
        if (!modelRow) return res.status(500).json({
          ok: false,
          error: "MODEL_ID"
        });
        await pool.query("INSERT IGNORE INTO panel_player_models (steamid32, model_id, issued_by) VALUES (?,?,?)", [ steamid32, modelRow.id, by ]);
        return res.json({
          ok: true
        });
      }
      if (action === "revoke_model") {
        const steamid32 = String(params.steamid32 || "").trim();
        const modelPath = String(params.model_path || "").trim();
        if (!steamid32 || !modelPath) return res.status(400).json({
          ok: false,
          error: "BAD_PARAMS"
        });
        const [[modelRow]] = await pool.query("SELECT id FROM panel_models WHERE model_path = ? LIMIT 1", [ modelPath ]);
        if (modelRow) {
          await pool.query("DELETE FROM panel_player_models WHERE steamid32=? AND model_id=? LIMIT 1", [ steamid32, modelRow.id ]);
        }
        return res.json({
          ok: true
        });
      }
      res.status(400).json({
        ok: false,
        error: "UNKNOWN_ACTION"
      });
    } catch (e) {
      console.error("models_sync error:", e.message);
      res.status(500).json({
        ok: false,
        error: "DB_ERROR"
      });
    }
  });
  r.all("/api/weapons_sync", async (req, res) => {
    if (!requirePassword(req, res)) return;
    try {
      const pool = db();
      const params = req.body && Object.keys(req.body).length ? req.body : req.query;
      const action = String(params.action || "list_player_weapons").trim();
      if (action === "list_player_weapons") {
        const steamid32 = String(params.steamid32 || "").trim();
        if (!steamid32) return res.json({
          ok: true,
          items: []
        });
        const [rows] = await pool.query(`SELECT w.id, w.weapon_class, w.name AS title, w.workshop_id,\n           pw.issued_by, UNIX_TIMESTAMP(pw.issued_at) AS issued_at\n           FROM panel_player_weapons pw JOIN panel_weapons w ON w.id = pw.weapon_id\n           WHERE pw.steamid32 = ? ORDER BY pw.issued_at DESC`, [ steamid32 ]);
        const items = rows.map(r2 => ({
          id: r2.id,
          weapon_class: String(r2.weapon_class),
          title: decodeIfNeeded(r2.title || ""),
          workshop_id: String(r2.workshop_id || ""),
          issued_by: decodeIfNeeded(r2.issued_by || ""),
          issued_at: parseInt(r2.issued_at || 0, 10)
        }));
        return res.json({
          ok: true,
          items: items
        });
      }
      if (action === "has_weapon") {
        const steamid32 = String(params.steamid32 || "").trim();
        const weaponClass = String(params.weapon_class || "").trim();
        if (!steamid32 || !weaponClass) return res.status(400).json({
          ok: false,
          error: "BAD_PARAMS"
        });
        const [rows] = await pool.query("SELECT 1 FROM panel_player_weapons pw JOIN panel_weapons w ON w.id=pw.weapon_id WHERE pw.steamid32=? AND w.weapon_class=? LIMIT 1", [ steamid32, weaponClass ]);
        return res.json({
          ok: true,
          has: rows.length > 0
        });
      }
      if (action === "grant_weapon") {
        const steamid32 = String(params.steamid32 || "").trim();
        const weaponClass = String(params.weapon_class || "").trim();
        const title = String(params.title || "").trim() || weaponClass;
        const workshopId = String(params.workshop_id || "").trim();
        const by = String(params.by || "Server").trim();
        if (!steamid32 || !weaponClass) return res.status(400).json({
          ok: false,
          error: "BAD_PARAMS"
        });
        await pool.query("INSERT INTO panel_weapons (name, weapon_class, workshop_id) VALUES (?, ?, NULLIF(?,'')) ON DUPLICATE KEY UPDATE name=VALUES(name), workshop_id=VALUES(workshop_id)", [ title, weaponClass, workshopId ]);
        const [[weaponRow]] = await pool.query("SELECT id FROM panel_weapons WHERE weapon_class = ? LIMIT 1", [ weaponClass ]);
        if (!weaponRow) return res.status(500).json({
          ok: false,
          error: "WEAPON_ID"
        });
        await pool.query("INSERT IGNORE INTO panel_player_weapons (steamid32, weapon_id, issued_by) VALUES (?,?,?)", [ steamid32, weaponRow.id, by ]);
        return res.json({
          ok: true
        });
      }
      if (action === "revoke_weapon") {
        const steamid32 = String(params.steamid32 || "").trim();
        const weaponClass = String(params.weapon_class || "").trim();
        if (!steamid32 || !weaponClass) return res.status(400).json({
          ok: false,
          error: "BAD_PARAMS"
        });
        const [[weaponRow]] = await pool.query("SELECT id FROM panel_weapons WHERE weapon_class = ? LIMIT 1", [ weaponClass ]);
        if (weaponRow) {
          await pool.query("DELETE FROM panel_player_weapons WHERE steamid32=? AND weapon_id=? LIMIT 1", [ steamid32, weaponRow.id ]);
        }
        return res.json({
          ok: true
        });
      }
      res.status(400).json({
        ok: false,
        error: "UNKNOWN_ACTION"
      });
    } catch (e) {
      console.error("weapons_sync error:", e.message);
      res.status(500).json({
        ok: false,
        error: "DB_ERROR"
      });
    }
  });
  r.get("/api/get_steamid", authGuard, async (req, res) => {
    const name = String(req.query.name || "").trim();
    if (!name) return res.status(400).json({
      ok: false,
      error: "EMPTY_NAME"
    });
    try {
      const pool = db();
      const [r1] = await pool.query("SELECT steamid FROM ba_bans WHERE name = ? ORDER BY ban_time DESC LIMIT 1", [ name ]);
      if (r1[0]) return res.json({
        ok: true,
        steamid: r1[0].steamid,
        name: name
      });
      const [r2] = await pool.query("SELECT steamid FROM ba_users WHERE name = ? LIMIT 1", [ name ]);
      if (r2[0]) return res.json({
        ok: true,
        steamid: r2[0].steamid,
        name: name
      });
      return res.status(404).json({
        ok: false,
        error: "PLAYER_NOT_FOUND"
      });
    } catch (e) {
      console.error("get_steamid error:", e.message);
      res.status(500).json({
        ok: false,
        error: "DB_ERROR"
      });
    }
  });
  r.all("/api/jobs_sync", async (req, res) => {
    if (!requirePassword(req, res)) return;
    try {
      const pool = db();
      const params = req.body && Object.keys(req.body).length ? req.body : req.query;
      const action = String(params.action || "list_player_jobs").trim();
      if (action === "list_player_jobs") {
        const steamid32 = String(params.steamid32 || "").trim();
        if (!steamid32) return res.json({
          ok: true,
          items: []
        });
        const [rows] = await pool.query(`SELECT j.id, j.job_command, j.name AS title,\n           pj.given_by, UNIX_TIMESTAMP(pj.given_at) AS given_at\n           FROM panel_player_jobs pj JOIN panel_jobs j ON j.id = pj.job_id\n           WHERE pj.steamid32 = ? ORDER BY pj.given_at DESC`, [ steamid32 ]);
        const items = rows.map(r2 => ({
          id: r2.id,
          job_command: String(r2.job_command),
          title: decodeIfNeeded(r2.title || ""),
          given_by: decodeIfNeeded(r2.given_by || ""),
          given_at: parseInt(r2.given_at || 0, 10)
        }));
        return res.json({
          ok: true,
          items: items
        });
      }
      if (action === "has_job") {
        const steamid32 = String(params.steamid32 || "").trim();
        const jobCommand = String(params.job_command || "").trim();
        if (!steamid32 || !jobCommand) return res.status(400).json({
          ok: false,
          error: "BAD_PARAMS"
        });
        const [rows] = await pool.query("SELECT 1 FROM panel_player_jobs pj JOIN panel_jobs j ON j.id=pj.job_id WHERE pj.steamid32=? AND j.job_command=? LIMIT 1", [ steamid32, jobCommand ]);
        return res.json({
          ok: true,
          has: rows.length > 0
        });
      }
      if (action === "grant_job") {
        const steamid32 = String(params.steamid32 || "").trim();
        const jobCommand = String(params.job_command || "").trim();
        const title = String(params.title || "").trim() || jobCommand;
        const by = String(params.by || "Server").trim();
        if (!steamid32 || !jobCommand) return res.status(400).json({
          ok: false,
          error: "BAD_PARAMS"
        });
        await pool.query("INSERT INTO panel_jobs (name, job_command) VALUES (?, ?) ON DUPLICATE KEY UPDATE name=VALUES(name)", [ title, jobCommand ]);
        const [[jobRow]] = await pool.query("SELECT id FROM panel_jobs WHERE job_command = ? LIMIT 1", [ jobCommand ]);
        if (!jobRow) return res.status(500).json({
          ok: false,
          error: "JOB_ID"
        });
        await pool.query("INSERT IGNORE INTO panel_player_jobs (steamid32, job_id, given_by) VALUES (?,?,?)", [ steamid32, jobRow.id, by ]);
        return res.json({
          ok: true
        });
      }
      if (action === "revoke_job") {
        const steamid32 = String(params.steamid32 || "").trim();
        const jobCommand = String(params.job_command || "").trim();
        if (!steamid32 || !jobCommand) return res.status(400).json({
          ok: false,
          error: "BAD_PARAMS"
        });
        const [[jobRow]] = await pool.query("SELECT id FROM panel_jobs WHERE job_command = ? LIMIT 1", [ jobCommand ]);
        if (jobRow) {
          await pool.query("DELETE FROM panel_player_jobs WHERE steamid32=? AND job_id=? LIMIT 1", [ steamid32, jobRow.id ]);
        }
        return res.json({
          ok: true
        });
      }
      res.status(400).json({
        ok: false,
        error: "UNKNOWN_ACTION"
      });
    } catch (e) {
      console.error("jobs_sync error:", e.message);
      res.status(500).json({
        ok: false,
        error: "DB_ERROR"
      });
    }
  });
  r.all("/api/player_access_sync", async (req, res) => {
    if (!requirePassword(req, res)) return;
    try {
      await ensureAccessTableSync();
      const pool = db();
      const params = req.body && Object.keys(req.body).length ? req.body : req.query;
      const action = String(params.action || "get").trim();
      if (action === "get") {
        const steamid32 = String(params.steamid32 || "").trim();
        if (!steamid32) return res.json({
          ok: true,
          item: {
            props_extra: 0,
            setmodel: 0
          }
        });
        const [rows] = await pool.query("SELECT props_extra, setmodel FROM panel_player_access WHERE steamid32 = ? LIMIT 1", [ steamid32 ]);
        const row = rows[0] || {};
        return res.json({
          ok: true,
          item: {
            props_extra: parseInt(row.props_extra || 0, 10),
            setmodel: row.setmodel ? 1 : 0
          }
        });
      }
      res.status(400).json({
        ok: false,
        error: "UNKNOWN_ACTION"
      });
    } catch (e) {
      console.error("player_access_sync error:", e.message);
      res.status(500).json({
        ok: false,
        error: "DB_ERROR"
      });
    }
  });
  r.all("/api/promos_sync", async (req, res) => {
    if (!requirePassword(req, res)) return;
    try {
      await ensurePromoTables();
      const pool = db();
      const params = req.body && Object.keys(req.body).length ? req.body : req.query;
      const action = String(params.action || "list").trim();
      if (action === "list") {
        const [rows] = await pool.query(`SELECT\n             p.id, p.code, p.donate, p.money, p.max_uses, p.expiration_date, p.is_active,\n             COUNT(pu.id) AS used_count\n           FROM panel_promocodes p\n           LEFT JOIN panel_promo_usage pu ON pu.promo_id = p.id\n           WHERE p.is_active = 1\n             AND (p.expiration_date IS NULL OR p.expiration_date = '' OR p.expiration_date >= DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s'))\n           GROUP BY p.id, p.code, p.donate, p.money, p.max_uses, p.expiration_date, p.is_active\n           HAVING (p.max_uses = 0 OR used_count < p.max_uses)\n           ORDER BY p.created_at DESC, p.id DESC`);
        return res.json({
          ok: true,
          items: rows
        });
      }
      if (action === "check") {
        const code = normalizeCode(params.code);
        if (!code) return res.status(400).json({
          ok: false,
          error: "BAD_CODE"
        });
        const [rows] = await pool.query(`SELECT p.*, COUNT(pu.id) AS used_count\n           FROM panel_promocodes p\n           LEFT JOIN panel_promo_usage pu ON pu.promo_id = p.id\n           WHERE p.code = ?\n           GROUP BY p.id, p.code, p.donate, p.money, p.max_uses, p.expiration_date, p.is_active,\n             p.created_by, p.created_at, p.updated_at\n           LIMIT 1`, [ code ]);
        const promo = rows[0];
        if (!promo) return res.json({
          ok: true,
          valid: false,
          error: "NOT_FOUND"
        });
        if (!promo.is_active) return res.json({
          ok: true,
          valid: false,
          error: "INACTIVE",
          item: promo
        });
        if (isExpired(promo.expiration_date)) return res.json({
          ok: true,
          valid: false,
          error: "EXPIRED",
          item: promo
        });
        if (promo.max_uses > 0 && Number(promo.used_count || 0) >= Number(promo.max_uses)) {
          return res.json({
            ok: true,
            valid: false,
            error: "LIMIT_REACHED",
            item: promo
          });
        }
        return res.json({
          ok: true,
          valid: true,
          item: promo
        });
      }
      if (action === "has_used") {
        const promoId = parseInt(params.promo_id || 0, 10);
        const steamid64 = String(params.steamid64 || "").trim();
        if (!promoId || !steamid64) return res.json({
          ok: true,
          used: false
        });
        const [rows] = await pool.query("SELECT 1 FROM panel_promo_usage WHERE promo_id=? AND steamid64=? LIMIT 1", [ promoId, steamid64 ]);
        return res.json({
          ok: true,
          used: rows.length > 0
        });
      }
      if (action === "record_use") {
        const promoIdRaw = parseInt(params.promo_id || 0, 10);
        const code = normalizeCode(params.code);
        const steamid64 = String(params.steamid64 || "").trim();
        const steamid32 = String(params.steamid32 || "").trim().slice(0, 32);
        const nickname = String(params.nickname || "").trim().slice(0, 64);
        if (!promoIdRaw && !code || !steamid64) return res.status(400).json({
          ok: false,
          error: "BAD_PARAMS"
        });
        const conn = await pool.getConnection();
        try {
          await conn.beginTransaction();
          const [promos] = await conn.query(`SELECT * FROM panel_promocodes WHERE ${promoIdRaw ? "id = ?" : "code = ?"} LIMIT 1 FOR UPDATE`, [ promoIdRaw || code ]);
          const promo = promos[0];
          if (!promo) {
            await conn.rollback();
            return res.json({
              ok: true,
              recorded: false,
              error: "NOT_FOUND"
            });
          }
          if (!promo.is_active) {
            await conn.rollback();
            return res.json({
              ok: true,
              recorded: false,
              error: "INACTIVE",
              promo_id: promo.id
            });
          }
          if (isExpired(promo.expiration_date)) {
            await conn.rollback();
            return res.json({
              ok: true,
              recorded: false,
              error: "EXPIRED",
              promo_id: promo.id
            });
          }
          const [already] = await conn.query("SELECT 1 FROM panel_promo_usage WHERE promo_id=? AND steamid64=? LIMIT 1", [ promo.id, steamid64 ]);
          if (already.length) {
            await conn.rollback();
            return res.json({
              ok: true,
              recorded: false,
              error: "ALREADY_USED",
              promo_id: promo.id
            });
          }
          if (promo.max_uses > 0) {
            const [cntRows] = await conn.query("SELECT COUNT(*) AS cnt FROM panel_promo_usage WHERE promo_id=?", [ promo.id ]);
            if (Number(cntRows[0]?.cnt || 0) >= Number(promo.max_uses)) {
              await conn.rollback();
              return res.json({
                ok: true,
                recorded: false,
                error: "LIMIT_REACHED",
                promo_id: promo.id
              });
            }
          }
          await conn.query("INSERT INTO panel_promo_usage (promo_id, steamid64, steamid32, nickname) VALUES (?,?,?,?)", [ promo.id, steamid64, steamid32 || null, nickname || null ]);
          await conn.commit();
          return res.json({
            ok: true,
            recorded: true,
            promo_id: promo.id,
            code: promo.code,
            reward: {
              donate: Number(promo.donate || 0),
              money: Number(promo.money || 0)
            }
          });
        } catch (e) {
          await conn.rollback().catch(() => {});
          throw e;
        } finally {
          conn.release();
        }
      }
      if (action === "get_usage_count") {
        const promoId = parseInt(params.promo_id || 0, 10);
        if (!promoId) return res.json({
          ok: true,
          count: 0
        });
        const [rows] = await pool.query("SELECT COUNT(*) AS cnt FROM panel_promo_usage WHERE promo_id=?", [ promoId ]);
        return res.json({
          ok: true,
          count: Number(rows[0]?.cnt || 0)
        });
      }
      res.status(400).json({
        ok: false,
        error: "UNKNOWN_ACTION"
      });
    } catch (e) {
      console.error("promos_sync error:", e.message);
      res.status(500).json({
        ok: false,
        error: "DB_ERROR"
      });
    }
  });
  r.all("/api/qmenu_sync", async (req, res) => {
    if (!requirePassword(req, res)) return;
    try {
      const pool = db();
      const params = req.body && Object.keys(req.body).length ? req.body : req.query;
      const action = String(params.action || "list_player_qmenu").trim();
      if (action === "list_player_qmenu") {
        const steamid32 = String(params.steamid32 || "").trim();
        if (!steamid32) return res.json({
          ok: true,
          items: []
        });
        const [rows] = await pool.query("SELECT access_type, issued_by, UNIX_TIMESTAMP(issued_at) AS issued_at FROM panel_player_qmenu WHERE steamid32 = ?", [ steamid32 ]);
        const items = rows.map(r2 => ({
          access_type: String(r2.access_type),
          issued_by: decodeIfNeeded(r2.issued_by || ""),
          issued_at: parseInt(r2.issued_at || 0, 10)
        }));
        return res.json({
          ok: true,
          items: items
        });
      }
      if (action === "grant_qmenu") {
        const steamid32 = String(params.steamid32 || "").trim();
        const accessType = String(params.access_type || "").trim();
        const by = String(params.by || "Server").trim();
        if (!steamid32 || ![ "qmenu", "qmenuplus" ].includes(accessType)) {
          return res.status(400).json({
            ok: false,
            error: "BAD_PARAMS"
          });
        }
        await pool.query("INSERT IGNORE INTO panel_player_qmenu (steamid32, access_type, issued_by) VALUES (?,?,?)", [ steamid32, accessType, by ]);
        return res.json({
          ok: true
        });
      }
      if (action === "revoke_qmenu") {
        const steamid32 = String(params.steamid32 || "").trim();
        const accessType = String(params.access_type || "").trim();
        if (!steamid32 || ![ "qmenu", "qmenuplus" ].includes(accessType)) {
          return res.status(400).json({
            ok: false,
            error: "BAD_PARAMS"
          });
        }
        await pool.query("DELETE FROM panel_player_qmenu WHERE steamid32=? AND access_type=? LIMIT 1", [ steamid32, accessType ]);
        return res.json({
          ok: true
        });
      }
      res.status(400).json({
        ok: false,
        error: "UNKNOWN_ACTION"
      });
    } catch (e) {
      console.error("qmenu_sync error:", e.message);
      res.status(500).json({
        ok: false,
        error: "DB_ERROR"
      });
    }
  });
  return r;
}

export { serverSyncRoutes as default };
