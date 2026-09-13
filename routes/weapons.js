import { Router } from "express";

import { db, hasColumnCached } from "../lib/db.js";

import { requirePerm, hasPerm, getUserRole } from "../lib/roles.js";

import { authGuard } from "../lib/guard.js";

import { decodeIfNeeded } from "../lib/helpers.js";

function weaponsRoutes() {
  const r = Router();
  const tableHasCol = (_pool, table, col) => hasColumnCached(table, col);
  r.get("/api/weapons", authGuard, requirePerm("view_profile"), async (req, res) => {
    try {
      const pool = db();
      const HAS_ACTIVE = await tableHasCol(pool, "panel_weapons", "is_active");
      const q = String(req.query.q || "").trim();
      const role = getUserRole(req.session);
      const includeHidden = [ "1", "true", "yes", "on" ].includes(String(req.query.include_hidden || "").toLowerCase()) && hasPerm(role, "manage_weapons") && HAS_ACTIVE;
      const where = [];
      const params = [];
      if (!includeHidden && HAS_ACTIVE) where.push("is_active = 1");
      if (q) {
        const conds = [];
        conds.push("name LIKE ?");
        conds.push("weapon_class LIKE ?");
        where.push("(" + conds.join(" OR ") + ")");
        const qq = "%" + q + "%";
        for (let i = 0; i < conds.length; i++) params.push(qq);
      }
      const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
      const activeExpr = HAS_ACTIVE ? "is_active" : "1";
      const [rows] = await pool.query(`SELECT id, weapon_class, name AS title, ${activeExpr} AS is_active\n         FROM panel_weapons ${whereSql} ORDER BY id DESC`, params);
      const items = rows.map(row => ({
        id: row.id,
        weapon_class: String(row.weapon_class),
        title: decodeIfNeeded(row.title || ""),
        is_active: Number(row.is_active ?? 1) === 1
      }));
      res.json({
        ok: true,
        items: items
      });
    } catch (e) {
      console.error("weapons get error:", e.message);
      res.status(500).json({
        ok: false,
        error: "DB_ERROR"
      });
    }
  });
  r.post("/api/weapons", authGuard, requirePerm("manage_weapons"), async (req, res) => {
    try {
      const pool = db();
      const HAS_ACTIVE = await tableHasCol(pool, "panel_weapons", "is_active");
      const data = req.body;
      const action = String(data.action || "").trim();
      if (action === "toggle") {
        if (!HAS_ACTIVE) return res.status(400).json({
          ok: false,
          error: "SCHEMA_NO_IS_ACTIVE"
        });
        const id = parseInt(data.id || 0, 10);
        const isActive = [ 1, "1", true, "true", "yes", "on" ].includes(data.is_active) ? 1 : 0;
        if (id <= 0) return res.status(400).json({
          ok: false,
          error: "BAD_ID"
        });
        await pool.query("UPDATE panel_weapons SET is_active=? WHERE id=? LIMIT 1", [ isActive, id ]);
        return res.json({
          ok: true
        });
      }
      if (action === "add") {
        const weaponClass = String(data.weapon_class || "").trim();
        const title = String(data.title || "").trim();
        if (!weaponClass) return res.status(400).json({
          ok: false,
          error: "NO_WEAPON_CLASS"
        });
        const nick = req.session.user?.nickname || "Site";
        const HAS_WORKSHOP = await tableHasCol(pool, "panel_weapons", "workshop_id");
        const HAS_ICON = await tableHasCol(pool, "panel_weapons", "icon_url");
        if (HAS_WORKSHOP && HAS_ICON) {
          await pool.query(`INSERT INTO panel_weapons (name, weapon_class, workshop_id, icon_url, created_by)\n             VALUES (?, ?, NULL, '', ?)\n             ON DUPLICATE KEY UPDATE name=VALUES(name)`, [ title || weaponClass, weaponClass, nick ]);
        } else if (HAS_WORKSHOP) {
          await pool.query(`INSERT INTO panel_weapons (name, weapon_class, workshop_id, created_by)\n             VALUES (?, ?, NULL, ?)\n             ON DUPLICATE KEY UPDATE name=VALUES(name)`, [ title || weaponClass, weaponClass, nick ]);
        } else if (HAS_ICON) {
          await pool.query(`INSERT INTO panel_weapons (name, weapon_class, icon_url, created_by)\n             VALUES (?, ?, '', ?)\n             ON DUPLICATE KEY UPDATE name=VALUES(name)`, [ title || weaponClass, weaponClass, nick ]);
        } else {
          await pool.query(`INSERT INTO panel_weapons (name, weapon_class, created_by)\n             VALUES (?, ?, ?)\n             ON DUPLICATE KEY UPDATE name=VALUES(name)`, [ title || weaponClass, weaponClass, nick ]);
        }
        return res.json({
          ok: true
        });
      }
      if (action === "edit") {
        const id = parseInt(data.id || 0, 10);
        const weaponClass = String(data.weapon_class || "").trim();
        const title = String(data.title || "").trim();
        if (id <= 0 || !weaponClass) return res.status(400).json({
          ok: false,
          error: "BAD_PARAMS"
        });
        await pool.query("UPDATE panel_weapons SET name=?, weapon_class=? WHERE id=? LIMIT 1", [ title || weaponClass, weaponClass, id ]);
        return res.json({
          ok: true
        });
      }
      if (action === "delete") {
        const id = parseInt(data.id || 0, 10);
        if (id <= 0) return res.status(400).json({
          ok: false,
          error: "BAD_ID"
        });
        await pool.query("DELETE FROM panel_player_weapons WHERE weapon_id = ?", [ id ]);
        await pool.query("DELETE FROM panel_weapons WHERE id = ? LIMIT 1", [ id ]);
        return res.json({
          ok: true
        });
      }
      return res.status(400).json({
        ok: false,
        error: "UNKNOWN_ACTION"
      });
    } catch (e) {
      console.error("weapons post error:", e.message);
      res.status(500).json({
        ok: false,
        error: "DB_ERROR"
      });
    }
  });
  return r;
}

export { weaponsRoutes as default };
