import { Router } from "express";

import rateLimit from "express-rate-limit";

import { db } from "../lib/db.js";

import { requirePerm } from "../lib/roles.js";

import { authGuard } from "../lib/guard.js";

import { decodeIfNeeded } from "../lib/helpers.js";

const MAX_Q_LEN = 120;

const VALID_TYPE_RE = /^(all|topup|purchase|reward|other)$/;

function parseDonateNote(note) {
  const raw = decodeIfNeeded(note || "").trim();
  const out = {
    raw: raw || "—",
    category: "other",
    label: "Другое",
    item: "",
    counterparty: ""
  };
  if (!raw) return out;
  const lower = raw.toLowerCase();
  if (lower.startsWith("p:")) {
    out.category = "purchase";
    out.label = "Покупка привилегии";
    out.item = raw.slice(2).trim();
    return out;
  }
  if (lower.includes("покупка кейса") || lower.includes("кейс")) {
    out.category = "purchase";
    out.label = "Покупка кейса";
    out.item = raw;
    return out;
  }
  if (lower.startsWith("given by ")) {
    out.category = "topup";
    out.label = "Пополнение от админа";
    const m = raw.match(/Given by\s+(.+?)\s*\(/i);
    if (m) out.counterparty = m[1].trim();
    return out;
  }
  if (lower.startsWith("reward:")) {
    out.category = "reward";
    out.label = "Награда";
    out.item = raw.slice(7).trim();
    return out;
  }
  if (lower.includes("timebonus")) {
    out.category = "reward";
    out.label = "Награда за время";
    return out;
  }
  if (lower.includes("пополнение") || lower.includes("зачисление") || lower.includes("пополнил")) {
    out.category = "topup";
    out.label = "Пополнение";
    return out;
  }
  if (lower.includes("покупка") || lower.includes("купил") || lower.includes("списание")) {
    out.category = "purchase";
    out.label = "Покупка / списание";
    out.item = raw;
    return out;
  }
  return out;
}

function tableExists(pool, table) {
  return pool.query("SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1", [ table ]).then(([rows]) => rows.length > 0).catch(() => false);
}

function validateDonateQuery(q) {
  const s = String(q || "").trim();
  if (!s) return "";
  return s.slice(0, MAX_Q_LEN).replace(/[%_]/g, "\\$&");
}

function donateLogsRoutes() {
  const r = Router();
  const donateApiLimiter = rateLimit({
    windowMs: 60 * 1e3,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      ok: false,
      error: "DONATE_LOGS_RATE_LIMIT"
    },
    skipSuccessfulRequests: false
  });
  r.get("/api/donate_logs", donateApiLimiter, authGuard, requirePerm("view_donate_logs"), async (req, res) => {
    try {
      const pool = db();
      const playersExists = await tableExists(pool, "GMDonate_Players");
      const txExists = await tableExists(pool, "GMDonate_Transactions");
      if (!playersExists || !txExists) {
        return res.json({
          ok: true,
          page: 1,
          per_page: 50,
          total: 0,
          pages: 1,
          items: []
        });
      }
      const page = Math.max(1, parseInt(req.query.page || "1", 10));
      const perPage = Math.max(1, Math.min(100, parseInt(req.query.per_page || "50", 10)));
      const offset = (page - 1) * perPage;
      const rawType = String(req.query.type || "all").trim();
      const type = VALID_TYPE_RE.test(rawType) ? rawType : "all";
      const q = validateDonateQuery(req.query.q);
      const where = [];
      const params = [];
      if (q) {
        where.push("(t.SteamID64 LIKE ? OR p.Nick LIKE ? OR t.Note LIKE ?)");
        params.push(`%${q}%`, `%${q}%`, `%${q}%`);
      }
      if (type !== "all") {
        if (type === "topup") where.push("t.Sum > 0"); else if (type === "purchase") where.push("t.Sum < 0"); else if (type === "reward") where.push("t.Note LIKE 'Reward:%'"); else if (type === "other") {
          where.push("t.Sum = 0");
          where.push("(t.Note IS NULL OR t.Note = '')");
        }
      }
      const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
      const [[countRow]] = await pool.query(`SELECT COUNT(*) AS cnt FROM GMDonate_Transactions t\n         LEFT JOIN GMDonate_Players p ON p.SteamID64 = t.SteamID64 ${whereSql}`, params);
      const total = parseInt(countRow?.cnt || 0, 10);
      const [[agg]] = await pool.query(`SELECT\n           COALESCE(SUM(t.Sum), 0) AS sum_total,\n           COALESCE(SUM(CASE WHEN t.Sum > 0 THEN t.Sum ELSE 0 END), 0) AS sum_topup,\n           COALESCE(SUM(CASE WHEN t.Sum < 0 THEN -t.Sum ELSE 0 END), 0) AS sum_purchase,\n           COALESCE(SUM(CASE WHEN t.Note LIKE 'Reward:%' THEN t.Sum ELSE 0 END), 0) AS sum_reward\n         FROM GMDonate_Transactions t\n         LEFT JOIN GMDonate_Players p ON p.SteamID64 = t.SteamID64 ${whereSql}`, params);
      const sumTotal = Number(agg?.sum_total || 0);
      const sumTopup = Number(agg?.sum_topup || 0);
      const sumPurchase = Number(agg?.sum_purchase || 0);
      const sumReward = Number(agg?.sum_reward || 0);
      const [rows] = await pool.query(`SELECT t.TxHash, CAST(t.SteamID64 AS CHAR) AS SteamID64, t.Sum, t.Note, t.TxTime, t.RawJSON,\n                p.Nick AS donate_nick, p.Balance AS current_balance\n         FROM GMDonate_Transactions t\n         LEFT JOIN GMDonate_Players p ON p.SteamID64 = t.SteamID64\n         ${whereSql}\n         ORDER BY t.TxTime DESC, t.TxHash DESC LIMIT ?, ?`, [ ...params, offset, perPage ]);
      const sids = [ ...new Set(rows.map(r2 => String(r2.SteamID64 || "")).filter(Boolean)) ];
      const names = new Map;
      if (sids.length) {
        try {
          const ph = sids.map(() => "?").join(",");
          const [bu] = await pool.query(`SELECT CAST(steamid AS CHAR) AS sid, name FROM ba_users WHERE steamid IN (${ph})`, sids);
          for (const x of bu) {
            names.set(String(x.sid), decodeIfNeeded(x.name || ""));
          }
        } catch (e) { console.error("catch error:", e && e.message ? e.message : e); }
      }
      const items = rows.map(row => {
        const sid64 = String(row.SteamID64 || "");
        const donateNick = decodeIfNeeded(row.donate_nick || "");
        const name = donateNick || names.get(sid64) || "—";
        const parsed = parseDonateNote(row.Note);
        let rawJson = null;
        try {
          rawJson = row.RawJSON ? JSON.parse(String(row.RawJSON)) : null;
        } catch {
          rawJson = null;
        }
        return {
          id: String(row.TxHash || ""),
          steamid64: sid64,
          name: name,
          sum: Number(row.Sum || 0),
          note: parsed.raw,
          category: parsed.category,
          category_label: parsed.label,
          item: parsed.item || "",
          counterparty: parsed.counterparty || "",
          tx_time: row.TxTime ? new Date(row.TxTime * 1e3).toISOString() : null,
          current_balance: Math.round(Number(row.current_balance || 0)),
          raw_json: rawJson
        };
      });
      let filteredItems = items;
      if (type === "reward") {
        filteredItems = items.filter(it => it.category === "reward");
      } else if (type === "other") {
        filteredItems = items.filter(it => it.category === "other");
      } else if (type !== "all") {
        filteredItems = items.filter(it => it.category === type || (type === "topup" ? it.sum > 0 : it.sum < 0));
      }
      const finalTotal = type === "all" ? total : filteredItems.length;
      const finalPages = Math.max(1, Math.ceil(finalTotal / perPage));
      res.json({
        ok: true,
        page: page,
        per_page: perPage,
        total: finalTotal,
        pages: finalPages,
        sum_total: sumTotal,
        sum_topup: sumTopup,
        sum_purchase: sumPurchase,
        sum_reward: sumReward,
        items: filteredItems
      });
    } catch (e) {
      console.error("donate_logs error:", e.message);
      res.status(500).json({
        ok: false,
        error: "DB_ERROR"
      });
    }
  });
  return r;
}

export { donateLogsRoutes as default };
