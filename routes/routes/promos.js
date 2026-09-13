import { Router } from "express";

import { db } from "../lib/db.js";

import { requirePerm } from "../lib/roles.js";

import { authGuard } from "../lib/guard.js";

import { logAdminAction, decodeIfNeeded } from "../lib/helpers.js";

let _promoTablesEnsured = false;

const CODE_RE = /^[A-Z0-9_]{2,64}$/;

function normalizeCode(v) {
  return String(v || "").trim().toUpperCase().replace(/[^A-Z0-9_]/g, "");
}

function clampInt(v, max) {
  return Math.max(0, Math.min(max, parseInt(v || 0, 10) || 0));
}

function normalizeDate(v) {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const s = String(v).trim().replace("T", " ");
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s)) return `${s}:00`;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return s;
  return s.slice(0, 32);
}

function isExpired(expirationDate) {
  if (!expirationDate) return false;
  const d = new Date(String(expirationDate).replace(" ", "T"));
  return !Number.isNaN(d.getTime()) && d.getTime() < Date.now();
}

async function columnExists(table, column) {
  const [rows] = await db().query("SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1", [ table, column ]);
  return rows.length > 0;
}

const VALID_TABLE_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,64}$/;

const VALID_COLUMN_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,64}$/;

function validateSqlIdentifier(name, regex) {
  if (!regex.test(name)) {
    throw new Error(`Invalid SQL identifier: ${name}`);
  }
  return name;
}

async function addColumnIfMissing(table, column, ddl) {
  validateSqlIdentifier(table, VALID_TABLE_RE);
  validateSqlIdentifier(column, VALID_COLUMN_RE);
  if (ddl) {
    const allowedDefs = [ "INT UNSIGNED NOT NULL DEFAULT 0", "VARCHAR(32) DEFAULT NULL", "VARCHAR(64) DEFAULT NULL", "VARCHAR(64) NOT NULL DEFAULT ''", "TINYINT(1) NOT NULL DEFAULT 1" ];
    if (!allowedDefs.includes(ddl)) {
      console.error(`Potentially unsafe DDL rejected: ${ddl}`);
      return;
    }
  }
  if (!await columnExists(table, column)) {
    await db().query(`ALTER TABLE ${validateSqlIdentifier(table, VALID_TABLE_RE)} ADD COLUMN ${validateSqlIdentifier(column, VALID_COLUMN_RE)} ${ddl}`);
  }
}

async function addIndexIfMissing(table, indexName, ddl) {
  validateSqlIdentifier(table, VALID_TABLE_RE);
  validateSqlIdentifier(indexName.replace(/^UNIQUE KEY /i, "").replace(/^KEY /i, ""), VALID_TABLE_RE);
  const [rows] = await db().query("SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1", [ table, indexName.replace(/^UNIQUE KEY /i, "").replace(/^KEY /i, "") ]);
  if (!rows.length) {
    if (!/^(UNIQUE )?KEY\s+\w+\s+\(\w+(,\s*\w+)*\)$/i.test(ddl)) {
      console.error(`Potentially unsafe INDEX DDL rejected: ${ddl}`);
      return;
    }
    await db().query(`ALTER TABLE ${validateSqlIdentifier(table, VALID_TABLE_RE)} ADD ${ddl}`);
  }
}

async function ensurePromoTables() {
  if (_promoTablesEnsured) return;
  await db().query(`CREATE TABLE IF NOT EXISTS panel_promocodes (\n    id INT UNSIGNED NOT NULL AUTO_INCREMENT,\n    code VARCHAR(64) NOT NULL,\n    donate INT UNSIGNED NOT NULL DEFAULT 0,\n    money INT UNSIGNED NOT NULL DEFAULT 0,\n    max_uses INT UNSIGNED NOT NULL DEFAULT 0,\n    expiration_date VARCHAR(32) DEFAULT NULL,\n    is_active TINYINT(1) NOT NULL DEFAULT 1,\n    created_by VARCHAR(64) NOT NULL DEFAULT '',\n    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,\n    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,\n    PRIMARY KEY (id),\n    UNIQUE KEY uq_code (code),\n    KEY idx_active (is_active),\n    KEY idx_expiration (expiration_date)\n  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await db().query(`CREATE TABLE IF NOT EXISTS panel_promo_usage (\n    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,\n    promo_id INT UNSIGNED NOT NULL,\n    steamid64 VARCHAR(20) NOT NULL,\n    steamid32 VARCHAR(32) DEFAULT NULL,\n    nickname VARCHAR(64) DEFAULT NULL,\n    used_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,\n    PRIMARY KEY (id),\n    UNIQUE KEY uq_usage (promo_id, steamid64),\n    KEY idx_promo (promo_id),\n    KEY idx_player (steamid64),\n    KEY idx_used_at (used_at)\n  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await addColumnIfMissing("panel_promocodes", "donate", "INT UNSIGNED NOT NULL DEFAULT 0");
  await addColumnIfMissing("panel_promocodes", "money", "INT UNSIGNED NOT NULL DEFAULT 0");
  await addColumnIfMissing("panel_promocodes", "max_uses", "INT UNSIGNED NOT NULL DEFAULT 0");
  await addColumnIfMissing("panel_promocodes", "expiration_date", "VARCHAR(32) DEFAULT NULL");
  await addColumnIfMissing("panel_promocodes", "is_active", "TINYINT(1) NOT NULL DEFAULT 1");
  await addColumnIfMissing("panel_promocodes", "created_by", "VARCHAR(64) NOT NULL DEFAULT ''");
  await addColumnIfMissing("panel_promo_usage", "steamid32", "VARCHAR(32) DEFAULT NULL");
  await addColumnIfMissing("panel_promo_usage", "nickname", "VARCHAR(64) DEFAULT NULL");
  await addIndexIfMissing("panel_promocodes", "uq_code", "UNIQUE KEY uq_code (code)").catch(() => {});
  await addIndexIfMissing("panel_promo_usage", "uq_usage", "UNIQUE KEY uq_usage (promo_id, steamid64)").catch(() => {});
  _promoTablesEnsured = true;
}

async function safeLog(req, action, target, details = "") {
  try {
    if (req.session?.user) {
      await logAdminAction(db(), req.session.user.steamid64, action, target, details);
    }
  } catch (e) {
    console.error("promo log error:", e.message);
  }
}

function selectListSql(where = "", having = "") {
  return `SELECT\n      p.id, p.code, p.donate, p.money, p.max_uses, p.expiration_date, p.is_active,\n      p.created_by, p.created_at, p.updated_at,\n      COUNT(pu.id) AS used_count\n    FROM panel_promocodes p\n    LEFT JOIN panel_promo_usage pu ON pu.promo_id = p.id\n    ${where}\n    GROUP BY p.id, p.code, p.donate, p.money, p.max_uses, p.expiration_date, p.is_active,\n      p.created_by, p.created_at, p.updated_at\n    ${having}\n    ORDER BY p.created_at DESC, p.id DESC`;
}

function promosRoutes() {
  const r = Router();
  r.get("/api/promos", authGuard, requirePerm("view_promos"), async (req, res) => {
    try {
      await ensurePromoTables();
      const [rows] = await db().query(selectListSql());
      res.json({
        ok: true,
        items: rows
      });
    } catch (e) {
      console.error("promos get error:", e.message);
      res.status(500).json({
        ok: false,
        error: "DB_ERROR"
      });
    }
  });
  r.get("/api/promos/usage", authGuard, requirePerm("view_promos"), async (req, res) => {
    try {
      await ensurePromoTables();
      const promoId = parseInt(req.query.promo_id || 0, 10);
      if (!promoId) return res.json({
        ok: true,
        items: []
      });
      const [rows] = await db().query(`SELECT\n           pu.steamid64, pu.steamid32, pu.nickname, UNIX_TIMESTAMP(pu.used_at) AS used_at,\n           u.name AS current_nickname,\n           (SELECT r.rank FROM ba_ranks r WHERE r.steamid = pu.steamid64 ORDER BY r.expire_time DESC LIMIT 1) AS rank_id\n         FROM panel_promo_usage pu\n         LEFT JOIN ba_users u ON u.steamid = pu.steamid64\n         WHERE pu.promo_id = ?\n         ORDER BY pu.used_at DESC`, [ promoId ]);
      const items = rows.map(r2 => ({
        ...r2,
        nickname: decodeIfNeeded(r2.current_nickname || r2.nickname || "—"),
        used_at: parseInt(r2.used_at || 0, 10)
      }));
      res.json({
        ok: true,
        items: items
      });
    } catch (e) {
      console.error("promos usage error:", e.message);
      res.status(500).json({
        ok: false,
        error: "DB_ERROR"
      });
    }
  });
  r.post("/api/promos", authGuard, requirePerm("manage_promos"), async (req, res) => {
    try {
      await ensurePromoTables();
      const data = req.body || {};
      const action = String(data.action || "").trim();
      const nick = String(req.session.user?.nickname || req.session.user?.role || "Site").slice(0, 64);
      if (action === "create") {
        const code = normalizeCode(data.code);
        if (!CODE_RE.test(code)) return res.status(400).json({
          ok: false,
          error: "BAD_CODE"
        });
        const donate = clampInt(data.donate, 1e6);
        const money = clampInt(data.money, 1e8);
        if (donate === 0 && money === 0) return res.status(400).json({
          ok: false,
          error: "BAD_REWARD"
        });
        const maxUses = clampInt(data.max_uses, 1e6);
        const expDate = normalizeDate(data.expiration_date);
        const isActive = data.is_active === false || data.is_active === 0 || data.is_active === "0" ? 0 : 1;
        try {
          await db().query(`INSERT INTO panel_promocodes (code, donate, money, max_uses, expiration_date, is_active, created_by)\n             VALUES (?, ?, ?, ?, ?, ?, ?)`, [ code, donate, money, maxUses, expDate, isActive, nick ]);
        } catch (e) {
          if (e.code === "ER_DUP_ENTRY") return res.status(409).json({
            ok: false,
            error: "DUPLICATE_CODE"
          });
          throw e;
        }
        await safeLog(req, "PROMO_CREATE", code, `donate:${donate} money:${money} max_uses:${maxUses}`);
        return res.json({
          ok: true
        });
      }
      if (action === "update") {
        const id = parseInt(data.id || 0, 10);
        if (!id) return res.status(400).json({
          ok: false,
          error: "BAD_ID"
        });
        const donate = clampInt(data.donate, 1e6);
        const money = clampInt(data.money, 1e8);
        if (donate === 0 && money === 0) return res.status(400).json({
          ok: false,
          error: "BAD_REWARD"
        });
        const maxUses = clampInt(data.max_uses, 1e6);
        const expDate = data.expiration_date !== undefined ? normalizeDate(data.expiration_date) : undefined;
        const isActive = data.is_active !== undefined ? data.is_active === false || data.is_active === 0 || data.is_active === "0" ? 0 : 1 : undefined;
        let sql = "UPDATE panel_promocodes SET donate=?, money=?, max_uses=?";
        const params = [ donate, money, maxUses ];
        if (expDate !== undefined) {
          sql += ", expiration_date=?";
          params.push(expDate);
        }
        if (isActive !== undefined) {
          sql += ", is_active=?";
          params.push(isActive);
        }
        sql += " WHERE id=? LIMIT 1";
        params.push(id);
        const [result] = await db().query(sql, params);
        if (!result.affectedRows) return res.status(404).json({
          ok: false,
          error: "NOT_FOUND"
        });
        await safeLog(req, "PROMO_UPDATE", String(id), `donate:${donate} money:${money} max_uses:${maxUses}`);
        return res.json({
          ok: true
        });
      }
      if (action === "toggle") {
        const id = parseInt(data.id || 0, 10);
        if (!id) return res.status(400).json({
          ok: false,
          error: "BAD_ID"
        });
        const [result] = await db().query("UPDATE panel_promocodes SET is_active = IF(is_active = 1, 0, 1) WHERE id=? LIMIT 1", [ id ]);
        if (!result.affectedRows) return res.status(404).json({
          ok: false,
          error: "NOT_FOUND"
        });
        await safeLog(req, "PROMO_TOGGLE", String(id), "");
        return res.json({
          ok: true
        });
      }
      if (action === "delete") {
        const id = parseInt(data.id || 0, 10);
        if (!id) return res.status(400).json({
          ok: false,
          error: "BAD_ID"
        });
        await db().query("DELETE FROM panel_promo_usage WHERE promo_id=?", [ id ]);
        const [result] = await db().query("DELETE FROM panel_promocodes WHERE id=? LIMIT 1", [ id ]);
        if (!result.affectedRows) return res.status(404).json({
          ok: false,
          error: "NOT_FOUND"
        });
        await safeLog(req, "PROMO_DELETE", String(id), "");
        return res.json({
          ok: true
        });
      }
      if (action === "reset_usage") {
        const id = parseInt(data.id || 0, 10);
        if (!id) return res.status(400).json({
          ok: false,
          error: "BAD_ID"
        });
        await db().query("DELETE FROM panel_promo_usage WHERE promo_id=?", [ id ]);
        await safeLog(req, "PROMO_RESET_USAGE", String(id), "");
        return res.json({
          ok: true
        });
      }
      return res.status(400).json({
        ok: false,
        error: "UNKNOWN_ACTION"
      });
    } catch (e) {
      console.error("promos post error:", e.message);
      res.status(500).json({
        ok: false,
        error: "DB_ERROR"
      });
    }
  });
  return r;
}

export { ensurePromoTables, isExpired, normalizeCode, promosRoutes as default };
