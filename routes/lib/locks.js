import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "fs";

import { join, dirname } from "path";

import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DATA_DIR = join(__dirname, "..", "data");

const LOCKS_FILE = join(DATA_DIR, "locks.json");

export const LOCKABLE_PAGES = [ {
  key: "index.html",
  label: "Игроки",
  perm: "view_players"
}, {
  key: "bans.html",
  label: "Баны",
  perm: "view_bans"
}, {
  key: "stats.html",
  label: "Статистика",
  perm: "view_stats"
}, {
  key: "admin_logs.html",
  label: "Логи админов",
  perm: "view_admin_logs"
}, {
  key: "blacklist.html",
  label: "Чёрный список проекта",
  perm: "view_blacklist"
}, {
  key: "promos.html",
  label: "Промокоды",
  perm: "view_promos"
}, {
  key: "zbt_access.html",
  label: "Доступ ЗБТ",
  perm: "manage_zbt_access"
}, {
  key: "manage.html",
  label: "Управление",
  perm: "manage_users"
}, {
  key: "add_user.html",
  label: "Пользователи",
  perm: "manage_users"
}, {
  key: "permissions.html",
  label: "Права рангов",
  perm: "manage_permissions"
}, {
  key: "tech_money.html",
  label: "Тех.Раздел: деньги",
  perm: "view_money_logs"
}, {
  key: "tech_general.html",
  label: "Тех.Раздел: общий раздел",
  perm: "view_money_logs"
}, {
  key: "tech_gangs.html",
  label: "Тех.Раздел: банды",
  perm: "view_money_logs"
}, {
  key: "tech_duels.html",
  label: "Тех.Раздел: дуэли",
  perm: "view_money_logs"
}, {
  key: "tech_donate.html",
  label: "Тех.Раздел: донат",
  perm: "view_donate_logs"
}, {
  key: "player.html",
  label: "Профиль игрока",
  perm: "view_profile"
}, {
  key: "emoji.html",
  label: "Эмодзи",
  perm: null
}, {
  key: "locks.html",
  label: "Блокировки (KP)",
  perm: null
} ];

export const API_ACTION_MAP = [ {
  method: "POST",
  test: /^\/api\/bans\/?$/i,
  perm: "ban"
}, {
  method: "POST",
  test: /^\/api\/bans\/unban/i,
  perm: "unban"
}, {
  method: "DELETE",
  test: /^\/api\/bans\/?$/i,
  perm: "unban"
}, {
  method: "POST",
  test: /^\/api\/kick\/?$/i,
  perm: "kick"
}, {
  method: "POST",
  test: /^\/api\/adminmode\/?$/i,
  perm: "adminmode"
}, {
  method: "POST",
  test: /^\/api\/give_money\/?$/i,
  perm: "give_money"
}, {
  method: "POST",
  test: /^\/api\/set_rank\/?$/i,
  perm: "set_rank"
}, {
  method: "POST",
  test: /^\/api\/chsp_action\/?$/i,
  perm: "manage_blacklist"
}, {
  method: "POST",
  test: /^\/api\/blacklist\/?$/i,
  perm: "manage_blacklist"
}, {
  method: "PUT",
  test: /^\/api\/blacklist\/?$/i,
  perm: "manage_blacklist"
}, {
  method: "DELETE",
  test: /^\/api\/blacklist\/?$/i,
  perm: "manage_blacklist"
}, {
  method: "POST",
  test: /^\/api\/players\/[^/]+\/model\/?$/i,
  perm: "give_model"
}, {
  method: "DELETE",
  test: /^\/api\/players\/[^/]+\/model\/?$/i,
  perm: "manage_models"
}, {
  method: "POST",
  test: /^\/api\/players\/[^/]+\/weapon\/?$/i,
  perm: "give_weapon"
}, {
  method: "DELETE",
  test: /^\/api\/players\/[^/]+\/weapon\/?$/i,
  perm: "manage_weapons"
}, {
  method: "POST",
  test: /^\/api\/players\/[^/]+\/job\/?$/i,
  perm: "give_job"
}, {
  method: "DELETE",
  test: /^\/api\/players\/[^/]+\/job\/?$/i,
  perm: "manage_jobs"
}, {
  method: "POST",
  test: /^\/api\/players\/[^/]+\/qmenu\/?$/i,
  perm: "give_qmenu"
}, {
  method: "POST",
  test: /^\/api\/players\/[^/]+\/kick\/?$/i,
  perm: "kick"
}, {
  method: "POST",
  test: /^\/api\/players\/[^/]+\/ban\/?$/i,
  perm: "ban"
}, {
  method: "POST",
  test: /^\/api\/players\/[^/]+\/unban\/?$/i,
  perm: "unban"
}, {
  method: "POST",
  test: /^\/api\/models\/?$/i,
  perm: "manage_models"
}, {
  method: "PUT",
  test: /^\/api\/models\/?$/i,
  perm: "manage_models"
}, {
  method: "DELETE",
  test: /^\/api\/models\/?$/i,
  perm: "manage_models"
}, {
  method: "POST",
  test: /^\/api\/weapons\/?$/i,
  perm: "manage_weapons"
}, {
  method: "PUT",
  test: /^\/api\/weapons\/?$/i,
  perm: "manage_weapons"
}, {
  method: "DELETE",
  test: /^\/api\/weapons\/?$/i,
  perm: "manage_weapons"
}, {
  method: "POST",
  test: /^\/api\/jobs\/?$/i,
  perm: "manage_jobs"
}, {
  method: "PUT",
  test: /^\/api\/jobs\/?$/i,
  perm: "manage_jobs"
}, {
  method: "DELETE",
  test: /^\/api\/jobs\/?$/i,
  perm: "manage_jobs"
}, {
  method: "POST",
  test: /^\/api\/commands\/?$/i,
  perm: "manage_commands"
}, {
  method: "POST",
  test: /^\/api\/users\/?$/i,
  perm: "manage_users"
}, {
  method: "PUT",
  test: /^\/api\/users\/?$/i,
  perm: "manage_users"
}, {
  method: "DELETE",
  test: /^\/api\/users\/?$/i,
  perm: "manage_users"
}, {
  method: "POST",
  test: /^\/api\/player_access\/?$/i,
  perm: "give_access"
}, {
  method: "POST",
  test: /^\/api\/zbt_access\/?$/i,
  perm: "manage_zbt_access"
}, {
  method: "PUT",
  test: /^\/api\/zbt_access\/?$/i,
  perm: "manage_zbt_access"
}, {
  method: "DELETE",
  test: /^\/api\/zbt_access\/?$/i,
  perm: "manage_zbt_access"
}, {
  method: "POST",
  test: /^\/api\/promos\/?$/i,
  perm: "manage_promos"
}, {
  method: "PUT",
  test: /^\/api\/promos\/?$/i,
  perm: "manage_promos"
}, {
  method: "DELETE",
  test: /^\/api\/promos\/?$/i,
  perm: "manage_promos"
}, {
  method: "POST",
  test: /^\/api\/permissions\/?$/i,
  perm: "manage_permissions"
}, {
  method: "PUT",
  test: /^\/api\/permissions\/?$/i,
  perm: "manage_permissions"
}, {
  method: "GET",
  test: /^\/api\/money_logs\/?$/i,
  perm: "view_money_logs"
}, {
  method: "GET",
  test: /^\/api\/donate_logs\/?$/i,
  perm: "view_donate_logs"
}, {
  method: "GET",
  test: /^\/api\/tech_gangs\/?$/i,
  perm: "view_money_logs"
}, {
  method: "GET",
  test: /^\/api\/tech_gangs\/detail\/?$/i,
  perm: "view_money_logs"
}, {
  method: "POST",
  test: /^\/api\/tech_gangs\/action\/?$/i,
  perm: "view_money_logs"
}, {
  method: "POST",
  test: /^\/api\/emojis\/?$/i,
  perm: "manage_emojis"
} ];

function ensureDir(p) {
  const d = dirname(p);
  if (!existsSync(d)) mkdirSync(d, {
    recursive: true
  });
}

function defaults() {
  return {
    permissions_others: {},
    permissions_self: {},
    pages_others: {},
    pages_self: {},
    note: "",
    updated_at: 0,
    updated_by: ""
  };
}

let _cache = null;

let _cacheTime = 0;

let _cacheMtime = 0;

const CACHE_TTL = 3e4;

function locksPaths() {
  return [ LOCKS_FILE ];
}

function readFromDisk() {
  for (const p of locksPaths()) {
    try {
      if (!existsSync(p)) continue;
      const raw = readFileSync(p, "utf8") || "{}";
      const j = JSON.parse(raw);
      return normalize(j);
    } catch (e) {}
  }
  return defaults();
}

function normalize(j) {
  const out = defaults();
  if (!j || typeof j !== "object") return out;
  const oldPerms = j.permissions && typeof j.permissions === "object" ? j.permissions : null;
  const oldPages = j.pages && typeof j.pages === "object" ? j.pages : null;
  const oldMode = j.mode === "others" ? "others" : "all";
  function copyBoolMap(src, dst) {
    if (!src || typeof src !== "object") return;
    for (const [k, v] of Object.entries(src)) dst[String(k)] = !!v;
  }
  copyBoolMap(j.permissions_others, out.permissions_others);
  copyBoolMap(j.permissions_self, out.permissions_self);
  copyBoolMap(j.pages_others, out.pages_others);
  copyBoolMap(j.pages_self, out.pages_self);
  if (oldPerms && !Object.keys(out.permissions_others).length && !Object.keys(out.permissions_self).length) {
    copyBoolMap(oldPerms, out.permissions_others);
    if (oldMode === "all") copyBoolMap(oldPerms, out.permissions_self);
  }
  if (oldPages && !Object.keys(out.pages_others).length && !Object.keys(out.pages_self).length) {
    copyBoolMap(oldPages, out.pages_others);
    if (oldMode === "all") copyBoolMap(oldPages, out.pages_self);
  }
  out.note = String(j.note || "").slice(0, 200);
  out.updated_at = parseInt(j.updated_at || 0, 10) || 0;
  out.updated_by = String(j.updated_by || "").slice(0, 64);
  return out;
}

function writeToDisk(data) {
  const out = normalize(data);
  let written = false;
  for (const p of locksPaths()) {
    try {
      ensureDir(p);
      writeFileSync(p, JSON.stringify(out, null, 2), "utf8");
      written = true;
      break;
    } catch (e) {}
  }
  if (written) {
    _cache = out;
    _cacheMtime = locksMtime();
    _cacheTime = Date.now();
  }
  return written;
}

function locksMtime() {
  for (const p of locksPaths()) {
    try {
      return statSync(p).mtimeMs;
    } catch {}
  }
  return 0;
}

export function loadLocks() {
  const now = Date.now();
  const mtime = locksMtime();
  if (_cache && mtime && mtime === _cacheMtime) {
    _cacheTime = now;
    return _cache;
  }
  _cache = readFromDisk();
  _cacheTime = now;
  _cacheMtime = mtime;
  return _cache;
}

export function saveLocks(data) {
  return writeToDisk(data);
}

function isSelf(user) {
  return !!(user && user.role === "KP");
}

export function isPermLockedFor(user, permKey) {
  if (!permKey) return false;
  const l = loadLocks();
  return isSelf(user) ? !!l.permissions_self[permKey] : !!l.permissions_others[permKey];
}

export function isPageLockedFor(user, pageKey) {
  if (!pageKey) return false;
  const l = loadLocks();
  return isSelf(user) ? !!l.pages_self[pageKey] : !!l.pages_others[pageKey];
}

export function isPermLocked(permKey) {
  return isPermLockedFor(null, permKey);
}

export function isPageLocked(pageKey) {
  return isPageLockedFor(null, pageKey);
}

export function getMode() {
  return "split";
}

export function lockAppliesTo(_user) {
  return true;
}

const COMMAND_PATTERNS = [ {
  perm: "kick",
  pattern: /^ba kick\b/
}, {
  perm: "ban",
  pattern: /^ba (ban|perma)\b/
}, {
  perm: "unban",
  pattern: /^ba unban\b/
}, {
  perm: "adminmode",
  pattern: /^ba setadminmode\b/
}, {
  perm: "give_money",
  pattern: /^ba addmoney\b/
}, {
  perm: "set_rank",
  pattern: /^ba setgroup\b/
}, {
  perm: "manage_blacklist",
  pattern: /^blacklist_(add|addip|remove|removeip)\b/
}, {
  perm: "give_model",
  pattern: /^(addmodel|removemodel)\b/
}, {
  perm: "give_weapon",
  pattern: /^(giveweapon|removeweapon)\b/
}, {
  perm: "give_job",
  pattern: /^(givejob|removejob)\b/
}, {
  perm: "give_qmenu",
  pattern: /^(giveqmenu|removeqmenu)\b/
}, {
  perm: "give_access",
  pattern: /^(panel_setprops|panel_setmodelaccess)\b/
}, {
  perm: "manage_player_donate",
  pattern: /^ba adddonate\b/
}, {
  perm: "manage_player_donate",
  pattern: /^ba (removedonate|takedonate|del_donate)\b/
}, {
  perm: "manage_promos",
  pattern: /^promo_/
}, {
  perm: "manage_player_donate",
  pattern: /^igs_(delete_inventory_item|clear_inventory)\b/
} ];

function resolveCommandTextPerm(text) {
  const t = String(text || "").replace(/\s+/g, " ").toLowerCase().trim();
  for (const {perm: perm, pattern: pattern} of COMMAND_PATTERNS) {
    if (pattern.test(t)) return perm;
  }
  return null;
}

export function resolveActionPerm(method, path, body) {
  const m = String(method || "").toUpperCase();
  if (m === "POST" && /^\/api\/command\/?$/i.test(path || "")) {
    return resolveCommandTextPerm(body && body.text);
  }
  for (const rule of API_ACTION_MAP) {
    if (rule.method !== m) continue;
    if (rule.test.test(path)) return rule.perm;
  }
  return null;
}

export function publicLocksSnapshot(user) {
  const l = loadLocks();
  const self = isSelf(user);
  return {
    ok: true,
    mode: "split",
    note: l.note,
    updated_at: l.updated_at,
    updated_by: l.updated_by,
    permissions: self ? l.permissions_self : l.permissions_others,
    pages: self ? l.pages_self : l.pages_others,
    permissions_others: l.permissions_others,
    permissions_self: l.permissions_self,
    pages_others: l.pages_others,
    pages_self: l.pages_self,
    applies_to_me: true,
    i_am_kp: !!(user && user.role === "KP")
  };
}
