import { Router } from "express";

import bcrypt from "bcryptjs";

import { db, hasColumnCached } from "../lib/db.js";

import { requirePerm, webAllowedRoles, webNormalizeRole, webRoleLabel, webRolesDef } from "../lib/roles.js";

import { authGuard } from "../lib/guard.js";

import { logAdminAction } from "../lib/helpers.js";

function usersRoutes() {
  const r = Router();
  function isTransientDbError(e) {
    const code = String(e?.code || e?.errno || e?.message || "");
    return code.includes("ETIMEDOUT") || code.includes("ECONNRESET") || code.includes("PROTOCOL_CONNECTION_LOST") || code.includes("EPIPE");
  }
  async function queryRetry(pool, sql, params = []) {
    try {
      return await pool.query(sql, params);
    } catch (e) {
      if (!isTransientDbError(e)) throw e;
      await new Promise(resolve => setTimeout(resolve, 150));
      return await pool.query(sql, params);
    }
  }
  function toUnix(value) {
    if (!value) return 0;
    if (value instanceof Date) return Math.floor(value.getTime() / 1e3);
    const n = parseInt(value, 10);
    return Number.isFinite(n) ? n : 0;
  }
  r.get("/api/get_users", authGuard, requirePerm("manage_users"), async (req, res) => {
    try {
      const pool = db();
      const hasAddedAt = await hasColumnCached("web_users", "added_at");
      const hasCreatedAt = hasAddedAt ? false : await hasColumnCached("web_users", "created_at");
      const page = Math.max(1, parseInt(req.query.page || "1", 10));
      const limit = Math.min(100, Math.max(10, parseInt(req.query.limit || "50", 10)));
      const offset = (page - 1) * limit;
      let sql = "";
      if (hasAddedAt) {
        sql = `SELECT steamid64, role, added_at, COALESCE(nickname,'') AS nickname FROM web_users ORDER BY added_at DESC LIMIT ? OFFSET ?`;
      } else if (hasCreatedAt) {
        sql = `SELECT steamid64, role, created_at AS added_at, COALESCE(nickname,'') AS nickname FROM web_users ORDER BY created_at DESC LIMIT ? OFFSET ?`;
      } else {
        sql = `SELECT steamid64, role, 0 AS added_at, COALESCE(nickname,'') AS nickname FROM web_users ORDER BY id DESC LIMIT ? OFFSET ?`;
      }
      const [rows] = await queryRetry(pool, sql, [limit, offset]);
      const users = rows.map(r2 => ({
        nickname: r2.nickname,
        steamid64: r2.steamid64,
        role: webNormalizeRole(r2.role),
        role_label: webRoleLabel(webNormalizeRole(r2.role)),
        added_at: toUnix(r2.added_at)
      }));
      res.json({
        ok: true,
        users: users
      });
    } catch (e) {
      console.error("get_users error:", e.message);
      res.status(500).json({
        ok: false,
        error: "DB_ERROR"
      });
    }
  });
  r.post("/api/add_user", authGuard, requirePerm("manage_users"), async (req, res) => {
    try {
      const {steamid64: rawSid, nickname: rawNick, password: rawPass, role: rawRole} = req.body || {};
      const steamid64 = String(rawSid || "").trim();
      const nickname = String(rawNick || "").trim();
      const password = String(rawPass || "").trim();
      const role = String(rawRole || "Главный Администратор").trim();
      if (!webAllowedRoles().includes(role)) return res.status(400).json({
        ok: false,
        error: "INVALID_ROLE"
      });
      if (!nickname || nickname.length < 2) return res.status(400).json({
        ok: false,
        error: "NICKNAME_EMPTY"
      });
      if (nickname.length > 32) return res.status(400).json({
        ok: false,
        error: "NICKNAME_TOO_LONG"
      });
      if (!/^\d{17}$/.test(steamid64)) return res.status(400).json({
        ok: false,
        error: "INVALID_STEAMID64"
      });
      if (password.length < 6) return res.status(400).json({
        ok: false,
        error: "PASSWORD_TOO_SHORT"
      });
      if (password.length > 200) return res.status(400).json({
        ok: false,
        error: "PASSWORD_TOO_LONG"
      });
      const actorRole = webNormalizeRole(req.session.user?.role);
      const actorLevel = webRolesDef()[actorRole]?.level || 0;
      const targetLevel = webRolesDef()[role]?.level || 0;
      if (actorRole !== "KP" && targetLevel >= actorLevel) return res.status(403).json({
        ok: false,
        error: "INSUFFICIENT_PRIVILEGES"
      });
      const pool = db();
      const [existing] = await pool.query("SELECT id FROM web_users WHERE steamid64 = ?", [ steamid64 ]);
      if (existing.length > 0) return res.status(400).json({
        ok: false,
        error: "USER_ALREADY_EXISTS"
      });
      const [cols] = await pool.query("SHOW COLUMNS FROM web_users LIKE 'added_at'");
      const hasAddedAt = cols.length > 0;
      const hash = await bcrypt.hash(password, 12);
      if (hasAddedAt) {
        await pool.query("INSERT INTO web_users (steamid64, password_hash, role, nickname, added_at) VALUES (?, ?, ?, ?, UNIX_TIMESTAMP())", [ steamid64, hash, role, nickname ]);
      } else {
        await pool.query("INSERT INTO web_users (steamid64, password_hash, role, nickname) VALUES (?, ?, ?, ?)", [ steamid64, hash, role, nickname ]);
      }
      if (req.session.user) {
        await logAdminAction(pool, req.session.user.steamid64, "ADD_USER", steamid64, `Роль: ${role}`);
      }
      res.json({
        ok: true,
        message: "Пользователь создан",
        steamid64: steamid64,
        role: role
      });
    } catch (e) {
      console.error("add_user error:", e.message);
      res.status(500).json({
        ok: false,
        error: "DB_ERROR"
      });
    }
  });
  r.post("/api/update_user", authGuard, requirePerm("manage_users"), async (req, res) => {
    let conn;
    try {
      const {steamid64: rawSid, nickname: rawNick, password: rawPass, role: rawRole} = req.body || {};
      const steamid64 = String(rawSid || "").trim();
      if (!/^\d{17}$/.test(steamid64)) return res.status(400).json({
        ok: false,
        error: "INVALID_STEAMID64"
      });
      if (rawNick !== void 0) {
        const n = String(rawNick || "").trim();
        if (!n || n.length < 2) return res.status(400).json({
          ok: false,
          error: "NICKNAME_EMPTY"
        });
        if (n.length > 32) return res.status(400).json({
          ok: false,
          error: "NICKNAME_TOO_LONG"
        });
      }
      if (rawRole !== void 0 && !webAllowedRoles().includes(String(rawRole || "").trim())) {
        return res.status(400).json({
          ok: false,
          error: "INVALID_ROLE"
        });
      }
      if (rawPass !== void 0 && String(rawPass).length > 0) {
        const p = String(rawPass);
        if (p.length < 6) return res.status(400).json({
          ok: false,
          error: "PASSWORD_TOO_SHORT"
        });
        if (p.length > 200) return res.status(400).json({
          ok: false,
          error: "PASSWORD_TOO_LONG"
        });
      }
      if (rawNick === void 0 && rawRole === void 0 && !(rawPass !== void 0 && String(rawPass).length > 0)) {
        return res.status(400).json({
          ok: false,
          error: "NOTHING_TO_UPDATE"
        });
      }
      conn = await db().getConnection();
      await conn.beginTransaction();
      const [existing] = await conn.query("SELECT id, role FROM web_users WHERE steamid64 = ? FOR UPDATE", [ steamid64 ]);
      if (!existing.length) return res.status(404).json({
        ok: false,
        error: "USER_NOT_FOUND"
      });
      const actorRole = webNormalizeRole(req.session.user?.role);
      const actorLevel = webRolesDef()[actorRole]?.level || 0;
      const isSelf = req.session.user?.steamid64 === steamid64;
      const curRole = webNormalizeRole(existing[0].role);
      const curLevel = webRolesDef()[curRole]?.level || 0;
      if (actorRole !== "KP" && !isSelf && curLevel >= actorLevel) {
        return res.status(403).json({
          ok: false,
          error: "INSUFFICIENT_PRIVILEGES"
        });
      }
      const sets = [];
      const params = [];
      const changes = [];
      if (rawNick !== void 0) {
        const nickname = String(rawNick || "").trim();
        if (!nickname || nickname.length < 2) return res.status(400).json({
          ok: false,
          error: "NICKNAME_EMPTY"
        });
        if (nickname.length > 32) return res.status(400).json({
          ok: false,
          error: "NICKNAME_TOO_LONG"
        });
        sets.push("nickname = ?");
        params.push(nickname);
        changes.push("ник");
      }
      if (rawRole !== void 0) {
        const role = String(rawRole || "").trim();
        if (!webAllowedRoles().includes(role)) return res.status(400).json({
          ok: false,
          error: "INVALID_ROLE"
        });
        const newLevel = webRolesDef()[role]?.level || 0;
        if (actorRole !== "KP" && newLevel >= actorLevel) {
          return res.status(403).json({
            ok: false,
            error: "CANNOT_ASSIGN_HIGHER_OR_EQUAL_ROLE"
          });
        }
        if (isSelf && role !== curRole && actorRole !== "KP") {
          return res.status(403).json({
            ok: false,
            error: "CANNOT_CHANGE_OWN_ROLE"
          });
        }
        sets.push("role = ?");
        params.push(role);
        changes.push(`роль → ${role}`);
      }
      if (rawPass !== void 0 && String(rawPass).length > 0) {
        const password = String(rawPass);
        if (password.length < 6) return res.status(400).json({
          ok: false,
          error: "PASSWORD_TOO_SHORT"
        });
        if (password.length > 200) return res.status(400).json({
          ok: false,
          error: "PASSWORD_TOO_LONG"
        });
        const hash = await bcrypt.hash(password, 12);
        sets.push("password_hash = ?");
        params.push(hash);
        changes.push("пароль");
      }
      if (!sets.length) return res.status(400).json({
        ok: false,
        error: "NOTHING_TO_UPDATE"
      });
      params.push(steamid64);
      await conn.query(`UPDATE web_users SET ${sets.join(", ")} WHERE steamid64 = ?`, params);
      const [updatedRows] = await conn.query("SELECT COALESCE(nickname,'') AS nickname, COALESCE(role,'') AS role FROM web_users WHERE steamid64 = ? LIMIT 1", [ steamid64 ]);
      const updatedNick = String(updatedRows[0]?.nickname || "").trim();
      const updatedRole = webNormalizeRole(updatedRows[0]?.role || curRole);
      if (isSelf && req.session.user) {
        req.session.user.nickname = updatedNick;
        req.session.user.role = updatedRole;
      }
      if ((rawNick !== void 0 || rawRole !== void 0) && req.app.locals.broadcastMessenger) {
        req.app.locals.broadcastMessenger({
          type: "user_update",
          steamid64: steamid64,
          nickname: updatedNick || steamid64,
          role: webRoleLabel(updatedRole)
        });
      }
      if (req.session.user) {
        await logAdminAction(conn, req.session.user.steamid64, "EDIT_USER", steamid64, changes.join(", "));
      }
      await conn.commit();
      await conn.release();
      res.json({
        ok: true,
        message: "Изменения сохранены",
        steamid64: steamid64
      });
    } catch (e) {
      if (conn) { try { await conn.rollback(); } catch (_) {}; try { await conn.release(); } catch (_) {}; }
      console.error("update_user error:", e.message);
      res.status(500).json({
        ok: false,
        error: "DB_ERROR"
      });
    }
  });
  r.delete("/api/delete_user", authGuard, requirePerm("manage_users"), async (req, res) => {
    try {
      const steamid64 = String(req.query.sid || "").trim();
      if (!steamid64) return res.status(400).json({
        ok: false,
        error: "EMPTY_STEAMID64"
      });
      if (!/^\d{17}$/.test(steamid64)) return res.status(400).json({
        ok: false,
        error: "INVALID_STEAMID64"
      });
      conn = await db().getConnection();
      await conn.beginTransaction();
      const [existing] = await conn.query("SELECT id, role FROM web_users WHERE steamid64 = ? FOR UPDATE", [ steamid64 ]);
      if (!existing.length) return res.status(404).json({
        ok: false,
        error: "USER_NOT_FOUND"
      });
      if (req.session.user?.steamid64 === steamid64) {
        return res.status(400).json({
          ok: false,
          error: "CANNOT_DELETE_YOURSELF"
        });
      }
      const actorRole = webNormalizeRole(req.session.user?.role);
      const actorLevel = webRolesDef()[actorRole]?.level || 0;
      const targetRole = webNormalizeRole(existing[0].role);
      const targetLevel = webRolesDef()[targetRole]?.level || 0;
      if (actorRole !== "KP" && targetLevel >= actorLevel) return res.status(403).json({
        ok: false,
        error: "INSUFFICIENT_PRIVILEGES"
      });
      await pool.query("DELETE FROM web_users WHERE steamid64 = ?", [ steamid64 ]);
      await pool.query("DELETE FROM admin_logs WHERE target = ? OR details LIKE ?", [ steamid64, "%" + steamid64 + "%"]).catch(() => {});
      if (req.session.user) {
        await logAdminAction(pool, req.session.user.steamid64, "DELETE_USER", steamid64, `Роль: ${existing[0].role}`);
      }
      res.json({
        ok: true,
        message: "Пользователь удален",
        steamid64: steamid64
      });
    } catch (e) {
      console.error("delete_user error:", e.message);
      res.status(500).json({
        ok: false,
        error: "DB_ERROR"
      });
    }
  });
  return r;
}

export { usersRoutes as default };
