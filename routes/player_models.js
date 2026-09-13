import { Router } from "express";

import { db, hasColumnCached } from "../lib/db.js";

import { requirePerm } from "../lib/roles.js";

import { authGuard } from "../lib/guard.js";

import { decodeIfNeeded, steamWorkshopDetails, logAdminAction } from "../lib/helpers.js";

import { enqueueCommand } from "../lib/command_queue.js";

function playerModelsRoutes() {
  const r = Router();
  const tableHasCol = (_pool, table, col) => hasColumnCached(table, col);
  r.get("/api/player_models", authGuard, requirePerm("view_profile"), async (req, res) => {
    try {
      const pool = db();
      const steamid32 = String(req.query.steamid32 || "").trim();
      if (!steamid32) return res.json({
        ok: true,
        items: []
      });
      const M_HAS_TITLE = await tableHasCol(pool, "panel_models", "title");
      const M_HAS_NAME = await tableHasCol(pool, "panel_models", "name");
      const M_HAS_ICON = await tableHasCol(pool, "panel_models", "icon_url");
      const PM_HAS_GIVEN_BY = await tableHasCol(pool, "panel_player_models", "given_by");
      const PM_HAS_ISSUED_BY = await tableHasCol(pool, "panel_player_models", "issued_by");
      const PM_HAS_GIVEN_AT = await tableHasCol(pool, "panel_player_models", "given_at");
      const PM_HAS_ISSUED_AT = await tableHasCol(pool, "panel_player_models", "issued_at");
      const titleExpr = M_HAS_TITLE ? "m.title" : M_HAS_NAME ? "m.name" : "''";
      const iconExpr = M_HAS_ICON ? "m.icon_url" : "''";
      const byExpr = PM_HAS_GIVEN_BY ? "pm.given_by" : PM_HAS_ISSUED_BY ? "pm.issued_by" : "''";
      const atExpr = PM_HAS_GIVEN_AT ? "pm.given_at" : PM_HAS_ISSUED_AT ? "pm.issued_at" : "CURRENT_TIMESTAMP";
      const [rows] = await pool.query(`SELECT pm.model_id, (${byExpr}) AS given_by, UNIX_TIMESTAMP(${atExpr}) AS given_at,\n         m.model_path, (${titleExpr}) AS title, m.workshop_id, (${iconExpr}) AS icon_url, m.size_bytes\n         FROM panel_player_models pm JOIN panel_models m ON m.id = pm.model_id\n         WHERE pm.steamid32 = ? ORDER BY ${atExpr} DESC`, [ steamid32 ]);
      const items = [];
      for (const row of rows) {
        const wsid = String(row.workshop_id || "");
        let icon = String(row.icon_url || "");
        if (!icon && wsid && /^\d+$/.test(wsid)) {
          const d = await steamWorkshopDetails(wsid);
          if (d?.preview_url) {
            icon = d.preview_url;
            if (M_HAS_ICON) {
              await pool.query("UPDATE panel_models SET icon_url=? WHERE id=? AND (icon_url IS NULL OR icon_url='')", [ icon, row.model_id ]).catch(() => {});
            }
          }
        }
        items.push({
          model_id: row.model_id,
          model_path: String(row.model_path),
          title: decodeIfNeeded(row.title || ""),
          workshop_id: wsid,
          icon_url: icon,
          size_bytes: row.size_bytes != null ? Number(row.size_bytes) : null,
          given_by: decodeIfNeeded(row.given_by || ""),
          given_at: parseInt(row.given_at || 0, 10)
        });
      }
      res.json({
        ok: true,
        items: items
      });
    } catch (e) {
      console.error("player_models get error:", e.message);
      res.status(500).json({
        ok: false,
        error: "DB_ERROR"
      });
    }
  });
  r.post("/api/player_models", authGuard, requirePerm("give_model"), async (req, res) => {
    try {
      const pool = db();
      const data = req.body;
      const action = String(data.action || "").trim();
      const steamid32 = String(data.steamid32 || "").trim();
      const modelId = parseInt(data.model_id || 0, 10);
      if (action === "give") {
        if (!steamid32 || modelId <= 0) return res.status(400).json({
          ok: false,
          error: "BAD_PARAMS"
        });
        const nick = req.session.user?.nickname || "Site";
        const PM_HAS_GIVEN_BY = await tableHasCol(pool, "panel_player_models", "given_by");
        if (PM_HAS_GIVEN_BY) {
          await pool.query("INSERT IGNORE INTO panel_player_models (steamid32, model_id, given_by, given_at) VALUES (?, ?, ?, NOW())", [ steamid32, modelId, nick ]);
        } else {
          await pool.query("INSERT IGNORE INTO panel_player_models (steamid32, model_id, issued_by) VALUES (?, ?, ?)", [ steamid32, modelId, nick ]);
        }
        if (req.session.user) {
          await logAdminAction(pool, req.session.user.steamid64, "GIVE_MODEL", steamid32, `model_id: ${modelId}`);
        }
        const [[mRow]] = await pool.query("SELECT model_path FROM panel_models WHERE id = ? LIMIT 1", [ modelId ]);
        if (mRow && mRow.model_path) {
          await enqueueCommand(`addmodel ${steamid32} ${mRow.model_path}`, req.session?.user?.steamid64);
        }
        return res.json({
          ok: true
        });
      }
      if (action === "revoke") {
        if (!steamid32 || modelId <= 0) return res.status(400).json({
          ok: false,
          error: "BAD_PARAMS"
        });
        let modelPath = "";
        try {
          const [[mRow]] = await pool.query("SELECT model_path FROM panel_models WHERE id = ? LIMIT 1", [ modelId ]);
          if (mRow) modelPath = mRow.model_path || "";
        } catch (e) { console.error("catch error:", e && e.message ? e.message : e); }
        await pool.query("DELETE FROM panel_player_models WHERE steamid32 = ? AND model_id = ? LIMIT 1", [ steamid32, modelId ]);
        if (req.session.user) {
          await logAdminAction(pool, req.session.user.steamid64, "REVOKE_MODEL", steamid32, `model_id: ${modelId}`);
        }
        if (modelPath) {
          await enqueueCommand(`removemodel ${steamid32} ${modelPath}`, req.session?.user?.steamid64);
        }
        return res.json({
          ok: true
        });
      }
      return res.status(400).json({
        ok: false,
        error: "UNKNOWN_ACTION"
      });
    } catch (e) {
      console.error("player_models post error:", e.message);
      res.status(500).json({
        ok: false,
        error: "DB_ERROR"
      });
    }
  });
  return r;
}

export { playerModelsRoutes as default };
