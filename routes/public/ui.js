(function() {
  "use strict";
  document.documentElement.removeAttribute("data-theme");
  try {
    if (window.self !== window.top) document.documentElement.classList.add("embeddedPage");
  } catch {
    document.documentElement.classList.add("embeddedPage");
  }
  function ensureToastWrap() {
    let w = document.getElementById("toastWrap");
    if (!w) {
      w = document.createElement("div");
      w.id = "toastWrap";
      w.className = "toastWrap";
      document.body.appendChild(w);
    }
    return w;
  }
  function uiToast(opts) {
    const o = typeof opts === "string" ? {
      text: opts
    } : opts || {};
    const ok = o.ok !== false && o.type !== "error";
    const wrap = ensureToastWrap();
    const el = document.createElement("div");
    el.className = "toast uiToast " + (ok ? "ok" : "bad");
    const icon = document.createElement("div");
    icon.className = "uiToastIcon";
    icon.textContent = o.icon || (ok ? "✓" : "✕");
    const body = document.createElement("div");
    body.className = "uiToastBody";
    const title = document.createElement("div");
    title.className = "toastTitle";
    title.textContent = o.title || (ok ? "Готово" : "Ошибка");
    const text = document.createElement("div");
    text.className = "toastText";
    text.textContent = o.text || "";
    body.appendChild(title);
    if (o.text) body.appendChild(text);
    el.appendChild(icon);
    el.appendChild(body);
    wrap.appendChild(el);
    const dur = o.duration || 3200;
    const remove = () => el.remove();
    el.addEventListener("click", remove);
    setTimeout(remove, dur);
    return el;
  }
  function skeletonCards(container, count) {
    if (!container) return;
    container.innerHTML = "";
    const frag = document.createDocumentFragment();
    for (let i = 0; i < (count || 8); i++) {
      const c = document.createElement("div");
      c.className = "skeletonCard";
      c.innerHTML = '<div class="skel skelAvatar"></div><div class="skelLines"><div class="skel skelLine w70"></div><div class="skel skelLine w40"></div><div class="skel skelChips"><span class="skel skelChip"></span><span class="skel skelChip"></span></div></div>';
      frag.appendChild(c);
    }
    container.appendChild(frag);
  }
  function skeletonRows(tbody, rows, cols) {
    if (!tbody) return;
    tbody.innerHTML = "";
    for (let i = 0; i < (rows || 8); i++) {
      const tr = document.createElement("tr");
      tr.className = "skeletonRow";
      for (let j = 0; j < (cols || 5); j++) {
        const td = document.createElement("td");
        td.innerHTML = '<div class="skel skelLine"></div>';
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
  }
  const AV_COLORS = [ "#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4", "#6b7280", "#8b5cf6", "#ec4899", "#14b8a6", "#f59e0b" ];
  function hashStr(s) {
    let h = 0;
    s = String(s || "");
    for (let i = 0; i < s.length; i++) h = h * 31 + s.charCodeAt(i) | 0;
    return Math.abs(h);
  }
  function initialsAvatar(name, sid) {
    const n = String(name || "").trim();
    let letters = "?";
    if (n) {
      const parts = n.replace(/[^\p{L}\p{N} ]/gu, "").split(/\s+/).filter(Boolean);
      letters = parts.length >= 2 ? parts[0][0] + parts[1][0] : n.slice(0, 2);
    }
    letters = letters.toUpperCase();
    const c1 = AV_COLORS[hashStr(sid || name) % AV_COLORS.length];
    const c2 = AV_COLORS[(hashStr(sid || name) + 4) % AV_COLORS.length];
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs><rect width="128" height="128" fill="url(#g)"/><text x="50%" y="52%" dy=".35em" text-anchor="middle" font-family="Inter,Arial,sans-serif" font-size="54" font-weight="800" fill="#fff">${letters}</text></svg>`;
    return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  }
  function animateNumber(el, to, opts) {
    if (!el) return;
    to = Number(to) || 0;
    const o = opts || {};
    const fmt = v => o.format ? o.format(v) : Math.round(v).toLocaleString("ru-RU");
    el.textContent = fmt(to);
    el.dataset.val = to;
  }
  function ensureNetBanner() {
    let b = document.getElementById("netBanner");
    if (!b) {
      b = document.createElement("div");
      b.id = "netBanner";
      b.className = "netBanner";
      b.textContent = "⚠ Нет подключения к сети — данные могут устареть";
      document.body.appendChild(b);
    }
    return b;
  }
  function netUpdate() {
    const b = ensureNetBanner();
    b.classList.toggle("show", !navigator.onLine);
  }
  window.addEventListener("online", netUpdate);
  window.addEventListener("offline", netUpdate);
  function uiConfirm(opts) {
    const o = opts || {};
    return new Promise(resolve => {
      const ov = document.createElement("div");
      ov.className = "confirmOverlay";
      ov.innerHTML = '<div class="confirmBox" role="dialog" aria-modal="true"><div class="confirmIcon ' + (o.danger ? "danger" : "") + '">' + (o.icon || (o.danger ? "🗑️" : "❓")) + '</div><div class="confirmTitle"></div><div class="confirmText"></div><div class="confirmActions"><button class="btn confirmCancel" type="button"></button><button class="btn ' + (o.danger ? "danger" : "gray") + ' confirmOk" type="button"></button></div></div>';
      ov.querySelector(".confirmTitle").textContent = o.title || "Подтверждение";
      ov.querySelector(".confirmText").textContent = o.text || "";
      const okBtn = ov.querySelector(".confirmOk");
      const cancelBtn = ov.querySelector(".confirmCancel");
      okBtn.textContent = o.okText || "Удалить";
      cancelBtn.textContent = o.cancelText || "Отмена";
      document.body.appendChild(ov);
      ov.classList.add("show");
      const close = val => {
        ov.classList.remove("show");
        ov.remove();
        document.removeEventListener("keydown", onKey);
        resolve(val);
      };
      const onKey = e => {
        if (e.key === "Escape") close(false);
        if (e.key === "Enter") close(true);
      };
      document.addEventListener("keydown", onKey);
      okBtn.addEventListener("click", () => close(true));
      cancelBtn.addEventListener("click", () => close(false));
      ov.addEventListener("click", e => {
        if (e.target === ov) close(false);
      });
      setTimeout(() => okBtn.focus(), 60);
    });
  }
  window.UI = {
    toast: uiToast,
    confirm: uiConfirm,
    skeletonCards: skeletonCards,
    skeletonRows: skeletonRows,
    initialsAvatar: initialsAvatar,
    animateNumber: animateNumber
  };
  let _enhancing = false;
  function safeEnhanceNav() {
    if (_enhancing) return;
    _enhancing = true;
    try {
      enhanceNav();
      if (window.applyPerms && window.__PERMS) {
        window.applyPerms(window.__PERMS);
      }
    } catch (e) {}
    _enhancing = false;
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      netUpdate();
      safeEnhanceNav();
      setupMobileNav();
    });
  } else {
    netUpdate();
    safeEnhanceNav();
    setupMobileNav();
  }
  const NAV_ITEMS = [ {
    t: "Игроки",
    u: "/",
    i: "👥",
    p: "view_players"
  }, {
    t: "Баны",
    u: "/bans",
    i: "🔨",
    p: "view_bans"
  }, {
    t: "Статистика",
    u: "/stats",
    i: "📊",
    p: "view_stats"
  }, {
    t: "Логи админов",
    u: "/admin-logs",
    i: "📜",
    p: "view_admin_logs"
  }, {
    t: "Чёрный список",
    u: "/blacklist",
    i: "🚫",
    p: "view_blacklist"
  }, {
    t: "Промокоды",
    u: "/promos",
    i: "🎁",
    p: "view_promos"
  }, {
    t: "Доступ ЗБТ",
    u: "/zbt-access",
    i: "🔐",
    p: "manage_zbt_access"
  }, {
    t: "Управление",
    u: "/manage",
    i: "⚙️",
    pm: true
  }, {
    t: "Тех.Раздел: деньги",
    u: "/tech/money",
    i: "💸",
    p: "view_money_logs"
  }, {
    t: "Общий раздел",
    u: "/tech/gangs",
    i: "🗂️",
    p: "view_money_logs"
  }, {
    t: "Общий раздел: дуэли",
    u: "/tech/duels",
    i: "⚔️",
    p: "view_money_logs"
  }, {
    t: "Тех.Раздел: донат",
    u: "/tech/donate",
    i: "💎",
    p: "view_donate_logs"
  } ];
  let cmdOverlay = null;
  function buildPalette() {
    cmdOverlay = document.createElement("div");
    cmdOverlay.className = "cmdkOverlay";
    cmdOverlay.innerHTML = '<div class="cmdkBox" role="dialog" aria-modal="true"><input class="cmdkInput" type="text" placeholder="Поиск: страница или SteamID64 игрока…" autocomplete="off" /><div class="cmdkList"></div><div class="cmdkHint">↑↓ выбор • Enter открыть • Esc закрыть</div></div>';
    document.body.appendChild(cmdOverlay);
    const input = cmdOverlay.querySelector(".cmdkInput");
    const list = cmdOverlay.querySelector(".cmdkList");
    let items = [], sel = 0;
    function render() {
      const q = input.value.trim().toLowerCase();
      const has = perm => !perm || window.hasPerm && window.hasPerm(perm);
      items = NAV_ITEMS.filter(n => {
        if (n.pm) {
          const role = window.__ME && window.__ME.role || window.__EARLY_ROLE || "";
          return role === "KP" || has("manage_users") || has("manage_permissions");
        }
        return !q || n.t.toLowerCase().includes(q);
      }).filter(n => has(n.p)).map(n => ({
        ...n
      }));
      if (/^\d{17}$/.test(input.value.trim())) {
        items.unshift({
          t: "Открыть профиль " + input.value.trim(),
          u: "/player?sid=" + input.value.trim(),
          i: "🔎"
        });
      }
      list.innerHTML = "";
      items.forEach((it, idx) => {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "cmdkItem" + (idx === sel ? " active" : "");
        row.innerHTML = '<span class="cmdkIcon">' + it.i + "</span><span></span>";
        row.querySelector("span:last-child").textContent = it.t;
        row.addEventListener("click", () => go(it));
        row.addEventListener("mousemove", () => {
          sel = idx;
          paint();
        });
        list.appendChild(row);
      });
    }
    function paint() {
      [ ...list.children ].forEach((c, i) => c.classList.toggle("active", i === sel));
    }
    function go(it) {
      if (it) location.href = it.u;
    }
    input.addEventListener("input", () => {
      sel = 0;
      render();
    });
    input.addEventListener("keydown", e => {
      if (e.key === "ArrowDown") {
        sel = Math.min(sel + 1, items.length - 1);
        paint();
        e.preventDefault();
      } else if (e.key === "ArrowUp") {
        sel = Math.max(sel - 1, 0);
        paint();
        e.preventDefault();
      } else if (e.key === "Enter") {
        go(items[sel]);
      } else if (e.key === "Escape") {
        closePalette();
      }
    });
    cmdOverlay.addEventListener("click", e => {
      if (e.target === cmdOverlay) closePalette();
    });
    render();
    cmdOverlay.classList.add("show");
    input.focus();
  }
  function closePalette() {
    if (!cmdOverlay) return;
    cmdOverlay.remove();
    cmdOverlay = null;
  }
  document.addEventListener("keydown", e => {
    if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) {
      e.preventDefault();
      if (cmdOverlay) closePalette(); else buildPalette();
    }
  });
  function syncManagementLinks() {
    const role = window.__ME && window.__ME.role || window.__EARLY_ROLE || "";
    const canManage = role === "KP" || typeof window.hasPerm === "function" && (window.hasPerm("manage_users") || window.hasPerm("manage_permissions"));
    document.querySelectorAll("[data-manage-hub]").forEach(el => {
      el.classList.toggle("perm-allowed", !!canManage);
      el.style.display = canManage ? "" : "none";
    });
  }
  function enhanceNav() {
    const nav = document.querySelector(".side .nav");
    if (!nav) return;
    const current = ((location.pathname || "/").replace(/\/+$/, "") || "/").toLowerCase();
    nav.querySelectorAll('a[href="/manage/users"],a[href="/manage/permissions"],a[href="/manage/locks"]').forEach(a => a.remove());
    nav.querySelectorAll('a[href="/tech/money"],a[href="/tech/gangs"],a[href="/tech/donate"],.navSectionTitle').forEach(el => el.remove());
    const logout = nav.querySelector("#logoutBtn")?.closest(".navItem") || nav.querySelector("#logoutBtn");
    function addLink(id, text, href, attrs) {
      if (nav.querySelector(`[data-auto-nav="${id}"]`) || nav.querySelector(`a[href="${href}"]`)) return null;
      const a = document.createElement("a");
      a.className = "navItem" + (current === href.toLowerCase() ? " active" : "");
      a.href = href;
      a.textContent = text;
      a.dataset.autoNav = id;
      a.style.display = "none";
      for (const [k, v] of Object.entries(attrs || {})) a.setAttribute(k, v);
      nav.insertBefore(a, logout || null);
      return a;
    }
    addLink("manage", "Управление", "/manage", {
      "data-manage-hub": "1",
      "data-lock-page": "/manage"
    });
    const title = document.createElement("div");
    title.className = "navSectionTitle techNavTitle";
    title.textContent = "Тех.Раздел";
    title.style.display = "none";
    title.setAttribute("data-tech-section", "1");
    nav.insertBefore(title, logout || null);
    addLink("tech-money", "Операции с деньгами", "/tech/money", {
      "data-perm": "view_money_logs",
      "data-lock-page": "/tech/money"
    });
    addLink("tech-gangs", "Общий раздел", "/tech/gangs", {
      "data-perm": "view_money_logs",
      "data-lock-page": "/tech/gangs"
    });
    if (current.startsWith("/tech/gangs") || current === "/tech/duels") {
      nav.querySelector('a[data-auto-nav="tech-gangs"]')?.classList.add("active");
    }
    addLink("tech-donate", "Донат", "/tech/donate", {
      "data-perm": "view_donate_logs",
      "data-lock-page": "/tech/donate"
    });
    syncManagementLinks();
  }
  window.addEventListener("perms:updated", () => {
    syncManagementLinks();
  });
  function setupMobileNav() {
    const side = document.querySelector(".side");
    const app = document.querySelector(".app");
    if (!side || !app) return;
    if (document.getElementById("mobileNavBtn")) return;
    const btn = document.createElement("button");
    btn.id = "mobileNavBtn";
    btn.className = "mobileNavBtn";
    btn.type = "button";
    btn.setAttribute("aria-label", "Меню");
    btn.innerHTML = "<span></span><span></span><span></span>";
    document.body.appendChild(btn);
    const backdrop = document.createElement("div");
    backdrop.id = "mobileNavBackdrop";
    backdrop.className = "mobileNavBackdrop";
    document.body.appendChild(backdrop);
    const open = () => {
      side.classList.add("open");
      backdrop.classList.add("show");
      btn.classList.add("active");
      document.body.style.overflow = "hidden";
    };
    const close = () => {
      side.classList.remove("open");
      backdrop.classList.remove("show");
      btn.classList.remove("active");
      document.body.style.overflow = "";
    };
    const toggle = () => {
      side.classList.contains("open") ? close() : open();
    };
    btn.addEventListener("click", toggle);
    backdrop.addEventListener("click", close);
    side.querySelectorAll(".navItem").forEach(a => a.addEventListener("click", () => close()));
    window.addEventListener("resize", () => {
      if (window.innerWidth > 900) close();
    });
  }
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    });
  }
  window.UI.enhanceNav = enhanceNav;
})();
