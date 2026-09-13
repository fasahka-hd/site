import { Router } from "express";

import { db } from "../lib/db.js";

import { requirePerm } from "../lib/roles.js";

import { authGuard } from "../lib/guard.js";

import { decodeIfNeeded, logAdminAction } from "../lib/helpers.js";

async function tableExists(pool, table) {
  try {
    const [rows] = await pool.query("SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1", [ table ]);
    return rows.length > 0;
  } catch {
    return false;
  }
}

function safeJsonKeys(text) {
  try {
    const j = JSON.parse(String(text || "{}"));
    if (!j || typeof j !== "object" || Array.isArray(j)) return [];
    return Object.keys(j).map(decodeIfNeeded);
  } catch {
    return [];
  }
}

function normalizeGangName(v) {
  return decodeIfNeeded(v || "").trim() || "—";
}

function idNum(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function amountNum(v) {
  if (v === null || v === undefined || String(v).trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function filterItems(items, q) {
  const query = String(q || "").trim().toLowerCase();
  if (!query) return items;
  return items.filter(x => [ x.name, x.owner_steamid64, x.owner_name, x.description, x.system_label ].some(v => String(v || "").toLowerCase().includes(query)));
}

async function resolveOwnerNames(pool, items) {
  const ids = [ ...new Set(items.map(x => String(x.owner_steamid64 || "")).filter(x => /^\d{17}$/.test(x))) ];
  if (!ids.length) return;
  const ph = ids.map(() => "?").join(",");
  const names = new Map;
  try {
    const [pd] = await pool.query(`SELECT CAST(SteamID AS CHAR) AS sid, Name FROM player_data WHERE SteamID IN (${ph})`, ids);
    for (const row of pd) if (row.Name) names.set(String(row.sid), decodeIfNeeded(row.Name));
  } catch (e) { console.error("catch error:", e && e.message ? e.message : e); }
  try {
    const [bu] = await pool.query(`SELECT CAST(steamid AS CHAR) AS sid, name FROM ba_users WHERE steamid IN (${ph})`, ids);
    for (const row of bu) if (row.name && !names.has(String(row.sid))) names.set(String(row.sid), decodeIfNeeded(row.name));
  } catch (e) { console.error("catch error:", e && e.message ? e.message : e); }
  for (const item of items) if (!item.owner_name && item.owner_steamid64) item.owner_name = names.get(item.owner_steamid64) || "—";
}

function techGangsRoutes() {
  const r = Router();
  r.get("/api/tech_gangs", authGuard, requirePerm("view_money_logs"), async (req, res) => {
    try {
      const pool = db();
      const system = String(req.query.system || "all").toLowerCase();
      const q = String(req.query.q || "").trim();
      const wantF4 = system === "all" || system === "f4";
      const wantLegacy = system === "all" || system === "legacy";
      const items = [];
      if (wantF4 && await tableExists(pool, "f4_gangs")) {
        const [rows] = await pool.query(`SELECT g.id, g.name, g.owner, g.bank, g.created, g.reputation, g.description,\n                  COUNT(m.steamid) AS members_count,\n                  MAX(CASE WHEN m.steamid = g.owner THEN m.name ELSE NULL END) AS owner_member_name\n           FROM f4_gangs g\n           LEFT JOIN f4_gang_members m ON m.gang_id = g.id\n           GROUP BY g.id, g.name, g.owner, g.bank, g.created, g.reputation, g.description\n           ORDER BY g.reputation DESC, g.bank DESC, g.created DESC`);
        for (const row of rows) items.push({
          system: "f4",
          system_label: "F4 gangs",
          id: row.id,
          name: normalizeGangName(row.name),
          owner_steamid64: String(row.owner || ""),
          owner_name: decodeIfNeeded(row.owner_member_name || ""),
          bank: Number(row.bank || 0),
          reputation: Number(row.reputation || 0),
          lvl: null,
          xp: null,
          points: null,
          maxpoints: null,
          members_count: Number(row.members_count || 0),
          created: Number(row.created || 0),
          description: decodeIfNeeded(row.description || "")
        });
      }
      if (wantLegacy && await tableExists(pool, "gangs")) {
        const [rows] = await pool.query(`SELECT g.name, g.bank, g.points, g.maxpoints, g.description, g.lvl, g.xp, g.ranks,\n                  COUNT(p.SteamID) AS members_count,\n                  MAX(CASE WHEN p.gang_rank LIKE '%Ð’Ð»Ð°Ð´ÐµÐ»ÐµÑ†%' OR p.gang_rank LIKE '%Owner%' THEN CAST(p.SteamID AS CHAR) ELSE NULL END) AS owner_steamid64\n           FROM gangs g\n           LEFT JOIN gangs_player p ON p.gang = g.name\n           GROUP BY g.name, g.bank, g.points, g.maxpoints, g.description, g.lvl, g.xp, g.ranks\n           ORDER BY g.lvl DESC, g.xp DESC, g.bank DESC`);
        for (const row of rows) items.push({
          system: "legacy",
          system_label: "gangs",
          id: row.name,
          name: normalizeGangName(row.name),
          owner_steamid64: String(row.owner_steamid64 || ""),
          owner_name: "",
          bank: Number(row.bank || 0),
          reputation: null,
          lvl: Number(row.lvl || 0),
          xp: Number(row.xp || 0),
          points: Number(row.points || 0),
          maxpoints: Number(row.maxpoints || 0),
          members_count: Number(row.members_count || 0),
          created: null,
          description: decodeIfNeeded(row.description || ""),
          ranks: safeJsonKeys(row.ranks)
        });
      }
      await resolveOwnerNames(pool, items);
      res.json({
        ok: true,
        total: filterItems(items, q).length,
        items: filterItems(items, q)
      });
    } catch (e) {
      console.error("tech_gangs error:", e.message);
      res.status(500).json({
        ok: false,
        error: "DB_ERROR"
      });
    }
  });
  r.get("/api/tech_gangs/detail", authGuard, requirePerm("view_money_logs"), async (req, res) => {
    try {
      const pool = db();
      const system = String(req.query.system || "").toLowerCase();
      const id = String(req.query.id || "");
      if (system === "f4") {
        const gid = idNum(id);
        if (!gid) return res.status(400).json({
          ok: false,
          error: "BAD_ID"
        });
        const [[g]] = await pool.query("SELECT id, name, owner, bank, created, reputation, description FROM f4_gangs WHERE id = ? LIMIT 1", [ gid ]);
        if (!g) return res.status(404).json({
          ok: false,
          error: "NOT_FOUND"
        });
        const [members] = await pool.query(`SELECT m.gang_id, m.steamid, m.name, m.rank_id, m.joined, r.name AS rank_name, r.weight\n           FROM f4_gang_members m LEFT JOIN f4_gang_ranks r ON r.id = m.rank_id\n           WHERE m.gang_id = ? ORDER BY COALESCE(r.weight,0) DESC, m.joined ASC`, [ gid ]);
        return res.json({
          ok: true,
          gang: {
            system: "f4",
            system_label: "F4 gangs",
            id: g.id,
            name: normalizeGangName(g.name),
            owner_steamid64: String(g.owner || ""),
            bank: Number(g.bank || 0),
            reputation: Number(g.reputation || 0),
            created: Number(g.created || 0),
            description: decodeIfNeeded(g.description || "")
          },
          members: members.map(m => ({
            steamid64: String(m.steamid || ""),
            name: decodeIfNeeded(m.name || ""),
            rank_id: m.rank_id,
            rank_name: decodeIfNeeded(m.rank_name || "—"),
            weight: Number(m.weight || 0),
            joined: Number(m.joined || 0)
          }))
        });
      }
      if (system === "legacy") {
        if (!id) return res.status(400).json({
          ok: false,
          error: "BAD_ID"
        });
        const [[g]] = await pool.query("SELECT name, bank, points, maxpoints, description, lvl, xp, ranks FROM gangs WHERE name = ? LIMIT 1", [ id ]);
        if (!g) return res.status(404).json({
          ok: false,
          error: "NOT_FOUND"
        });
        const [members] = await pool.query("SELECT CAST(SteamID AS CHAR) AS steamid, user, gang_rank FROM gangs_player WHERE gang = ? ORDER BY gang_rank ASC, SteamID ASC", [ id ]);
        return res.json({
          ok: true,
          gang: {
            system: "legacy",
            system_label: "gangs",
            id: g.name,
            name: normalizeGangName(g.name),
            bank: Number(g.bank || 0),
            lvl: Number(g.lvl || 0),
            xp: Number(g.xp || 0),
            points: Number(g.points || 0),
            maxpoints: Number(g.maxpoints || 0),
            description: decodeIfNeeded(g.description || ""),
            ranks: safeJsonKeys(g.ranks)
          },
          members: members.map(m => ({
            steamid64: String(m.steamid || ""),
            name: String(m.user || m.steamid || ""),
            rank_name: decodeIfNeeded(m.gang_rank || "—"),
            joined: 0
          }))
        });
      }
      return res.status(400).json({
        ok: false,
        error: "BAD_SYSTEM"
      });
    } catch (e) {
      console.error("tech_gang detail error:", e.message);
      res.status(500).json({
        ok: false,
        error: "DB_ERROR"
      });
    }
  });
  r.post("/api/tech_gangs/action", authGuard, requirePerm("view_money_logs"), async (req, res) => {
    try {
      const pool = db();
      const b = req.body || {};
      const system = String(b.system || "").toLowerCase();
      const action = String(b.action || "").toLowerCase();
      const id = String(b.id || "");
      const amount = amountNum(b.amount);
      const admin = req.session?.user?.steamid64 || "";
      if (![ "f4", "legacy", "all" ].includes(system)) return res.status(400).json({
        ok: false,
        error: "BAD_SYSTEM"
      });
      const targetLabel = action === "reset_rating_all" ? `${system}:all` : `${system}:${id}`;
      if (action === "reset_rating_all") {
        let affected = 0;
        if ((system === "f4" || system === "all") && await tableExists(pool, "f4_gangs")) {
          const [r1] = await pool.query("UPDATE f4_gangs SET reputation = 0");
          affected += Number(r1?.affectedRows || 0);
        }
        if ((system === "legacy" || system === "all") && await tableExists(pool, "gangs")) {
          const [r2] = await pool.query("UPDATE gangs SET points = 0, xp = 0, lvl = 1");
          affected += Number(r2?.affectedRows || 0);
        }
        await logAdminAction(pool, admin, "TECH_GANG_RESET_RATING_ALL", targetLabel, JSON.stringify({
          system: system,
          affected: affected
        }));
        return res.json({
          ok: true,
          affected: affected
        });
      }
      if (system === "all") return res.status(400).json({
        ok: false,
        error: "BAD_SYSTEM"
      });
      if (system === "f4") {
        const gid = idNum(id);
        if (!gid) return res.status(400).json({
          ok: false,
          error: "BAD_ID"
        });
        if (action === "bank_delta") {
          if (amount === null) return res.status(400).json({
            ok: false,
            error: "BAD_AMOUNT"
          });
          await pool.query("UPDATE f4_gangs SET bank = GREATEST(0, bank + ?) WHERE id = ?", [ amount, gid ]);
        } else if (action === "reputation_delta") {
          if (amount === null) return res.status(400).json({
            ok: false,
            error: "BAD_AMOUNT"
          });
          await pool.query("UPDATE f4_gangs SET reputation = reputation + ? WHERE id = ?", [ amount, gid ]);
        } else if (action === "set_bank") {
          if (amount === null) return res.status(400).json({
            ok: false,
            error: "BAD_AMOUNT"
          });
          await pool.query("UPDATE f4_gangs SET bank = GREATEST(0, ?) WHERE id = ?", [ amount, gid ]);
        } else if (action === "set_reputation") {
          if (amount === null) return res.status(400).json({
            ok: false,
            error: "BAD_AMOUNT"
          });
          await pool.query("UPDATE f4_gangs SET reputation = ? WHERE id = ?", [ amount, gid ]);
        } else if (action === "reset_rating") {
          await pool.query("UPDATE f4_gangs SET reputation = 0 WHERE id = ?", [ gid ]);
        } else if (action === "kick_member") {
          const sid = String(b.steamid64 || "").trim();
          if (!/^\d{17}$/.test(sid)) return res.status(400).json({
            ok: false,
            error: "BAD_STEAMID"
          });
          await pool.query("DELETE FROM f4_gang_members WHERE gang_id = ? AND steamid = ?", [ gid, sid ]);
        } else if (action === "delete_gang") {
          await pool.query("DELETE FROM f4_gang_members WHERE gang_id = ?", [ gid ]);
          await pool.query("DELETE FROM f4_gang_ranks WHERE gang_id = ?", [ gid ]);
          await pool.query("DELETE FROM f4_gang_invites WHERE gang_id = ?", [ gid ]);
          await pool.query("UPDATE f4_gang_flags SET gang_id = 0 WHERE gang_id = ?", [ gid ]);
          await pool.query("DELETE FROM f4_gangs WHERE id = ?", [ gid ]);
        } else return res.status(400).json({
          ok: false,
          error: "BAD_ACTION"
        });
      } else {
        if (!id) return res.status(400).json({
          ok: false,
          error: "BAD_ID"
        });
        if (action === "bank_delta") {
          if (amount === null) return res.status(400).json({
            ok: false,
            error: "BAD_AMOUNT"
          });
          await pool.query("UPDATE gangs SET bank = GREATEST(0, bank + ?) WHERE name = ?", [ amount, id ]);
        } else if (action === "set_bank") {
          if (amount === null) return res.status(400).json({
            ok: false,
            error: "BAD_AMOUNT"
          });
          await pool.query("UPDATE gangs SET bank = GREATEST(0, ?) WHERE name = ?", [ amount, id ]);
        } else if (action === "xp_delta") {
          if (amount === null) return res.status(400).json({
            ok: false,
            error: "BAD_AMOUNT"
          });
          await pool.query("UPDATE gangs SET xp = GREATEST(0, xp + ?) WHERE name = ?", [ amount, id ]);
        } else if (action === "points_delta") {
          if (amount === null) return res.status(400).json({
            ok: false,
            error: "BAD_AMOUNT"
          });
          await pool.query("UPDATE gangs SET points = GREATEST(0, points + ?) WHERE name = ?", [ amount, id ]);
        } else if (action === "set_lvl") {
          if (amount === null) return res.status(400).json({
            ok: false,
            error: "BAD_AMOUNT"
          });
          await pool.query("UPDATE gangs SET lvl = GREATEST(1, ?) WHERE name = ?", [ amount, id ]);
        } else if (action === "reset_rating") {
          await pool.query("UPDATE gangs SET points = 0, xp = 0, lvl = 1 WHERE name = ?", [ id ]);
        } else if (action === "kick_member") {
          const sid = String(b.steamid64 || "").trim();
          if (!/^\d{17}$/.test(sid)) return res.status(400).json({
            ok: false,
            error: "BAD_STEAMID"
          });
          await pool.query("DELETE FROM gangs_player WHERE gang = ? AND SteamID = ?", [ id, sid ]);
        } else if (action === "delete_gang") {
          await pool.query("DELETE FROM gangs_player WHERE gang = ?", [ id ]);
          await pool.query("UPDATE gangs_territories SET gang = NULL WHERE gang = ?", [ id ]);
          await pool.query("DELETE FROM gangs WHERE name = ?", [ id ]);
        } else return res.status(400).json({
          ok: false,
          error: "BAD_ACTION"
        });
      }
      await logAdminAction(pool, admin, `TECH_GANG_${action.toUpperCase()}`, targetLabel, JSON.stringify({
        system: system,
        id: id,
        amount: amount,
        steamid64: b.steamid64 || ""
      }));
      res.json({
        ok: true
      });
    } catch (e) {
      console.error("tech_gang action error:", e.message);
      res.status(500).json({
        ok: false,
        error: "DB_ERROR"
      });
    }
  });
  return r;
}

export { techGangsRoutes as default };
