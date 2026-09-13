const PAGE_LABELS = {
  "/": "Игроки",
  "/bans": "Баны",
  "/stats": "Статистика",
  "/admin-logs": "Логи админов",
  "/blacklist": "Чёрный список проекта",
  "/zbt-access": "Доступ ЗБТ",
  "/manage/users": "Пользователи",
  "/manage/permissions": "Права рангов",
  "/player": "Профиль игрока",
  "/manage/locks": "Блокировки",
  "/manage": "Управление",
  "/tech/money": "Операции с деньгами",
  "/tech/gangs": "Общий раздел",
  "/tech/gangs/list": "Банды",
  "/tech/duels": "Дуэли",
  "/tech/donate": "Донат информация",
  "/emoji": "Эмодзи",
  "/tech/general": "Общий раздел"
};

function pageLabel(key) {
  return PAGE_LABELS[key] || (key || "").replace(/\.html$/i, "");
}

(function hideGatedEarly() {
  try {
    const s = document.createElement("style");
    s.id = "perm-gate-early";
    s.textContent = "[data-perm]:not(.perm-allowed),[data-manage-hub]:not(.perm-allowed),[data-role-only]:not(.perm-allowed),.techNavTitle:not(.perm-allowed),.navSectionTitle:not(.perm-allowed){display:none !important} html.perms-ready .navItem.perm-allowed{display:flex !important} html.perms-ready .tabBtn.perm-allowed, html.perms-ready .btn.perm-allowed{display:inline-flex !important} html.perms-ready .row[data-perm].perm-allowed{display:grid !important}";
    document.head ? document.head.appendChild(s) : document.documentElement.appendChild(s);
    document.documentElement.classList.add("perms-loading");
  } catch (e) {}
})();

(function initRoleClasses() {
  try {
    const root = document.documentElement;
    if (!root.classList.contains("role-loading")) root.classList.add("role-loading");
  } catch (e) {}
})();

function sanitizePerms(raw) {
  const clean = Object.create(null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return clean;
  const FORBIDDEN = [ "__proto__", "constructor", "prototype" ];
  for (const key of Object.getOwnPropertyNames(raw)) {
    if (FORBIDDEN.indexOf(key) !== -1) continue;
    const v = raw[key];
    if (v === null || typeof v !== "object") clean[key] = v;
  }
  return clean;
}

(function applyCachedPermsEarly() {
  try {
    const cachedRole = sessionStorage.getItem("arizona_role");
    const cachedPerms = sessionStorage.getItem("arizona_perms");
    const cachedVer = sessionStorage.getItem("arizona_perms_v");
    const PERMS_VERSION = "2";
    if (cachedVer !== PERMS_VERSION) {
      try {
        sessionStorage.removeItem("arizona_role");
        sessionStorage.removeItem("arizona_perms");
      } catch (e) {}
      sessionStorage.setItem("arizona_perms_v", PERMS_VERSION);
      return;
    }
    if (cachedRole) {
      try {
        window.__EARLY_ROLE = cachedRole;
      } catch (e) {}
    }
    if (cachedPerms) {
      try {
        window.__PERMS = sanitizePerms(JSON.parse(cachedPerms));
        if (document.readyState === "loading") {
          document.addEventListener("DOMContentLoaded", () => {
            try {
              applyPerms(window.__PERMS);
            } catch (e) {}
          }, {
            once: true
          });
        } else {
          applyPerms(window.__PERMS);
        }
      } catch (e) {}
    }
  } catch (e) {}
})();

function roleSlug(role) {
  role = (role || "").toString();
  if (role === "KP") return "KP";
  return "r_" + encodeURIComponent(role).replace(/%/g, "_").replace(/[^a-zA-Z0-9_]/g, "_");
}

function applyRoleClass(role) {
  try {
    const root = document.documentElement;
    [ ...root.classList ].forEach(c => {
      if (c.startsWith("role-")) root.classList.remove(c);
    });
    root.classList.remove("role-loading");
    const slug = roleSlug(role || "");
    if (slug) root.classList.add("role-" + slug);
  } catch (e) {}
}

function applyPerms(perms) {
  try {
    const root = document.documentElement;
    root.classList.remove("perms-loading");
    root.classList.add("perms-ready");
    window.__PERMS = perms || {};
    const permAllowed = v => {
      if (v === true) return true;
      if (v === 1 || v === "1") return true;
      if (typeof v === "string") {
        const s = v.trim().toLowerCase();
        if (s === "true" || s === "yes" || s === "y") return true;
        if (s === "false" || s === "0" || s === "no" || s === "") return false;
      }
      return false;
    };
    const setVisible = (el, allowed) => {
      if (!el) return;
      el.classList.toggle("perm-allowed", !!allowed);
      if (allowed) {
        el.style.removeProperty("display");
        const cs = window.getComputedStyle(el);
        if (cs.display === "none") {
          if (el.classList.contains("navItem")) el.style.display = "block"; else if (el.classList.contains("btn") || el.classList.contains("tabBtn")) el.style.display = "inline-flex"; else if (el.classList.contains("row")) el.style.display = "grid"; else if (el.tagName === "TR") el.style.display = "table-row"; else if (el.tagName === "TD" || el.tagName === "TH") el.style.display = "table-cell"; else el.style.display = "block";
        }
      } else {
        el.style.display = "none";
      }
      el.setAttribute("aria-hidden", allowed ? "false" : "true");
    };
    document.querySelectorAll("[data-perm]").forEach(el => {
      const key = el.getAttribute("data-perm");
      const allowed = permAllowed(perms && perms[key]);
      setVisible(el, allowed);
    });
    document.querySelectorAll("[data-perm-disable]").forEach(el => {
      const key = el.getAttribute("data-perm-disable");
      const allowed = permAllowed(perms && perms[key]);
      if (!el.dataset.origText) {
        el.dataset.origText = (el.textContent || "").trim();
      }
      el.disabled = !allowed;
      if (!allowed) {
        el.style.opacity = "0.55";
        el.style.cursor = "not-allowed";
        const noTxt = el.getAttribute("data-no-perm-text");
        if (noTxt) el.textContent = noTxt;
      } else {
        el.style.opacity = "";
        el.style.cursor = "";
        if (el.dataset.origText) el.textContent = el.dataset.origText;
      }
    });
    const role = window.__ME && window.__ME.role || (window.__EARLY_ROLE || "");
    document.querySelectorAll("[data-role-only]").forEach(el => {
      const need = el.getAttribute("data-role-only");
      const ok = !!(need && need === role);
      setVisible(el, ok);
    });
    const canManage = role === "KP" || permAllowed(perms && perms.manage_users) || permAllowed(perms && perms.manage_permissions);
    document.querySelectorAll("[data-manage-hub]").forEach(el => {
      setVisible(el, canManage);
    });
    const hasTech = permAllowed(perms && perms.view_money_logs) || permAllowed(perms && perms.view_donate_logs) || role === "KP";
    document.querySelectorAll(".techNavTitle, .navSectionTitle").forEach(el => {
      if (el.textContent && el.textContent.toLowerCase().includes("тех")) {
        setVisible(el, hasTech);
      }
    });
    try {
      window.dispatchEvent(new CustomEvent("perms:updated", {
        detail: perms || {}
      }));
    } catch (e) {}
  } catch (e) {
    console.error("applyPerms error", e);
  }
}

function hasPerm(key) {
  const perms = window.__PERMS || {};
  const v = perms ? perms[key] : false;
  if (v === true) return true;
  if (v === 1 || v === "1") return true;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true" || s === "yes" || s === "y") return true;
    return false;
  }
  return false;
}

async function requireAuth() {
  const r = await fetch("./api/me", {
    cache: "no-store",
    credentials: "include"
  });
  if (!r.ok) {
    location.href = "/login";
    throw new Error("NOT_AUTH");
  }
  return r.json();
}

async function doLogout() {
  try {
    sessionStorage.removeItem("arizona_role");
    sessionStorage.removeItem("arizona_perms");
    sessionStorage.removeItem("arizona_perms_v");
  } catch (e) {}
  await fetch("./api/logout", {
    method: "POST",
    cache: "no-store",
    credentials: "include"
  }).catch(() => {});
  location.href = "/login";
}

document.addEventListener("click", e => {
  const t = e.target;
  if (t && t.id === "logoutBtn") {
    e.preventDefault();
    doLogout();
  }
});

async function checkUserRole() {
  try {
    const r = await fetch("./api/me", {
      cache: "no-store",
      credentials: "include"
    });
    if (!r.ok) return null;
    const data = await r.json();
    if (!data.ok) return null;
    const role = data.user?.role || "user";
    window.__ME = data.user || {};
    try {
      sessionStorage.setItem("arizona_role", role);
      sessionStorage.setItem("arizona_perms_v", "2");
    } catch (e) {}
    applyRoleClass(role);
    applyPerms(data.perms || {});
    return role;
  } catch (error) {
    return null;
  }
}

async function checkPageAccess(requiredPerm) {
  const role = await checkUserRole();
  if (!role) {
    location.href = "/login";
    return false;
  }
  if (!hasPerm(requiredPerm)) {
    location.href = "/";
    return false;
  }
  return true;
}

function currentPageKey() {
  const path = (window.location.pathname || "/").replace(/\/+$/, "") || "/";
  const map = {
    "/": "index.html",
    "/players": "index.html",
    "/bans": "bans.html",
    "/stats": "stats.html",
    "/admin-logs": "admin_logs.html",
    "/blacklist": "blacklist.html",
    "/promos": "promos.html",
    "/zbt-access": "zbt_access.html",
    "/manage": "manage.html",
    "/manage/users": "add_user.html",
    "/manage/locks": "locks.html",
    "/manage/permissions": "permissions.html",
    "/tech/money": "tech_money.html",
    "/tech/gangs": "tech_gangs.html",
    "/tech/donate": "tech_donate.html",
    "/player": "player.html",
    "/login": "login.html"
  };
  if (map[path]) return map[path];
  const file = path.split("/").pop() || "index.html";
  return file.includes(".") ? file : "";
}

function goLogin() {
  if ((window.location.pathname || "") === "/login" || (window.location.pathname || "").endsWith("/login.html")) return;
  location.href = "/login";
}

function applyCachedPerms() {
  if (window.__EARLY_ROLE) applyRoleClass(window.__EARLY_ROLE);
  if (window.__PERMS) applyPerms(window.__PERMS);
}

if (document.readyState !== "loading" && window.__PERMS) {
  applyCachedPerms();
}

document.addEventListener("DOMContentLoaded", async () => {
  const path = (window.location.pathname || "/").replace(/\/+$/, "") || "/";
  if (document.readyState === "loading" || !window.__PERMS) {
    applyCachedPerms();
  }
  if (path === "/login" || path.endsWith("/login.html")) return;
  const me = await checkUserRole();
  if (!me) {
    goLogin();
    return;
  }
  const deny = () => {
    location.href = "/";
  };
  const role = window.__ME && window.__ME.role || me;
  if ((path === "/" || path === "/players" || path.endsWith("/index.html")) && !hasPerm("view_players")) return goLogin();
  if (path === "/manage/users" && !hasPerm("manage_users")) return deny();
  if (path === "/manage" && !(hasPerm("manage_users") || hasPerm("manage_permissions") || role === "KP")) return deny();
  if (path === "/tech/money" && !hasPerm("view_money_logs")) return deny();
  if (path === "/tech/gangs" && !hasPerm("view_money_logs")) return deny();
  if (path === "/tech/gangs/list" && !hasPerm("view_money_logs")) return deny();
  if (path === "/tech/duels" && !hasPerm("view_money_logs")) return deny();
  if (path === "/tech/donate" && !hasPerm("view_donate_logs")) return deny();
  if (path === "/zbt-access" && !hasPerm("manage_zbt_access")) return deny();
  if (path === "/admin-logs" && !hasPerm("view_admin_logs")) return deny();
  if (path === "/blacklist" && !hasPerm("view_blacklist")) return deny();
  if (path === "/manage/permissions" && !hasPerm("manage_permissions")) return deny();
  if (path === "/bans" && !hasPerm("view_bans")) return deny();
  if (path === "/stats" && !hasPerm("view_stats")) return deny();
  if (path === "/player" && !hasPerm("view_profile")) return deny();
  if (path === "/manage/locks" && role !== "KP") return deny();
  try {
    const r = await fetch("/api/locks/state", {
      cache: "no-store",
      credentials: "include"
    });
    if (r.status === 401) return goLogin();
    if (r.ok) {
      const state = await r.json();
      const pageFile = currentPageKey();
      if (state && state.ok && state.applies_to_me && state.pages && pageFile && state.pages[pageFile]) {
        try {
          if (window.UI && window.UI.toast) {
            window.UI.toast({
              title: "Заблокировано KP",
              text: "Раздел «" + pageLabel(pageFile) + "» сейчас в активном редактировании.",
              icon: "🔒",
              duration: 4500
            });
          }
        } catch (e) {}
        setTimeout(() => {
          location.href = "/";
        }, 800);
      }
    }
  } catch (e) {}
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    fetch("./api/me", {
      cache: "no-store",
      credentials: "include"
    }).catch(() => {});
  }
});

window.hasPerm = hasPerm;

window.applyPerms = applyPerms;
