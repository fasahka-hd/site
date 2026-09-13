import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "fs";

import { join, dirname } from "path";

import { fileURLToPath } from "url";

const BUILTIN_ROLES = {
  KP: {
    label: "KP",
    level: 100,
    builtin: true
  },
  "Управляющий": {
    label: "Управляющий",
    level: 90,
    builtin: true
  },
  "Команда Проекта": {
    label: "Команда Проекта",
    level: 80,
    builtin: true
  },
  "Главный Куратор": {
    label: "Главный Куратор",
    level: 70,
    builtin: true
  },
  "Куратор": {
    label: "Куратор",
    level: 60,
    builtin: true
  },
  "Главный Администратор": {
    label: "Главный Администратор",
    level: 50,
    builtin: true
  }
};

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data");

const ROLES_FILE = join(DATA_DIR, "roles.json");

const DEFAULT_ROLE = "Главный Администратор";

function ensureDir(p) {
  const d = dirname(p);
  if (!existsSync(d)) mkdirSync(d, {
    recursive: true
  });
}

let _rolesCache = null;

let _rolesCacheTime = 0;

let _rolesCacheMtime = 0;

const ROLES_CACHE_TTL = 3e4;

function loadCustomRoles() {
  if (!existsSync(ROLES_FILE)) return {};
  try {
    const j = JSON.parse(readFileSync(ROLES_FILE, "utf8") || "{}");
    if (!j || typeof j !== "object" || Array.isArray(j)) return {};
    const out = {};
    for (const [key, def] of Object.entries(j)) {
      const k = String(key || "").trim();
      if (!k || BUILTIN_ROLES[k]) continue;
      const label = String(def?.label || k).trim() || k;
      let level = parseInt(def?.level, 10);
      if (!Number.isFinite(level)) level = 10;
      level = Math.max(1, Math.min(99, level));
      out[k] = {
        label: label,
        level: level,
        builtin: false
      };
    }
    return out;
  } catch {
    return {};
  }
}

function saveCustomRoles(map) {
  ensureDir(ROLES_FILE);
  const out = {};
  for (const [key, def] of Object.entries(map || {})) {
    if (BUILTIN_ROLES[key]) continue;
    out[key] = {
      label: def.label,
      level: def.level
    };
  }
  writeFileSync(ROLES_FILE, JSON.stringify(out, null, 2), "utf8");
  _rolesCacheMtime = 0;
  _rolesCache = null;
  _rolesCacheTime = 0;
}

function fileMtime(p) {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

function buildRolesDef() {
  const now = Date.now();
  const rmt = fileMtime(ROLES_FILE);
  if (_rolesCache && rmt === _rolesCacheMtime) {
    _rolesCacheTime = now;
    return _rolesCache;
  }
  _rolesCacheMtime = rmt;
  const merged = {
    ...BUILTIN_ROLES,
    ...loadCustomRoles()
  };
  const sorted = Object.fromEntries(Object.entries(merged).sort((a, b) => (b[1].level || 0) - (a[1].level || 0)));
  _rolesCache = sorted;
  _rolesCacheTime = now;
  return sorted;
}

function webRolesDef() {
  return buildRolesDef();
}

function webAllowedRoles() {
  return Object.keys(buildRolesDef());
}

function webRoleLabel(role) {
  return buildRolesDef()[role]?.label || String(role);
}

function isBuiltinRole(role) {
  return !!BUILTIN_ROLES[role];
}

function webNormalizeRole(role) {
  role = String(role || "");
  if (buildRolesDef()[role]) return role;
  return DEFAULT_ROLE;
}

function addRole({key: key, label: label, level: level}) {
  key = String(key || "").trim();
  label = String(label || "").trim() || key;
  level = parseInt(level, 10);
  if (!key) return {
    ok: false,
    error: "EMPTY_KEY"
  };
  if (key.length > 64) return {
    ok: false,
    error: "KEY_TOO_LONG"
  };
  if (BUILTIN_ROLES[key]) return {
    ok: false,
    error: "ROLE_IS_BUILTIN"
  };
  const custom = loadCustomRoles();
  if (custom[key]) return {
    ok: false,
    error: "ROLE_EXISTS"
  };
  if (!Number.isFinite(level)) return {
    ok: false,
    error: "BAD_LEVEL"
  };
  if (![ 30, 60, 90 ].includes(level)) return {
    ok: false,
    error: "LEVEL_OUT_OF_RANGE"
  };
  custom[key] = {
    label: label,
    level: level,
    builtin: false
  };
  saveCustomRoles(custom);
  const perms = loadPermissions();
  if (!perms[key]) {
    perms[key] = Object.fromEntries(PERMISSION_KEYS.map(k => [ k, false ]));
    perms[key].view_players = true;
    perms[key].view_profile = true;
    savePermissions(perms);
  }
  return {
    ok: true
  };
}

function updateRole(key, {label: label, level: level}) {
  key = String(key || "").trim();
  if (BUILTIN_ROLES[key]) return {
    ok: false,
    error: "ROLE_IS_BUILTIN"
  };
  const custom = loadCustomRoles();
  if (!custom[key]) return {
    ok: false,
    error: "ROLE_NOT_FOUND"
  };
  if (label !== void 0) {
    const l = String(label || "").trim();
    if (l) custom[key].label = l;
  }
  if (level !== void 0) {
    const lv = parseInt(level, 10);
    if (!Number.isFinite(lv) || ![ 30, 60, 90 ].includes(lv)) return {
      ok: false,
      error: "BAD_LEVEL"
    };
    custom[key].level = lv;
  }
  saveCustomRoles(custom);
  return {
    ok: true
  };
}

function deleteRole(key) {
  key = String(key || "").trim();
  if (BUILTIN_ROLES[key]) return {
    ok: false,
    error: "ROLE_IS_BUILTIN"
  };
  const custom = loadCustomRoles();
  if (!custom[key]) return {
    ok: false,
    error: "ROLE_NOT_FOUND"
  };
  delete custom[key];
  saveCustomRoles(custom);
  const perms = loadPermissions();
  if (perms[key]) {
    delete perms[key];
    savePermissions(perms);
  }
  return {
    ok: true
  };
}

const PERMISSION_KEYS = [ "view_players", "view_profile", "view_bans", "view_stats", "view_blacklist", "view_admin_logs", "view_money_logs", "view_donate_logs", "view_player_donate", "manage_player_donate", "kick", "ban", "unban", "adminmode", "give_money", "set_rank", "manage_blacklist", "give_model", "manage_models", "give_weapon", "manage_weapons", "give_job", "manage_jobs", "give_qmenu", "give_access", "view_promos", "manage_promos", "manage_zbt_access", "manage_users", "manage_permissions", "raw_console" ];

const PERMISSION_GROUPS = [ {
  key: "view",
  title: "Просмотр",
  perms: [ "view_players", "view_profile", "view_bans", "view_stats", "view_blacklist", "view_admin_logs", "view_money_logs", "view_donate_logs", "view_player_donate" ]
}, {
  key: "actions",
  title: "Действия с игроками",
  perms: [ "kick", "ban", "unban", "adminmode", "give_money", "set_rank", "manage_player_donate" ]
}, {
  key: "content",
  title: "Контент и ЧСП",
  perms: [ "manage_blacklist", "give_model", "manage_models", "give_weapon", "manage_weapons", "give_job", "manage_jobs", "give_qmenu", "give_access", "view_promos", "manage_promos" ]
}, {
  key: "admin",
  title: "Администрирование (опасное)",
  perms: [ "manage_zbt_access", "manage_users", "manage_permissions", "raw_console" ]
} ];

const PERMISSION_LABELS = {
  view_players: "Список игроков",
  view_profile: "Профиль игрока",
  view_bans: "Список банов",
  view_stats: "Статистика",
  view_blacklist: "Чёрный список (ЧСП)",
  view_admin_logs: "Логи админов",
  view_money_logs: "Тех.раздел: деньги, банды, дуэли",
  view_donate_logs: "Тех.раздел: донат информация",
  view_player_donate: "Вкладка Донат в профиле",
  manage_player_donate: "Забирать/обнулять F6-инвентарь",
  kick: "Кик",
  ban: "Бан / перма",
  unban: "Разбан",
  adminmode: "Админ-мод",
  give_money: "Выдать деньги",
  set_rank: "Сменить ранг (setgroup)",
  manage_blacklist: "Управление ЧСП",
  give_model: "Выдать модель",
  manage_models: "Каталог моделей",
  give_weapon: "Выдать оружие",
  manage_weapons: "Каталог оружия",
  give_job: "Выдать профессию",
  manage_jobs: "Каталог профессий",
  give_qmenu: "Выдать Q-Menu",
  give_access: "Выдать доступы (пропы / !setmodel)",
  view_promos: "Просмотр промокодов",
  manage_promos: "Управление промокодами",
  manage_zbt_access: "Доступ ЗБТ",
  manage_users: "Пользователи сайта",
  manage_permissions: "Права рангов",
  raw_console: "Любые консольные команды (опасно)"
};

function defaultPermissions() {
  const allTrue = Object.fromEntries(PERMISSION_KEYS.map(k => [ k, true ]));
  return {
    KP: {
      ...allTrue
    },
    "Управляющий": {
      ...allTrue,
      manage_permissions: false,
      manage_zbt_access: false,
      manage_users: false,
      view_blacklist: false,
      manage_blacklist: false,
      raw_console: false
    },
    "Команда Проекта": {
      ...Object.fromEntries(PERMISSION_KEYS.map(k => [ k, false ])),
      view_players: true,
      view_profile: true,
      view_bans: true,
      view_stats: true,
      kick: true,
      ban: true,
      unban: true,
      adminmode: true,
      give_money: true,
      set_rank: true,
      give_model: true,
      give_weapon: true,
      give_job: true,
      give_qmenu: true,
      give_access: true,
      view_blacklist: true,
      manage_blacklist: true
    },
    "Главный Куратор": {
      ...Object.fromEntries(PERMISSION_KEYS.map(k => [ k, false ])),
      view_players: true,
      view_profile: true,
      view_bans: true,
      view_stats: true,
      kick: true,
      ban: true,
      unban: true,
      adminmode: true,
      set_rank: true,
      give_model: true,
      give_weapon: true,
      give_job: true,
      give_qmenu: true,
      give_access: true,
      view_blacklist: true,
      manage_blacklist: true
    },
    "Куратор": {
      ...Object.fromEntries(PERMISSION_KEYS.map(k => [ k, false ])),
      view_players: true,
      view_profile: true,
      view_bans: true,
      view_stats: true,
      kick: true,
      ban: true,
      unban: true,
      give_model: true,
      give_weapon: true,
      give_job: true,
      give_qmenu: true,
      give_access: true,
      view_blacklist: true,
      manage_blacklist: true
    },
    "Главный Администратор": {
      ...Object.fromEntries(PERMISSION_KEYS.map(k => [ k, false ])),
      view_players: true,
      view_profile: true,
      view_bans: true,
      view_stats: true,
      kick: true,
      ban: true,
      unban: true
    }
  };
}

let _permsCache = null;

let _permsCacheTime = 0;

let _permsCacheMtime = 0;

const PERMS_CACHE_TTL = 3e4;

function permsPaths() {
  return [ join(DATA_DIR, "permissions.json") ];
}

function loadPermissions() {
  const now = Date.now();
  const pmt = fileMtime(permsPaths()[0]);
  if (_permsCache && pmt === _permsCacheMtime) {
    _permsCacheTime = now;
    return _permsCache;
  }
  _permsCacheMtime = pmt;
  for (const p of permsPaths()) {
    if (!existsSync(p)) continue;
    try {
      const j = JSON.parse(readFileSync(p, "utf8") || "{}");
      if (j && typeof j === "object" && !Array.isArray(j)) {
        const roleMap = {
          manager: "Управляющий",
          team: "Команда Проекта",
          head_curator: "Главный Куратор",
          curator: "Куратор",
          head_admin: "Главный Администратор",
          root: "KP",
          sudoroot: "KP"
        };
        for (const [old, newR] of Object.entries(roleMap)) {
          if (!j[newR] && j[old] && typeof j[old] === "object") j[newR] = j[old];
        }
        _permsCache = sanitizePerms(j);
        _permsCacheTime = now;
        return _permsCache;
      }
    } catch {}
  }
  const def = defaultPermissions();
  savePermissions(def);
  return def;
}

function sanitizePerms(j) {
  const allowed = webAllowedRoles();
  const defaults = defaultPermissions();
  const out = {};
  for (const role of allowed) {
    const row = j[role] && typeof j[role] === "object" ? j[role] : {};
    const defRow = defaults[role] || {};
    const clean = {};
    for (const k of PERMISSION_KEYS) clean[k] = role === "KP" ? true : row[k] === void 0 ? Boolean(defRow[k]) : Boolean(row[k]);
    out[role] = clean;
  }
  return out;
}

function savePermissions(data) {
  if (!data || typeof data !== "object") return false;
  const out = sanitizePerms(data);
  _permsCache = out;
  _permsCacheTime = Date.now();
  for (const p of permsPaths()) {
    try {
      ensureDir(p);
      writeFileSync(p, JSON.stringify(out, null, 2), "utf8");
      _permsCacheMtime = fileMtime(p);
      return true;
    } catch {}
  }
  return false;
}

function hasPerm(role, perm) {
  if (role === "KP") return true;
  const perms = loadPermissions();
  return Boolean(perms[role]?.[perm]);
}

function getUserRole(session) {
  return session?.user?.role || null;
}

function requirePerm(perm) {
  return (req, res, next) => {
    const role = getUserRole(req.session);
    if (!role) return res.status(401).json({
      ok: false,
      error: "UNAUTHORIZED"
    });
    if (!hasPerm(role, perm)) return res.status(403).json({
      ok: false,
      error: "FORBIDDEN",
      perm: perm
    });
    next();
  };
}

function requireAnyPerm(...perms) {
  return (req, res, next) => {
    const role = getUserRole(req.session);
    if (!role) return res.status(401).json({
      ok: false,
      error: "UNAUTHORIZED"
    });
    if (perms.some(p => hasPerm(role, p))) return next();
    return res.status(403).json({
      ok: false,
      error: "FORBIDDEN"
    });
  };
}

function requireRole(requiredRole) {
  return (req, res, next) => {
    const roles = buildRolesDef();
    const userRole = getUserRole(req.session);
    const userLevel = roles[userRole]?.level || 0;
    const reqLevel = roles[requiredRole]?.level || 0;
    if (userLevel < reqLevel) return res.status(403).json({
      ok: false,
      error: "INSUFFICIENT_PRIVILEGES"
    });
    next();
  };
}

export { PERMISSION_GROUPS, PERMISSION_KEYS, PERMISSION_LABELS, addRole, deleteRole, getUserRole, hasPerm, isBuiltinRole, loadPermissions, requireAnyPerm, requirePerm, requireRole, savePermissions, updateRole, webAllowedRoles, webNormalizeRole, webRoleLabel, webRolesDef };
