(function() {
  "use strict";
  const POLL_MS = 8e3;
  const TOAST_TEXT = "Находится в активном редактировании.";
  const TOAST_TITLE = "Заблокировано KP";
  const ROUTE_TO_PAGE = {
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
    "/manage/permissions": "permissions.html",
    "/manage/locks": "locks.html",
    "/tech/money": "tech_money.html",
    "/tech/gangs": "tech_gangs.html",
    "/player": "player.html"
  };
  const PAGE_TO_ROUTE = Object.fromEntries(Object.entries(ROUTE_TO_PAGE).map(([route, page]) => [ page, route ]));
  PAGE_TO_ROUTE["index.html"] = "/";
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
    "/tech/money": "Операции с деньгами",
    "/tech/gangs": "Общий раздел",
    "/tech/gangs/list": "Банды",
    "/tech/duels": "Дуэли",
    "/emoji": "Эмодзи",
    "/tech/general": "Общий раздел",
    "tech_money.html": "Операции с деньгами",
    "tech_gangs.html": "Общий раздел",
    "tech_gangs_list.html": "Банды",
    "tech_duels.html": "Дуэли",
    "emoji.html": "Эмодзи"
  };
  function pageLabel(key) {
    return PAGE_LABELS[key] || (key || "").replace(/\.html$/i, "");
  }
  let _state = null;
  let _lastShownAt = 0;
  let _pollTimer = null;
  let _currentPageKey = null;
  function getCurrentPageKey() {
    try {
      const p = (window.location.pathname || "/").replace(/\/+$/, "") || "/";
      if (ROUTE_TO_PAGE[p]) return ROUTE_TO_PAGE[p];
      const file = p.split("/").pop() || "";
      if (!file || !/\.html$/.test(file)) return null;
      return file;
    } catch (e) {
      return null;
    }
  }
  function safeToast(opts) {
    try {
      if (window.UI && typeof window.UI.toast === "function") {
        window.UI.toast(opts);
        return true;
      }
    } catch (e) {}
    try {
      let wrap = document.getElementById("toastWrap");
      if (!wrap) {
        wrap = document.createElement("div");
        wrap.id = "toastWrap";
        wrap.className = "toastWrap";
        document.body.appendChild(wrap);
      }
      const el = document.createElement("div");
      el.className = "toast uiToast bad";
      el.innerHTML = '<div class="uiToastIcon">✕</div>' + '<div class="uiToastBody">' + '<div class="toastTitle">' + (opts.title || "Ошибка") + "</div>" + '<div class="toastText">' + (opts.text || "") + "</div>" + "</div>" + "";
      wrap.appendChild(el);
      const dur = opts.duration || 3500;
      const remove = () => {
        try {
          el.remove();
        } catch (e) {}
      };
      el.addEventListener("click", remove);
      setTimeout(remove, dur);
      return true;
    } catch (e) {
      return false;
    }
  }
  function notifyLock(opts) {
    const now = Date.now();
    if (now - _lastShownAt < 1200) return;
    _lastShownAt = now;
    safeToast({
      ok: false,
      type: "error",
      title: opts && opts.title ? opts.title : TOAST_TITLE,
      text: opts && opts.text ? opts.text : TOAST_TEXT,
      icon: opts && opts.icon ? opts.icon : "🔒",
      duration: 3800
    });
  }
  function permLabel(key) {
    if (_state && _state.labels && _state.labels[key]) return _state.labels[key];
    return key;
  }
  function lockedPermsList() {
    if (!_state || !_state.permissions) return [];
    return Object.keys(_state.permissions).filter(k => _state.permissions[k]);
  }
  function isAnythingLocked() {
    return lockedPermsList().length > 0 || isPageLocked();
  }
  function isPageLocked() {
    if (!_currentPageKey || !_state || !_state.pages) return false;
    return !!_state.pages[_currentPageKey];
  }
  function showLockBanner(perms) {
    let banner = document.getElementById("locksTopBanner");
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "locksTopBanner";
      banner.className = "locksTopBanner";
      document.body.appendChild(banner);
    }
    const items = [];
    for (const p of perms) {
      items.push('<span class="locksTopItem"><span class="locksTopIcon">🔒</span>' + escapeHtml(permLabel(p)) + "</span>");
    }
    if (isPageLocked()) {
      items.unshift('<span class="locksTopItem locksTopPage"><span class="locksTopIcon">🚫</span>Этот раздел заблокирован</span>');
    }
    banner.innerHTML = '<div class="locksTopInner">' + '<div class="locksTopTitle"><span class="locksTopIcon">🔒</span>Заблокировано KP</div>' + '<div class="locksTopList">' + items.join("") + "</div>" + '<div class="locksTopHint">Действия с этими perm-keys сейчас недоступны. Кнопки заблокированы.</div>' + "</div>";
    banner.style.display = "block";
  }
  function hideLockBanner() {
    const banner = document.getElementById("locksTopBanner");
    if (banner) banner.style.display = "none";
  }
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function getPermForBtn(btn) {
    if (btn.hasAttribute("data-lock-perm")) return btn.getAttribute("data-lock-perm");
    if (btn.hasAttribute("data-perm-disable")) return btn.getAttribute("data-perm-disable");
    return null;
  }
  function getPageForNav(a) {
    const raw = a.hasAttribute("data-lock-page") ? a.getAttribute("data-lock-page") : a.getAttribute("href") || "";
    const val = String(raw || "").replace(/\/+$/, "") || "/";
    if (ROUTE_TO_PAGE[val]) return ROUTE_TO_PAGE[val];
    if (/\.html$/.test(val)) return val.split("/").pop();
    return null;
  }
  function markNavLocked(a, pageKey) {
    if (a.classList.contains("locks-nav-blocked")) return;
    a.classList.add("locks-nav-blocked");
    a.setAttribute("aria-disabled", "true");
    a.removeAttribute("href");
    a.style.cursor = "not-allowed";
    a.title = "🔒 Раздел «" + pageLabel(pageKey) + "» заблокирован KP";
  }
  function unmarkNavLocked(a) {
    if (!a.classList.contains("locks-nav-blocked")) return;
    a.classList.remove("locks-nav-blocked");
    a.removeAttribute("aria-disabled");
    const page = a.getAttribute("data-lock-page");
    if (page) a.setAttribute("href", PAGE_TO_ROUTE[page] || page);
    if (a.title && a.title.indexOf("🔒") === 0) a.removeAttribute("title");
  }
  function markBtnLocked(btn, permKey) {
    if (btn.classList.contains("locks-blocked")) return;
    if (!btn.dataset.origText) {
      btn.dataset.origText = (btn.textContent || "").trim();
    }
    btn.classList.add("locks-blocked");
    btn.disabled = true;
    btn.setAttribute("aria-disabled", "true");
    btn.title = "🔒 Заблокировано KP: " + permLabel(permKey || "");
    if (!btn.querySelector(".locks-btn-icon")) {
      const icon = document.createElement("span");
      icon.className = "locks-btn-icon";
      icon.textContent = "🔒";
      icon.style.cssText = "margin-left:6px;opacity:.9;font-size:13px;";
      btn.appendChild(icon);
    }
  }
  function unmarkBtnLocked(btn) {
    if (!btn.classList.contains("locks-blocked")) return;
    btn.classList.remove("locks-blocked");
    btn.disabled = false;
    btn.removeAttribute("aria-disabled");
    if (btn.dataset.origText !== undefined) {
      btn.textContent = btn.dataset.origText;
      delete btn.dataset.origText;
    }
    const icon = btn.querySelector(".locks-btn-icon");
    if (icon) icon.remove();
    if (btn.title && btn.title.indexOf("🔒 Заблокировано KP") === 0) {
      btn.removeAttribute("title");
    }
  }
  function refreshLockedButtons() {
    const locked = new Set(lockedPermsList());
    const pageLocked = isPageLocked();
    const all = document.querySelectorAll("button, input[type=submit], input[type=button], .btn[data-lock-perm], .btn[data-perm-disable]");
    for (const btn of all) {
      if (btn.id === "logoutBtn") continue;
      if (btn.id === "themeToggle") continue;
      const perm = getPermForBtn(btn);
      if (perm && locked.has(perm)) {
        markBtnLocked(btn, perm);
        continue;
      }
      if (!perm && pageLocked) {
        markBtnLocked(btn, "page");
        continue;
      }
      unmarkBtnLocked(btn);
    }
  }
  function refreshLockedNavLinks() {
    if (!_state || !_state.pages) return;
    if (!_state.applies_to_me) {
      document.querySelectorAll("a.locks-nav-blocked").forEach(unmarkNavLocked);
      return;
    }
    const navLinks = document.querySelectorAll("a.navItem[data-lock-page], a[data-lock-page]");
    for (const a of navLinks) {
      const pageKey = getPageForNav(a);
      if (!pageKey) continue;
      if (_state.pages[pageKey]) {
        markNavLocked(a, pageKey);
      } else {
        unmarkNavLocked(a);
      }
    }
  }
  function showPageLockedBanner() {
    if (!_currentPageKey) return;
    if (!_state || !_state.pages || !_state.pages[_currentPageKey]) return;
    if (!_state.applies_to_me) return;
    try {
      if (document.getElementById("lockPageBanner")) return;
      const b = document.createElement("div");
      b.id = "lockPageBanner";
      b.style.cssText = "position:fixed;top:14px;left:50%;transform:translateX(-50%);" + "z-index:9999;padding:12px 18px;border-radius:14px;" + "background:linear-gradient(135deg,rgba(239,68,68,.95),rgba(185,28,28,.95));" + "color:#fff;font-weight:700;font-size:13px;letter-spacing:.2px;" + "box-shadow:0 10px 30px rgba(0,0,0,.4);" + "border:1px solid rgba(255,255,255,.15);" + "display:flex;align-items:center;gap:10px;max-width:90%;";
      b.innerHTML = '<span style="font-size:18px">🔒</span>' + "<span>Этот раздел сейчас в активном редактировании. Действия недоступны.</span>";
      document.body.appendChild(b);
    } catch (e) {}
  }
  function hidePageLockedBanner() {
    try {
      const b = document.getElementById("lockPageBanner");
      if (b) b.remove();
    } catch (e) {}
  }
  function applyState(state) {
    _state = state;
    const perms = lockedPermsList();
    if (perms.length > 0) {
      showLockBanner(perms);
    } else {
      hideLockBanner();
    }
    refreshLockedButtons();
    refreshLockedNavLinks();
    if (_currentPageKey && state && state.pages && state.pages[_currentPageKey]) {
      showPageLockedBanner();
    } else {
      hidePageLockedBanner();
    }
  }
  async function fetchState() {
    try {
      const r = await fetch("./api/locks/state", {
        cache: "no-store",
        credentials: "include"
      });
      if (!r.ok) return;
      const j = await r.json();
      if (!j || !j.ok) return;
      applyState(j);
    } catch (e) {}
  }
  function installClickGuard() {
    document.addEventListener("click", e => {
      const t = e.target;
      if (!t) return;
      const nav = t.closest && t.closest("a.locks-nav-blocked, a[data-lock-page].locks-nav-blocked");
      if (nav) {
        const page = nav.getAttribute("data-lock-page") || "page";
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        notifyLock({
          title: TOAST_TITLE,
          text: "Раздел «" + pageLabel(page) + "» сейчас заблокирован.",
          icon: "🔒"
        });
        return false;
      }
      const btn = t.closest && t.closest("button, input[type=submit], input[type=button], .btn");
      if (!btn) return;
      if (btn.classList && btn.classList.contains("locks-blocked")) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        const perm = getPermForBtn(btn) || (isPageLocked() ? "page" : "action");
        notifyLock({
          title: TOAST_TITLE,
          text: "Действие «" + permLabel(perm) + "» сейчас заблокировано.",
          icon: "🔒"
        });
        return false;
      }
    }, true);
  }
  function installFetchInterceptor() {
    if (!window.fetch) return;
    const origFetch = window.fetch.bind(window);
    window.fetch = function(input, init) {
      return origFetch(input, init).then(async resp => {
        try {
          const clone = resp.clone();
          const ct = resp.headers && resp.headers.get && resp.headers.get("content-type") || "";
          if (ct.includes("application/json")) {
            const data = await clone.json().catch(() => null);
            if (data && data.ok === false && data.error === "LOCKED") {
              notifyLock({
                title: TOAST_TITLE,
                text: TOAST_TEXT,
                icon: "🔒"
              });
              fetchState();
            }
          }
        } catch (e) {}
        return resp;
      });
    };
  }
  function installXHRInterceptor() {
    if (!window.XMLHttpRequest) return;
    const OrigOpen = window.XMLHttpRequest.prototype.open;
    const OrigSend = window.XMLHttpRequest.prototype.send;
    window.XMLHttpRequest.prototype.open = function(method, url) {
      this.__lk_url = url;
      return OrigOpen.apply(this, arguments);
    };
    window.XMLHttpRequest.prototype.send = function() {
      this.addEventListener("loadend", () => {
        try {
          const ct = this.getResponseHeader && this.getResponseHeader("content-type") || "";
          if (!ct.includes("application/json")) return;
          const txt = this.responseText;
          if (!txt) return;
          const j = JSON.parse(txt);
          if (j && j.ok === false && j.error === "LOCKED") {
            notifyLock({
              title: TOAST_TITLE,
              text: TOAST_TEXT,
              icon: "🔒"
            });
            fetchState();
          }
        } catch (e) {}
      });
      return OrigSend.apply(this, arguments);
    };
  }
  function startPolling() {
    if (_pollTimer) clearInterval(_pollTimer);
    _pollTimer = setInterval(() => {
      if (document.hidden) return;
      fetchState();
    }, POLL_MS);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) fetchState();
    });
  }
  function injectStyles() {
    if (document.getElementById("locksNoticeStyles")) return;
    const s = document.createElement("style");
    s.id = "locksNoticeStyles";
    s.textContent = ".locksTopBanner{display:none;position:sticky;top:0;left:0;right:0;z-index:10000;" + "background:linear-gradient(135deg,rgba(239,68,68,.95),rgba(185,28,28,.95));" + "color:#fff;padding:10px 16px;font-size:13px;letter-spacing:.2px;" + "box-shadow:0 8px 24px rgba(0,0,0,.35);border-bottom:1px solid rgba(255,255,255,.15);" + "backdrop-filter:blur(6px);}" + ".locksTopInner{max-width:1400px;margin:0 auto;display:flex;flex-wrap:wrap;align-items:center;gap:14px;}" + ".locksTopTitle{font-weight:800;font-size:14px;display:flex;align-items:center;gap:6px;}" + ".locksTopIcon{display:inline-block;}" + ".locksTopList{display:flex;flex-wrap:wrap;gap:6px;}" + ".locksTopItem{display:inline-flex;align-items:center;gap:4px;padding:4px 10px;" + "border-radius:999px;background:rgba(0,0,0,.22);font-size:12px;font-weight:600;}" + ".locksTopPage{background:rgba(0,0,0,.32);}" + ".locksTopHint{opacity:.85;font-size:12px;margin-left:auto;}" + "button.locks-blocked,input[type=submit].locks-blocked,input[type=button].locks-blocked,.btn.locks-blocked{" + "opacity:.55 !important;cursor:not-allowed !important;" + "background:rgba(120,120,120,.25) !important;" + "border-color:rgba(120,120,120,.4) !important;color:#888 !important;" + "box-shadow:none !important;transform:none !important;}" + "button.locks-blocked:hover,input[type=submit].locks-blocked:hover,.btn.locks-blocked:hover{" + "transform:none !important;box-shadow:none !important;}" + ".locks-btn-icon{filter:grayscale(.2);}" + "a.locks-nav-blocked{opacity:.45 !important;cursor:not-allowed !important;" + "pointer-events:auto !important;background:rgba(120,120,120,.10) !important;" + "border-color:rgba(120,120,120,.25) !important;}" + "a.locks-nav-blocked:hover{transform:none !important;box-shadow:none !important;" + "background:rgba(120,120,120,.15) !important;}" + 'a.locks-nav-blocked::before{content:"🔒 ";opacity:.85;margin-right:2px;}';
    document.head.appendChild(s);
  }
  function init() {
    _currentPageKey = getCurrentPageKey();
    injectStyles();
    installClickGuard();
    installFetchInterceptor();
    installXHRInterceptor();
    installBroadcastChannel();
    fetchState().then(() => {
      redirectIfPageLocked();
      refreshLockedNavLinks();
      refreshLockedButtons();
    });
    startPolling();
  }
  function redirectIfPageLocked() {
    if (!_currentPageKey) return;
    if (!_state || !_state.pages || !_state.pages[_currentPageKey]) return;
    if (!_state.applies_to_me) return;
    if (_currentPageKey === "/manage/locks") return;
    try {
      if (window.UI && window.UI.toast) {
        window.UI.toast({
          title: "Заблокировано KP",
          text: "Раздел «" + pageLabel(_currentPageKey) + "» сейчас в активном редактировании.",
          icon: "🔒",
          duration: 4500
        });
      }
    } catch (e) {}
    setTimeout(() => {
      try {
        location.replace("/");
      } catch (e) {
        location.href = "/";
      }
    }, 600);
  }
  function installBroadcastChannel() {
    try {
      if (typeof BroadcastChannel === "undefined") return;
      const bc = new BroadcastChannel("viberp-locks");
      bc.addEventListener("message", e => {
        if (e && e.data && e.data.type === "locks-changed") {
          fetchState().then(() => {
            refreshLockedNavLinks();
            refreshLockedButtons();
            redirectIfPageLocked();
          });
        }
      });
      window.__locksBroadcastChannel = bc;
    } catch (e) {
      window.__locksBroadcastChannel = null;
    }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
