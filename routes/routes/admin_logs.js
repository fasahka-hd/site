import { Router } from "express";

import { db } from "../lib/db.js";

import { requirePerm } from "../lib/roles.js";

import { authGuard } from "../lib/guard.js";

import { decodeIfNeeded } from "../lib/helpers.js";

function adminLogsRoutes() {
  const r = Router();
  function steamidToSid64(steamid) {
    steamid = String(steamid || "").trim();
    if (/^\d{17}$/.test(steamid)) return steamid;
    const m = steamid.match(/^STEAM_\d:([01]):(\d+)$/);
    if (!m) return "";
    const y = parseInt(m[1], 10);
    const z = parseInt(m[2], 10);
    return String(76561197960265728n + BigInt(z) * 2n + BigInt(y));
  }
  function parseQuoted(text) {
    const out = [];
    String(text || "").replace(/"([^"]*)"|(\S+)/g, (_, q, w) => {
      out.push(q !== void 0 ? q : w);
      return "";
    });
    return out;
  }
  function actionGroupSql(group) {
    const map = {
      blacklist: [ "BLACKLIST_%", "blacklist_%" ],
      ban: [ "% ban%", "% perma%", "% unban%", "BAN%", "UNBAN%" ],
      kick: [ "% kick%" ],
      user: [ "%USER%" ],
      model: [ "%MODEL%" ],
      job: [ "%JOB%" ],
      weapon: [ "%WEAPON%" ],
      qmenu: [ "%QMENU%" ],
      access: [ "%ACCESS%" ],
      emoji: [ "%EMOJI%" ],
      money: [ "%addmoney%", "TECH_GANG_%" ],
      gang: [ "TECH_GANG_%" ],
      rank: [ "%setgroup%" ]
    };
    return map[group] || null;
  }
  function humanizeTechGang(actionRaw, targetRaw, detailsRaw) {
    if (!/^TECH_GANG_/i.test(actionRaw)) return null;
    let d = {};
    try {
      d = JSON.parse(detailsRaw || "{}");
    } catch (e) { console.error("catch error:", e && e.message ? e.message : e); }
    const system = d.system === "legacy" ? "gangs" : "F4";
    const target = targetRaw || `${d.system || "gang"}:${d.id || ""}`;
    const amount = Number(d.amount || 0);
    const amountText = Number.isFinite(amount) ? Math.abs(amount).toLocaleString("ru-RU") : "—";
    const signWord = amount >= 0 ? "выдал" : "забрал";
    const act = actionRaw.toUpperCase();
    let label = "Изменил банду";
    let details = `${system} · ID: ${d.id || "—"}`;
    let icon = "🛡️";
    if (act === "TECH_GANG_BANK_DELTA") {
      label = amount >= 0 ? "Выдал деньги банде" : "Забрал деньги у банды";
      icon = "💰";
      details = `${system} · ${signWord} ${amountText} ₽`;
    } else if (act === "TECH_GANG_SET_BANK") {
      label = "Установил банк банды";
      icon = "🏦";
      details = `${system} · банк: ${Number(d.amount || 0).toLocaleString("ru-RU")} ₽`;
    } else if (act === "TECH_GANG_REPUTATION_DELTA") {
      label = amount >= 0 ? "Выдал репутацию банде" : "Забрал репутацию у банды";
      icon = "⭐";
      details = `${system} · ${signWord} ${amountText} репутации`;
    } else if (act === "TECH_GANG_SET_REPUTATION") {
      label = "Установил репутацию банды";
      icon = "⭐";
      details = `${system} · репутация: ${Number(d.amount || 0).toLocaleString("ru-RU")}`;
    } else if (act === "TECH_GANG_XP_DELTA") {
      label = amount >= 0 ? "Выдал XP банде" : "Забрал XP у банды";
      icon = "📈";
      details = `${system} · ${signWord} ${amountText} XP`;
    } else if (act === "TECH_GANG_POINTS_DELTA") {
      label = amount >= 0 ? "Выдал очки банде" : "Забрал очки у банды";
      icon = "🎯";
      details = `${system} · ${signWord} ${amountText} очков`;
    } else if (act === "TECH_GANG_SET_LVL") {
      label = "Установил уровень банды";
      icon = "⬆️";
      details = `${system} · уровень: ${Number(d.amount || 0).toLocaleString("ru-RU")}`;
    } else if (act === "TECH_GANG_KICK_MEMBER") {
      label = "Выгнал игрока из банды";
      icon = "👢";
      details = `${system} · игрок: ${d.steamid64 || "—"}`;
    } else if (act === "TECH_GANG_DELETE_GANG") {
      label = "Удалил банду";
      icon = "🗑️";
      details = `${system} · банда удалена`;
    }
    return {
      label: label,
      details: details,
      target: target,
      icon: icon
    };
  }
  function fmtIdDetails(detailsRaw, labels) {
    const raw = String(detailsRaw || "").trim();
    for (const [key, label] of labels) {
      const m = raw.match(new RegExp(key + "\\s*:\\s*([^,]+)", "i"));
      if (m) return `${label}: ${m[1].trim()}`;
    }
    return raw || "—";
  }
  function humanizeKnownAction(actionRaw, targetRaw, detailsRaw) {
    const a = String(actionRaw || "").toUpperCase();
    const target = String(targetRaw || "");
    const table = {
      ADD_USER: [ "Добавил пользователя сайта", "👤", () => detailsRaw || "—" ],
      EDIT_USER: [ "Изменил пользователя сайта", "✏️", () => detailsRaw || "—" ],
      DELETE_USER: [ "Удалил пользователя сайта", "🗑️", () => detailsRaw || "—" ],
      GIVE_MODEL: [ "Выдал модель игроку", "🎭", () => fmtIdDetails(detailsRaw, [ [ "model_id", "ID модели" ] ]) ],
      REVOKE_MODEL: [ "Забрал модель у игрока", "🎭", () => fmtIdDetails(detailsRaw, [ [ "model_id", "ID модели" ] ]) ],
      GIVE_WEAPON: [ "Выдал оружие игроку", "🔫", () => fmtIdDetails(detailsRaw, [ [ "weapon_id", "ID оружия" ] ]) ],
      REVOKE_WEAPON: [ "Забрал оружие у игрока", "🔫", () => fmtIdDetails(detailsRaw, [ [ "weapon_id", "ID оружия" ] ]) ],
      GIVE_JOB: [ "Выдал профессию игроку", "💼", () => fmtIdDetails(detailsRaw, [ [ "job_id", "ID профессии" ] ]) ],
      REVOKE_JOB: [ "Забрал профессию у игрока", "💼", () => fmtIdDetails(detailsRaw, [ [ "job_id", "ID профессии" ] ]) ],
      GIVE_QMENU: [ "Выдал Q-Menu игроку", "🧰", () => String(detailsRaw || "").replace(/^type\s*:/i, "Тип:") || "—" ],
      REVOKE_QMENU: [ "Забрал Q-Menu у игрока", "🧰", () => String(detailsRaw || "").replace(/^type\s*:/i, "Тип:") || "—" ],
      SET_PLAYER_ACCESS: [ "Изменил доступы игрока", "🔑", () => String(detailsRaw || "").replace(/props_extra/i, "Доп. пропы").replace(/setmodel/i, "Доступ !setmodel") || "—" ],
      CLEAR_PLAYER_ACCESS: [ "Очистил доступы игрока", "🧹", () => "Доступы сброшены" ],
      GIVE_EMOJI: [ "Выдал эмодзи игроку", "😀", () => detailsRaw || "—" ],
      REVOKE_EMOJI: [ "Забрал эмодзи у игрока", "😀", () => "Эмодзи удалено" ],
      PROMO_CREATE: [ "Создал промокод", "🎟️", () => detailsRaw || "—" ],
      PROMO_EDIT: [ "Изменил промокод", "🎟️", () => detailsRaw || "—" ],
      PROMO_DELETE: [ "Удалил промокод", "🗑️", () => detailsRaw || "—" ],
      PROMO_TOGGLE: [ "Переключил промокод", "🎟️", () => detailsRaw || "—" ],
      BLACKLIST_ADD: [ "Занёс в ЧСП", "🚫", () => detailsRaw ? `Причина: ${detailsRaw}` : "—" ],
      BLACKLIST_REMOVE: [ "Убрал из ЧСП", "✅", () => "Игрок удалён из чёрного списка" ]
    };
    const row = table[a];
    if (!row) return null;
    return {
      label: row[0],
      icon: row[1],
      details: row[2](),
      target: target
    };
  }
  function humanizeLog(row) {
    const actionRaw = String(row.action || "");
    const detailsRaw = String(row.details || "");
    const source = detailsRaw || actionRaw;
    const parts = parseQuoted(source);
    const low = source.toLowerCase();
    let label = actionRaw;
    let details = detailsRaw;
    let target = String(row.target || "");
    let icon = "📌";
    const techGang = humanizeTechGang(actionRaw, target, detailsRaw);
    if (techGang) return techGang;
    const known = humanizeKnownAction(actionRaw, target, detailsRaw);
    if (known) return known;
    if (parts[0] === "blacklist_add") {
      label = "Занёс в ЧСП";
      icon = "🚫";
      target = parts[1] || target;
      details = parts[4] ? `Причина: ${parts[4]}` : "—";
    } else if (parts[0] === "blacklist_remove") {
      label = "Убрал из ЧСП";
      icon = "✅";
      target = parts[1] || target;
      details = "Игрок удалён из чёрного списка";
    } else if (parts[0] === "ba" && parts[1] === "ban") {
      label = "Забанил";
      icon = "🔨";
      target = parts[2] || target;
      details = `Срок: ${parts[3] || "—"}${parts[4] ? ` · Причина: ${parts[4]}` : ""}`;
    } else if (parts[0] === "ba" && parts[1] === "perma") {
      label = "Выдал перманентный бан";
      icon = "⛔";
      target = parts[2] || target;
      details = parts[3] ? `Причина: ${parts[3]}` : "—";
    } else if (parts[0] === "ba" && parts[1] === "unban") {
      label = "Разбанил";
      icon = "🟢";
      target = parts[2] || target;
      details = parts[3] ? `Причина: ${parts[3]}` : "—";
    } else if (parts[0] === "ba" && parts[1] === "kick") {
      label = "Кикнул";
      icon = "👢";
      target = parts[2] || target;
      details = parts[3] ? `Причина: ${parts[3]}` : "—";
    } else if (parts[0] === "ba" && parts[1] === "addmoney") {
      label = "Выдал деньги";
      icon = "💰";
      target = parts[2] || target;
      details = parts[3] ? `Сумма: ${Number(parts[3]).toLocaleString("ru-RU")} ₽` : "—";
    } else if (parts[0] === "ba" && parts[1] === "setgroup") {
      label = "Сменил ранг";
      icon = "🛡️";
      target = parts[2] || target;
      details = parts[3] ? `Новый ранг: ${parts[3]}` : "—";
    } else if (parts[0] === "ba" && parts[1] === "setadminmode") {
      label = "Переключил админ-мод";
      icon = "⚡";
      target = parts[2] || target;
      details = "—";
    } else {
      const map = {
        BLACKLIST_ADD: [ "Занёс в ЧСП", "🚫" ],
        BLACKLIST_REMOVE: [ "Убрал из ЧСП", "✅" ],
        ADD_USER: [ "Добавил пользователя", "👤" ],
        EDIT_USER: [ "Изменил пользователя", "✏️" ],
        DELETE_USER: [ "Удалил пользователя", "🗑️" ],
        GIVE_MODEL: [ "Выдал модель", "🎭" ],
        REVOKE_MODEL: [ "Забрал модель", "🎭" ]
      };
      const found = map[actionRaw.toUpperCase()];
      if (found) {
        label = found[0];
        icon = found[1];
      }
      if (detailsRaw && !/^ba\s|^blacklist_/i.test(detailsRaw)) details = detailsRaw;
      if (low.includes("ba ban")) {
        label = "Забанил";
        icon = "🔨";
      }
    }
    return {
      label: label,
      details: details || "—",
      target: target,
      icon: icon
    };
  }
  r.get("/api/admin_logs", authGuard, requirePerm("view_admin_logs"), async (req, res) => {
    try {
      const pool = db();
      const page = Math.max(1, parseInt(req.query.page || 1, 10));
      const perPage = Math.max(1, Math.min(100, parseInt(req.query.per_page || 50, 10)));
      const offset = (page - 1) * perPage;
      const adminFilter = String(req.query.admin || "").trim();
      const actionFilter = String(req.query.action || "").trim();
      const searchFilter = String(req.query.search || "").trim();
      const where = [];
      const params = [];
      if (adminFilter) {
        where.push("admin_steamid64 = ?");
        params.push(adminFilter);
      }
      if (actionFilter) {
        const group = actionGroupSql(actionFilter);
        if (group) {
          where.push("(" + group.map(() => "action LIKE ? OR details LIKE ?").join(" OR ") + ")");
          for (const pat of group) {
            params.push(pat, pat);
          }
        } else {
          where.push("(action LIKE ? OR details LIKE ?)");
          params.push("%" + actionFilter + "%", "%" + actionFilter + "%");
        }
      }
      if (searchFilter) {
        where.push("(target LIKE ? OR details LIKE ?)");
        params.push("%" + searchFilter + "%", "%" + searchFilter + "%");
      }
      const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
      const [[countRow]] = await pool.query(`SELECT COUNT(*) AS cnt FROM admin_logs ${whereSql}`, params);
      const total = parseInt(countRow.cnt, 10);
      const [rows] = await pool.query(`SELECT id, admin_steamid64, action, target, details, timestamp FROM admin_logs ${whereSql} ORDER BY timestamp DESC LIMIT ?, ?`, [ ...params, offset, perPage ]);
      const sidSet = new Set;
      for (const row of rows) {
        const f = String(row.admin_steamid64 || "");
        if (/^\d{17}$/.test(f)) sidSet.add(f);
      }
      const webNickBySid = new Map;
      const baNickBySid = new Map;
      if (sidSet.size) {
        const sids = [ ...sidSet ];
        const ph = sids.map(() => "?").join(",");
        try {
          const [wr] = await pool.query(`SELECT steamid64, COALESCE(nickname,'') AS nickname FROM web_users WHERE steamid64 IN (${ph})`, sids);
          for (const w of wr) if (String(w.nickname || "").trim()) webNickBySid.set(String(w.steamid64), String(w.nickname).trim());
        } catch (e) { console.error("catch error:", e && e.message ? e.message : e); }
        try {
          const [br] = await pool.query(`SELECT steamid, name FROM ba_users WHERE steamid IN (${ph})`, sids);
          for (const b of br) if (b.name) baNickBySid.set(String(b.steamid), decodeIfNeeded(b.name));
        } catch (e) { console.error("catch error:", e && e.message ? e.message : e); }
      }
      const resolveFromMaps = sidRaw => {
        const sid = String(sidRaw || "");
        if (/^\d{17}$/.test(sid)) {
          if (webNickBySid.has(sid)) return [ webNickBySid.get(sid), sid ];
          if (baNickBySid.has(sid)) return [ baNickBySid.get(sid), sid ];
          return [ sid, sid ];
        }
        return [ sid, "" ];
      };
      const logs = [];
      for (const row of rows) {
        const [adminNick, adminSid64] = resolveFromMaps(row.admin_steamid64);
        const pretty = humanizeLog(row);
        const targetRaw = String(pretty.target || row.target || "");
        let targetSid64 = "";
        if (targetRaw) {
          if (/^\d{17}$/.test(targetRaw)) targetSid64 = targetRaw; else if (targetRaw.startsWith("STEAM_")) targetSid64 = steamidToSid64(targetRaw);
        }
        logs.push({
          id: row.id,
          admin_steamid64: adminSid64 || row.admin_steamid64,
          admin_nick: adminNick,
          action: row.action,
          action_label: pretty.label,
          action_icon: pretty.icon,
          target: targetRaw,
          target_steamid64: targetSid64 || null,
          details: row.details,
          details_label: pretty.details,
          timestamp: parseInt(row.timestamp, 10),
          time_formatted: new Date(row.timestamp * 1e3).toLocaleString("ru-RU")
        });
      }
      res.json({
        ok: true,
        logs: logs,
        total: total,
        page: page,
        per_page: perPage,
        pages: Math.ceil(total / perPage)
      });
    } catch (e) {
      console.error("admin_logs error:", e.message);
      res.status(500).json({
        ok: false,
        error: "DB_ERROR"
      });
    }
  });
  return r;
}

export { adminLogsRoutes as default };
