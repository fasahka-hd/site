import { Router } from "express";

import { db, hasColumnCached } from "../lib/db.js";

import { requirePerm, hasPerm, getUserRole } from "../lib/roles.js";

import { authGuard } from "../lib/guard.js";

import { decodeIfNeeded, steamWorkshopDetails } from "../lib/helpers.js";

function modelsRoutes() {
  const r = Router();
  const tableHasCol = (_pool, table, col) => hasColumnCached(table, col);
  r.get("/api/models", authGuard, requirePerm("view_profile"), async (req, res) => {
    try {
      const pool = db();
      const HAS_TITLE = await tableHasCol(pool, "panel_models", "title");
      const HAS_NAME = await tableHasCol(pool, "panel_models", "name");
      const HAS_ICON = await tableHasCol(pool, "panel_models", "icon_url");
      const HAS_ACTIVE = await tableHasCol(pool, "panel_models", "is_active");
      const q = String(req.query.q || "").trim();
      const role = getUserRole(req.session);
      const includeHidden = [ "1", "true", "yes", "on" ].includes(String(req.query.include_hidden || "").toLowerCase()) && hasPerm(role, "manage_models") && HAS_ACTIVE;
      const where = [];
      const params = [];
      if (!includeHidden && HAS_ACTIVE) where.push("is_active = 1");
      if (q) {
        const conds = [];
        if (HAS_TITLE) conds.push("title LIKE ?");
        if (HAS_NAME) conds.push("name LIKE ?");
        conds.push("model_path LIKE ?");
        conds.push("CAST(workshop_id AS CHAR) LIKE ?");
        where.push("(" + conds.join(" OR ") + ")");
        const qq = "%" + q + "%";
        for (let i = 0; i < conds.length; i++) params.push(qq);
      }
      const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
      const titleExpr = HAS_TITLE ? "title" : HAS_NAME ? "name" : "''";
      const iconExpr = HAS_ICON ? "icon_url" : "''";
      const activeExpr = HAS_ACTIVE ? "is_active" : "1";
      const [rows] = await pool.query(`SELECT id, model_path, (${titleExpr}) AS title, workshop_id, (${iconExpr}) AS icon_url, size_bytes, (${activeExpr}) AS is_active\n         FROM panel_models ${whereSql} ORDER BY id DESC`, params);
      const items = [];
      for (const row of rows) {
        const wsid = String(row.workshop_id || "");
        let icon = String(row.icon_url || "");
        if (!icon && wsid && /^\d+$/.test(wsid)) {
          const d = await steamWorkshopDetails(wsid);
          if (d?.preview_url) {
            icon = d.preview_url;
            if (HAS_ICON) {
              await pool.query("UPDATE panel_models SET icon_url=? WHERE id=? AND (icon_url IS NULL OR icon_url='')", [ icon, row.id ]).catch(() => {});
            }
          }
        }
        items.push({
          id: row.id,
          model_path: String(row.model_path),
          title: decodeIfNeeded(row.title || ""),
          workshop_id: wsid,
          icon_url: icon,
          size_bytes: row.size_bytes != null ? Number(row.size_bytes) : null,
          is_active: Number(row.is_active ?? 1) === 1
        });
      }
      res.json({
        ok: true,
        items: items
      });
    } catch (e) {
      console.error("models get error:", e.message);
      res.status(500).json({
        ok: false,
        error: "DB_ERROR"
      });
    }
  });
  r.post("/api/models", authGuard, requirePerm("manage_models"), async (req, res) => {
    try {
      const pool = db();
      const HAS_ACTIVE = await tableHasCol(pool, "panel_models", "is_active");
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
        if (isActive) {
          await pool.query("UPDATE panel_models SET is_active=1 WHERE id=? LIMIT 1", [ id ]);
        } else {
          const HAS_HIDDEN = await tableHasCol(pool, "panel_models", "hidden_by");
          if (HAS_HIDDEN) {
            const nick = req.session.user?.nickname || "Site";
            await pool.query("UPDATE panel_models SET is_active=0, hidden_by=?, hidden_at=NOW() WHERE id=? LIMIT 1", [ nick, id ]);
          } else {
            await pool.query("UPDATE panel_models SET is_active=0 WHERE id=? LIMIT 1", [ id ]);
          }
        }
        return res.json({
          ok: true
        });
      }
      if (action === "add") {
        const modelPath = String(data.model_path || "").trim();
        const title = String(data.title || "").trim();
        const workshopId = String(data.workshop_id || "").trim() || null;
        if (!modelPath) return res.status(400).json({
          ok: false,
          error: "NO_MODEL_PATH"
        });
        let iconUrl = "";
        let sizeBytes = null;
        if (workshopId && /^\d+$/.test(workshopId)) {
          const d = await steamWorkshopDetails(workshopId);
          if (d) {
            iconUrl = d.preview_url || "";
            sizeBytes = d.file_size;
          }
        }
        const nick = req.session.user?.nickname || "Site";
        const HAS_ICON = await tableHasCol(pool, "panel_models", "icon_url");
        if (HAS_ICON) {
          await pool.query(`INSERT INTO panel_models (name, model_path, workshop_id, icon_url, size_bytes, created_by)\n             VALUES (?, ?, NULLIF(?,''), ?, ?, ?)\n             ON DUPLICATE KEY UPDATE name=VALUES(name), workshop_id=VALUES(workshop_id), icon_url=VALUES(icon_url)`, [ title || modelPath, modelPath, workshopId || "", iconUrl, sizeBytes, nick ]);
        } else {
          await pool.query(`INSERT INTO panel_models (name, model_path, workshop_id, size_bytes, created_by)\n             VALUES (?, ?, NULLIF(?,''), ?, ?)\n             ON DUPLICATE KEY UPDATE name=VALUES(name), workshop_id=VALUES(workshop_id)`, [ title || modelPath, modelPath, workshopId || "", sizeBytes, nick ]);
        }
        if (tableHasCol(pool, "panel_models", "title")) {
          await pool.query("UPDATE panel_models SET title=? WHERE model_path=?", [ title, modelPath ]).catch(() => {});
        }
        return res.json({
          ok: true
        });
      }
      if (action === "edit") {
        const id = parseInt(data.id || 0, 10);
        const modelPath = String(data.model_path || "").trim();
        const title = String(data.title || "").trim();
        const workshopId = String(data.workshop_id || "").trim() || null;
        if (id <= 0 || !modelPath) return res.status(400).json({
          ok: false,
          error: "BAD_PARAMS"
        });
        let iconUrl = "";
        let sizeBytes = null;
        if (workshopId && /^\d+$/.test(workshopId)) {
          const d = await steamWorkshopDetails(workshopId);
          if (d) {
            iconUrl = d.preview_url || "";
            sizeBytes = d.file_size ?? null;
          }
        }
        const HAS_TITLE = await tableHasCol(pool, "panel_models", "title");
        const HAS_ICON = await tableHasCol(pool, "panel_models", "icon_url");
        if (HAS_ICON) {
          if (iconUrl) {
            await pool.query("UPDATE panel_models SET name=?, model_path=?, workshop_id=?, icon_url=?, size_bytes=? WHERE id=? LIMIT 1", [ title || modelPath, modelPath, workshopId || null, iconUrl, sizeBytes, id ]);
          } else {
            await pool.query("UPDATE panel_models SET name=?, model_path=?, workshop_id=? WHERE id=? LIMIT 1", [ title || modelPath, modelPath, workshopId || null, id ]);
          }
        } else {
          await pool.query("UPDATE panel_models SET name=?, model_path=?, workshop_id=? WHERE id=? LIMIT 1", [ title || modelPath, modelPath, workshopId || null, id ]);
        }
        if (HAS_TITLE) {
          await pool.query("UPDATE panel_models SET title=? WHERE id=? LIMIT 1", [ title, id ]).catch(() => {});
        }
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
        await pool.query("DELETE FROM panel_player_models WHERE model_id = ?", [ id ]);
        await pool.query("DELETE FROM panel_models WHERE id = ? LIMIT 1", [ id ]);
        return res.json({
          ok: true
        });
      }
      return res.status(400).json({
        ok: false,
        error: "UNKNOWN_ACTION"
      });
    } catch (e) {
      console.error("models post error:", e.message);
      res.status(500).json({
        ok: false,
        error: "DB_ERROR"
      });
    }
  });
  return r;
}

export { modelsRoutes as default };
