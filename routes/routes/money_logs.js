import { Router } from "express";

import { db } from "../lib/db.js";

import { requirePerm } from "../lib/roles.js";

import { authGuard } from "../lib/guard.js";

import { decodeIfNeeded } from "../lib/helpers.js";

function parseMoneyDescription(desc) {
  const raw = decodeIfNeeded(desc || "").trim();
  const out = {
    action: raw || "—",
    counterparty_sid64: "",
    direction: "",
    counterparty_label: ""
  };
  let m = raw.match(/Передача\s+денег\s*->\s*(\d{17})/i);
  if (m) {
    out.action = "Передал деньги";
    out.direction = "out";
    out.counterparty_sid64 = m[1];
    return out;
  }
  m = raw.match(/Передача\s+денег\s*<-\s*(\d{17})/i);
  if (m) {
    out.action = "Получил перевод";
    out.direction = "in";
    out.counterparty_sid64 = m[1];
    return out;
  }
  if (/Вывод\s+с\s+принтера/i.test(raw)) out.action = "Вывод с принтера"; else if (/Получил\s+за\s+п[эе]йдей/i.test(raw)) out.action = "Получил за пэйдей"; else if (/Купил\s+энтити/i.test(raw)) out.action = "Купил энтити"; else if (/TakeMoney/i.test(raw)) out.action = "Списание денег"; else if (/AddMoney/i.test(raw)) out.action = "Начисление денег";
  return out;
}

function moneyLogsRoutes() {
  const r = Router();
  r.get("/api/money_logs", authGuard, requirePerm("view_money_logs"), async (req, res) => {
    try {
      const pool = db();
      const page = Math.max(1, parseInt(req.query.page || "1", 10));
      const perPage = Math.max(1, Math.min(100, parseInt(req.query.per_page || "50", 10)));
      const offset = (page - 1) * perPage;
      const q = String(req.query.q || "").trim();
      const type = String(req.query.type || "all").trim();
      const where = [];
      const params = [];
      if (q) {
        where.push("(Name LIKE ? OR CAST(SteamID64 AS CHAR) LIKE ? OR Description LIKE ?)");
        params.push(`%${q}%`, `%${q}%`, `%${q}%`);
      }
      if (type === "transfer") where.push("Description LIKE 'Передача денег%'"); else if (type === "income") where.push("Money > 0"); else if (type === "expense") where.push("Money < 0");
      const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
      const [[countRow]] = await pool.query(`SELECT COUNT(*) AS cnt FROM player_moneylog ${whereSql}`, params);
      const total = parseInt(countRow?.cnt || 0, 10);
      const [[agg]] = await pool.query(`SELECT\n           COALESCE(SUM(CASE WHEN Money > 0 THEN Money ELSE 0 END), 0) AS sum_income,\n           COALESCE(SUM(CASE WHEN Money < 0 THEN -Money ELSE 0 END), 0) AS sum_expense\n         FROM player_moneylog ${whereSql}`, params);
      const sumIncome = Number(agg?.sum_income || 0);
      const sumExpense = Number(agg?.sum_expense || 0);
      const [rows] = await pool.query(`SELECT id, Name, CAST(SteamID64 AS CHAR) AS SteamID64, Money, Description, NormalDate, Time\n         FROM player_moneylog ${whereSql}\n         ORDER BY Time DESC, id DESC LIMIT ?, ?`, [ ...params, offset, perPage ]);
      const counterparties = new Set;
      const parsed = rows.map(row => {
        const p = parseMoneyDescription(row.Description);
        if (p.counterparty_sid64) counterparties.add(p.counterparty_sid64);
        return {
          row: row,
          p: p
        };
      });
      const names = new Map;
      if (counterparties.size) {
        const ids = [ ...counterparties ];
        const ph = ids.map(() => "?").join(",");
        try {
          const [pd] = await pool.query(`SELECT CAST(SteamID AS CHAR) AS sid, Name FROM player_data WHERE SteamID IN (${ph})`, ids);
          for (const x of pd) names.set(String(x.sid), decodeIfNeeded(x.Name || ""));
        } catch (e) { console.error("catch error:", e && e.message ? e.message : e); }
        try {
          const [bu] = await pool.query(`SELECT CAST(steamid AS CHAR) AS sid, name FROM ba_users WHERE steamid IN (${ph})`, ids);
          for (const x of bu) if (!names.has(String(x.sid))) names.set(String(x.sid), decodeIfNeeded(x.name || ""));
        } catch (e) { console.error("catch error:", e && e.message ? e.message : e); }
      }
      const items = parsed.map(({row: row, p: p}) => ({
        id: parseInt(row.id || 0, 10),
        name: decodeIfNeeded(row.Name || ""),
        steamid64: String(row.SteamID64 || ""),
        money: Number(row.Money || 0),
        description: decodeIfNeeded(row.Description || ""),
        action: p.action,
        direction: p.direction,
        counterparty_steamid64: p.counterparty_sid64,
        counterparty_name: p.counterparty_sid64 ? names.get(p.counterparty_sid64) || "—" : "",
        normal_date: String(row.NormalDate || ""),
        time: row.Time ? new Date(row.Time).toISOString() : null
      }));
      res.json({
        ok: true,
        page: page,
        per_page: perPage,
        total: total,
        pages: Math.max(1, Math.ceil(total / perPage)),
        sum_income: sumIncome,
        sum_expense: sumExpense,
        sum_net: sumIncome - sumExpense,
        items: items
      });
    } catch (e) {
      console.error("money_logs error:", e.message);
      res.status(500).json({
        ok: false,
        error: "DB_ERROR"
      });
    }
  });
  return r;
}

export { moneyLogsRoutes as default };
