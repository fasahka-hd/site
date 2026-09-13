import { Router } from "express";

import { db, hasColumnCached } from "../lib/db.js";

import { requirePerm, hasPerm, getUserRole } from "../lib/roles.js";

import { authGuard } from "../lib/guard.js";

import { decodeIfNeeded } from "../lib/helpers.js";

function jobsRoutes() {
  const r = Router();
  const tableHasCol = (_pool, table, col) => hasColumnCached(table, col);
  r.get("/api/jobs", authGuard, requirePerm("view_profile"), async (req, res) => {
    try {
      const pool = db();
      const HAS_ACTIVE = await tableHasCol(pool, "panel_jobs", "is_active");
      const q = String(req.query.q || "").trim();
      const role = getUserRole(req.session);
      const includeHidden = [ "1", "true", "yes", "on" ].includes(String(req.query.include_hidden || "").toLowerCase()) && hasPerm(role, "manage_jobs") && HAS_ACTIVE;
      const where = [];
      const params = [];
      if (!includeHidden && HAS_ACTIVE) where.push("is_active = 1");
      if (q) {
        const conds = [];
        conds.push("name LIKE ?");
        conds.push("job_command LIKE ?");
        where.push("(" + conds.join(" OR ") + ")");
        const qq = "%" + q + "%";
        for (let i = 0; i < conds.length; i++) params.push(qq);
      }
      const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
      const activeExpr = HAS_ACTIVE ? "is_active" : "1";
      const [rows] = await pool.query(`SELECT id, job_command, name AS title, ${activeExpr} AS is_active\n         FROM panel_jobs ${whereSql} ORDER BY id DESC`, params);
      const items = rows.map(row => ({
        id: row.id,
        job_command: String(row.job_command),
        title: decodeIfNeeded(row.title || ""),
        is_active: Number(row.is_active ?? 1) === 1
      }));
      res.json({
        ok: true,
        items: items
      });
    } catch (e) {
      console.error("jobs get error:", e.message);
      res.status(500).json({
        ok: false,
        error: "DB_ERROR"
      });
    }
  });
  r.post("/api/jobs", authGuard, requirePerm("manage_jobs"), async (req, res) => {
    try {
      const pool = db();
      const HAS_ACTIVE = await tableHasCol(pool, "panel_jobs", "is_active");
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
        await pool.query("UPDATE panel_jobs SET is_active=? WHERE id=? LIMIT 1", [ isActive, id ]);
        return res.json({
          ok: true
        });
      }
      if (action === "add") {
        const jobCommand = String(data.job_command || "").trim();
        const title = String(data.title || "").trim();
        if (!jobCommand) return res.status(400).json({
          ok: false,
          error: "NO_JOB_COMMAND"
        });
        const nick = req.session.user?.nickname || "Site";
        await pool.query(`INSERT INTO panel_jobs (name, job_command, created_by)\n           VALUES (?, ?, ?)\n           ON DUPLICATE KEY UPDATE name=VALUES(name)`, [ title || jobCommand, jobCommand, nick ]);
        return res.json({
          ok: true
        });
      }
      if (action === "edit") {
        const id = parseInt(data.id || 0, 10);
        const jobCommand = String(data.job_command || "").trim();
        const title = String(data.title || "").trim();
        if (id <= 0 || !jobCommand) return res.status(400).json({
          ok: false,
          error: "BAD_PARAMS"
        });
        await pool.query("UPDATE panel_jobs SET name=?, job_command=? WHERE id=? LIMIT 1", [ title || jobCommand, jobCommand, id ]);
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
        await pool.query("DELETE FROM panel_player_jobs WHERE job_id = ?", [ id ]);
        await pool.query("DELETE FROM panel_jobs WHERE id = ? LIMIT 1", [ id ]);
        return res.json({
          ok: true
        });
      }
      return res.status(400).json({
        ok: false,
        error: "UNKNOWN_ACTION"
      });
    } catch (e) {
      console.error("jobs post error:", e.message);
      res.status(500).json({
        ok: false,
        error: "DB_ERROR"
      });
    }
  });
  return r;
}

export { jobsRoutes as default };
