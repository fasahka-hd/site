const $ = id => document.getElementById(id);

const apiStatus = $("apiStatus");

const err = $("err");

const roleListEl = $("roleList");

const permGroupsEl = $("permGroups");

const curRoleTitle = $("curRoleTitle");

const curRoleSub = $("curRoleSub");

const permEditorTools = $("permEditorTools");

const kpNotice = $("kpNotice");

const btnReload = $("reload");

const btnSave = $("save");

const addRoleBtn = $("addRoleBtn");

const addRoleForm = $("addRoleForm");

const createRoleBtn = $("createRoleBtn");

const cancelRoleBtn = $("cancelRoleBtn");

const deleteRoleBtn = $("deleteRoleBtn");

const checkAllBtn = $("checkAllBtn");

const uncheckAllBtn = $("uncheckAllBtn");

let state = null;

let selectedRole = null;

let dirty = {};

const FALLBACK_LABELS = {
  view_players: "Список игроков",
  view_profile: "Профиль игрока",
  view_bans: "Список банов",
  view_stats: "Статистика",
  view_blacklist: "Чёрный список (ЧСП)",
  view_admin_logs: "Логи админов",
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

const FALLBACK_GROUPS = [ {
  key: "view",
  title: "Просмотр",
  perms: [ "view_players", "view_profile", "view_bans", "view_stats", "view_blacklist", "view_admin_logs", "view_donate_logs", "view_player_donate" ]
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

function labelFor(key) {
  return state && state.labels && state.labels[key] || FALLBACK_LABELS[key] || key;
}

function groupsFor() {
  if (state && Array.isArray(state.groups) && state.groups.length) return state.groups;
  return FALLBACK_GROUPS;
}

function esc(s) {
  return (s ?? "").toString().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function toast(text, ok = true) {
  const wrap = $("toastWrap");
  if (!wrap) return;
  const el = document.createElement("div");
  el.className = "toast " + (ok ? "ok" : "bad");
  const t1 = document.createElement("div");
  t1.className = "toastTitle";
  t1.textContent = ok ? "OK" : "Ошибка";
  const t2 = document.createElement("div");
  t2.className = "toastText";
  t2.textContent = text;
  el.appendChild(t1);
  el.appendChild(t2);
  wrap.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transform = "translateY(-6px)";
  }, 2400);
  setTimeout(() => el.remove(), 3e3);
}

function getPerm(role, key) {
  if (role === "KP") return true;
  if (dirty[role] && key in dirty[role]) return dirty[role][key];
  return !!(state.perms[role] && state.perms[role][key]);
}

function setPerm(role, key, val) {
  if (role === "KP") return;
  dirty[role] = dirty[role] || {};
  dirty[role][key] = !!val;
}

function roleColor(level) {
  if (level >= 100) return "#06b6d4";
  if (level >= 90) return "#ef4444";
  if (level >= 60) return "#9ca3af";
  if (level >= 30) return "#6b7280";
  return "#10b981";
}

function accessTier(level) {
  level = Number(level) || 0;
  if (level >= 100) return "KP";
  if (level >= 90) return "Полный доступ";
  if (level >= 60) return "Расширенный доступ";
  return "Базовый доступ";
}

function renderRoleList() {
  roleListEl.innerHTML = "";
  let _ri = 0;
  for (const role of state.roles) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "roleItem" + (role.key === selectedRole ? " active" : "");
    item.style.setProperty("--stagger", _ri++ * 45 + "ms");
    item.dataset.role = role.key;
    const dot = document.createElement("span");
    dot.className = "roleDot";
    dot.style.background = roleColor(role.level);
    const txt = document.createElement("div");
    txt.className = "roleItemText";
    const name = document.createElement("div");
    name.className = "roleItemName";
    name.textContent = role.label || role.key;
    const meta = document.createElement("div");
    meta.className = "roleItemMeta";
    meta.textContent = (role.builtin ? "системный" : "кастомный") + " • " + accessTier(role.level);
    txt.appendChild(name);
    txt.appendChild(meta);
    item.appendChild(dot);
    item.appendChild(txt);
    if (!role.builtin) {
      const tag = document.createElement("span");
      tag.className = "roleTag";
      tag.textContent = "✎";
      tag.title = "Кастомный ранг";
      item.appendChild(tag);
    }
    item.addEventListener("click", () => selectRole(role.key));
    roleListEl.appendChild(item);
  }
}

function selectRole(key) {
  selectedRole = key;
  renderRoleList();
  renderEditor();
}

function countEnabled(role) {
  return state.keys.filter(k => getPerm(role, k)).length;
}

function renderEditor() {
  if (!selectedRole) {
    permGroupsEl.innerHTML = "";
    curRoleTitle.textContent = "Выберите ранг";
    curRoleSub.textContent = "Нажмите на ранг слева, чтобы настроить его права";
    permEditorTools.style.display = "none";
    kpNotice.style.display = "none";
    return;
  }
  const roleObj = state.roles.find(r => r.key === selectedRole);
  const isKP = selectedRole === "KP";
  curRoleTitle.textContent = roleObj ? roleObj.label || roleObj.key : selectedRole;
  curRoleSub.textContent = `${isKP ? "Системный" : roleObj && roleObj.builtin ? "Системный" : "Кастомный"} ранг • ${accessTier(roleObj?.level)} • прав включено: ${countEnabled(selectedRole)}/${state.keys.length}`;
  permEditorTools.style.display = "flex";
  kpNotice.style.display = isKP ? "block" : "none";
  deleteRoleBtn.style.display = roleObj && !roleObj.builtin ? "" : "none";
  checkAllBtn.disabled = uncheckAllBtn.disabled = isKP;
  const groups = groupsFor();
  permGroupsEl.innerHTML = "";
  let _gi = 0;
  let _ti = 0;
  for (const g of groups) {
    const card = document.createElement("div");
    card.className = "permGroup";
    card.style.setProperty("--gstagger", _gi++ * 70 + "ms");
    const head = document.createElement("div");
    head.className = "permGroupHead";
    head.textContent = g.title;
    card.appendChild(head);
    const grid = document.createElement("div");
    grid.className = "permGrid";
    for (const key of g.perms) {
      if (state.keys && state.keys.length && !state.keys.includes(key)) continue;
      const label = labelFor(key);
      const row = document.createElement("label");
      row.className = "permToggle";
      row.style.setProperty("--tstagger", Math.min(_ti++, 24) * 25 + "ms");
      const danger = key === "raw_console";
      if (danger) row.classList.add("danger");
      const info = document.createElement("div");
      info.className = "permToggleInfo";
      const t = document.createElement("div");
      t.className = "permToggleLabel";
      t.textContent = label;
      const c = document.createElement("div");
      c.className = "permToggleCode";
      c.textContent = key;
      info.appendChild(t);
      info.appendChild(c);
      const sw = document.createElement("span");
      sw.className = "switch";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = getPerm(selectedRole, key);
      cb.disabled = isKP;
      cb.dataset.permkey = key;
      const slider = document.createElement("span");
      slider.className = "slider";
      sw.appendChild(cb);
      sw.appendChild(slider);
      cb.addEventListener("change", () => {
        setPerm(selectedRole, key, cb.checked);
        curRoleSub.textContent = `${isKP ? "Системный" : roleObj && roleObj.builtin ? "Системный" : "Кастомный"} ранг • ${accessTier(roleObj?.level)} • прав включено: ${countEnabled(selectedRole)}/${state.keys.length}`;
      });
      row.appendChild(info);
      row.appendChild(sw);
      grid.appendChild(row);
    }
    card.appendChild(grid);
    permGroupsEl.appendChild(card);
  }
}

function bulkSet(val) {
  if (!selectedRole || selectedRole === "KP") return;
  for (const key of state.keys) setPerm(selectedRole, key, val);
  renderEditor();
}

async function load() {
  apiStatus.textContent = "API: загрузка...";
  err.style.display = "none";
  try {
    const r = await fetch(`./api/permissions?_=${Date.now()}`, {
      cache: "no-store",
      credentials: "include"
    });
    const data = await r.json().catch(() => null);
    if (!r.ok || !data || !data.ok) throw new Error(data?.error || "HTTP " + r.status);
    state = data;
    dirty = {};
    if (!selectedRole || !state.roles.some(x => x.key === selectedRole)) {
      selectedRole = state.roles[0]?.key || null;
    }
    apiStatus.textContent = "API: OK";
    renderRoleList();
    renderEditor();
  } catch (e) {
    apiStatus.textContent = "API: ошибка";
    err.textContent = "Ошибка: " + (e?.message || e);
    err.style.display = "";
  }
}

function buildFullPerms() {
  const out = {};
  for (const role of state.roles) {
    out[role.key] = {};
    for (const key of state.keys) {
      out[role.key][key] = getPerm(role.key, key);
    }
  }
  return out;
}

async function save() {
  if (!state) return;
  apiStatus.textContent = "API: сохранение...";
  err.style.display = "none";
  try {
    const r = await fetch("./api/permissions", {
      method: "POST",
      cache: "no-store",
      credentials: "include",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        perms: buildFullPerms()
      })
    });
    const data = await r.json().catch(() => null);
    if (!r.ok || !data || !data.ok) throw new Error(data?.error || "HTTP " + r.status);
    apiStatus.textContent = "API: сохранено";
    toast("Права сохранены");
    dirty = {};
    await load();
    if (typeof checkUserRole === "function") await checkUserRole();
  } catch (e) {
    apiStatus.textContent = "API: ошибка";
    err.textContent = "Ошибка сохранения: " + (e?.message || e);
    err.style.display = "";
    toast("Ошибка сохранения", false);
  }
}

const ROLE_ERRORS = {
  EMPTY_KEY: "Укажите название ранга",
  KEY_TOO_LONG: "Слишком длинное название",
  ROLE_EXISTS: "Такой ранг уже существует",
  ROLE_IS_BUILTIN: "Это системный ранг",
  BAD_LEVEL: "Некорректный уровень",
  LEVEL_OUT_OF_RANGE: "Выберите один из 3 уровней доступа",
  ROLE_NOT_FOUND: "Ранг не найден",
  CANNOT_DELETE_OWN_ROLE: "Нельзя удалить свой собственный ранг"
};

async function createRole() {
  const key = ($("newRoleKey").value || "").trim();
  const level = parseInt(($("newRoleLevel").value || "").trim(), 10);
  if (!key) return toast("Укажите название ранга", false);
  if (![ 30, 60, 90 ].includes(level)) return toast("Выберите один из 3 уровней доступа", false);
  createRoleBtn.disabled = true;
  try {
    const r = await fetch("./api/roles", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        key: key,
        label: key,
        level: level
      })
    });
    const data = await r.json().catch(() => null);
    if (!r.ok || !data || !data.ok) throw new Error(ROLE_ERRORS[data?.error] || data?.error || "HTTP " + r.status);
    toast("Ранг создан");
    $("newRoleKey").value = "";
    $("newRoleLevel").value = "30";
    addRoleForm.style.display = "none";
    selectedRole = key;
    await load();
  } catch (e) {
    toast(e.message || "Ошибка", false);
  } finally {
    createRoleBtn.disabled = false;
  }
}

async function removeRole() {
  if (!selectedRole) return;
  const roleObj = state.roles.find(r => r.key === selectedRole);
  if (!roleObj || roleObj.builtin) return toast("Системный ранг удалить нельзя", false);
  const ok = window.UI && UI.confirm ? await UI.confirm({
    title: "Удалить ранг?",
    text: `Ранг «${roleObj.label || selectedRole}» будет удалён безвозвратно.`,
    okText: "Удалить",
    danger: true,
    icon: "🛡️"
  }) : confirm(`Удалить ранг «${roleObj.label || selectedRole}»? Это действие необратимо.`);
  if (!ok) return;
  try {
    const r = await fetch("./api/roles?key=" + encodeURIComponent(selectedRole), {
      method: "DELETE",
      credentials: "include"
    });
    const data = await r.json().catch(() => null);
    if (!r.ok || !data || !data.ok) throw new Error(ROLE_ERRORS[data?.error] || data?.error || "HTTP " + r.status);
    toast("Ранг удалён");
    selectedRole = null;
    await load();
  } catch (e) {
    toast(e.message || "Ошибка", false);
  }
}

addRoleBtn?.addEventListener("click", () => {
  const willShow = addRoleForm.style.display === "none";
  addRoleForm.style.display = willShow ? "block" : "none";
  if (willShow) {
    const k = document.getElementById("newRoleKey");
    if (k) setTimeout(() => {
      try {
        k.focus();
      } catch (e) {}
    }, 60);
  }
});

cancelRoleBtn?.addEventListener("click", () => {
  addRoleForm.style.display = "none";
});

createRoleBtn?.addEventListener("click", createRole);

deleteRoleBtn?.addEventListener("click", removeRole);

checkAllBtn?.addEventListener("click", () => bulkSet(true));

uncheckAllBtn?.addEventListener("click", () => bulkSet(false));

btnReload?.addEventListener("click", () => {
  dirty = {};
  load();
});

btnSave?.addEventListener("click", save);

document.addEventListener("DOMContentLoaded", async () => {
  if (typeof requireAuth === "function") await requireAuth();
  await load();
});
