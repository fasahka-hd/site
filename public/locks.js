(function() {
  "use strict";
  const els = {
    guard: document.getElementById("guard"),
    content: document.getElementById("content"),
    err: document.getElementById("err"),
    statPerms: document.getElementById("statPerms"),
    statPages: document.getElementById("statPages"),
    statMode: document.getElementById("statMode"),
    updated: document.getElementById("updatedInfo"),
    modeAll: document.getElementById("modeAll"),
    modeOthers: document.getElementById("modeOthers"),
    modeHint: document.getElementById("modeHint"),
    note: document.getElementById("noteInput"),
    permGroups: document.getElementById("permGroups"),
    permEmpty: document.getElementById("permEmpty"),
    pages: document.getElementById("pagesList"),
    apiStatus: document.getElementById("apiStatus"),
    reload: document.getElementById("reloadBtn"),
    save: document.getElementById("saveBtn"),
    clear: document.getElementById("clearBtn"),
    checkAllPerms: document.getElementById("checkAllPerms"),
    uncheckAllPerms: document.getElementById("uncheckAllPerms"),
    checkAllPages: document.getElementById("checkAllPages"),
    uncheckAllPages: document.getElementById("uncheckAllPages")
  };
  let _me = null;
  let _data = null;
  let _dirty = false;
  function showError(msg) {
    els.err.textContent = msg;
    els.err.style.display = "block";
  }
  function clearError() {
    els.err.style.display = "none";
    els.err.textContent = "";
  }
  function setApi(s) {
    if (els.apiStatus) els.apiStatus.textContent = "API: " + s;
  }
  function fmtTime(ts) {
    if (!ts) return "—";
    try {
      const d = new Date(ts * 1e3);
      const pad = n => n < 10 ? "0" + n : "" + n;
      return pad(d.getDate()) + "." + pad(d.getMonth() + 1) + "." + d.getFullYear() + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
    } catch {
      return "—";
    }
  }
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function applyNavRoleVisibility() {
    const role = _me && _me.role || "user";
    document.querySelectorAll("[data-role-only]").forEach(el => {
      const need = el.getAttribute("data-role-only");
      el.style.display = need === role ? "" : "none";
    });
    if (window.UI && typeof window.UI.applyPerms === "function") {
      try {
        window.UI.applyPerms(window.__PERMS || {});
      } catch (e) {}
    }
  }
  async function fetchMe() {
    try {
      const r = await fetch("./api/me", {
        cache: "no-store",
        credentials: "include"
      });
      if (!r.ok) return null;
      const j = await r.json();
      if (!j.ok) return null;
      _me = j.user || null;
      try {
        window.__ME = _me;
        window.__PERMS = j.perms || {};
        if (window.UI && typeof window.UI.applyPerms === "function") {
          window.UI.applyPerms(window.__PERMS);
        }
      } catch (e) {}
      return _me;
    } catch (e) {
      return null;
    }
  }
  async function fetchLocks() {
    setApi("загрузка...");
    try {
      const r = await fetch("./api/locks", {
        cache: "no-store",
        credentials: "include"
      });
      if (r.status === 401) {
        location.href = "/login";
        return null;
      }
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j && j.error || "HTTP " + r.status);
      setApi("online");
      return j;
    } catch (e) {
      setApi("ошибка");
      showError("Не удалось загрузить блокировки: " + e.message);
      return null;
    }
  }
  function permLabel(key) {
    return _data && _data.labels && _data.labels[key] || key;
  }
  function renderPermGroups() {
    const groups = Array.isArray(_data?.groups) ? _data.groups : [];
    const keys = _data && _data.keys || [];
    const others = _data && (_data.permissions_others || _data.permissions) || {};
    const self = _data && _data.permissions_self || {};
    const container = els.permGroups;
    container.innerHTML = "";
    if (!keys.length) {
      els.permEmpty.style.display = "block";
      return;
    }
    els.permEmpty.style.display = "none";
    const used = new Set;
    const packs = groups.length ? groups.map(g => ({
      title: g.title || g.key || "Прочее",
      perms: g.perms || []
    })) : [];
    packs.push({
      title: "Прочее",
      perms: keys.filter(k => !packs.some(g => g.perms.includes(k)))
    });
    for (const pack of packs) {
      const list = (pack.perms || []).filter(k => keys.includes(k) && !used.has(k));
      if (!list.length) continue;
      list.forEach(k => used.add(k));
      const groupEl = document.createElement("div");
      groupEl.className = "locksGroup";
      groupEl.innerHTML = '<div class="locksGroupHead"><div class="locksGroupName">' + escapeHtml(pack.title) + '</div><div class="locksGroupCount">' + list.length + " действий</div></div>";
      const body = document.createElement("div");
      body.className = "locksGroupBody splitLocksBody";
      for (const k of list) {
        const o = !!others[k], me = !!self[k];
        const item = document.createElement("div");
        item.className = "lockItem splitLockItem" + (o || me ? " locked" : "");
        item.innerHTML = '<div class="splitLockInfo"><div class="lockItemLabel">' + escapeHtml(permLabel(k)) + '</div><div class="lockItemKey">' + escapeHtml(k) + "</div></div>" + splitSwitches("perm", k, o, me);
        item.querySelectorAll("input").forEach(cb => cb.addEventListener("change", () => {
          item.classList.toggle("locked", !!item.querySelector("input:checked"));
          _dirty = true;
          updateStats();
        }));
        body.appendChild(item);
      }
      groupEl.appendChild(body);
      container.appendChild(groupEl);
    }
  }
  function splitSwitches(type, key, others, self) {
    return '<div class="splitSwitches">' + '<label class="splitSwitch"><span>Остальные</span><span class="sw"><input type="checkbox" data-lock-scope="others" data-' + type + '-key="' + escapeHtml(key) + '"' + (others ? " checked" : "") + '><span class="swSlider"></span></span></label>' + '<label class="splitSwitch"><span>Я (KP)</span><span class="sw"><input type="checkbox" data-lock-scope="self" data-' + type + '-key="' + escapeHtml(key) + '"' + (self ? " checked" : "") + '><span class="swSlider"></span></span></label>' + "</div>";
  }
  function renderPages() {
    let pages = _data && _data.pages || [];
    if (!Array.isArray(pages)) pages = Object.keys(_data.pages || {}).map(k => ({
      key: k,
      label: k,
      perm: null
    }));
    const others = _data && (_data.pages_others || _data.pages_state || _data.pages) || {};
    const self = _data && _data.pages_self || {};
    els.pages.innerHTML = "";
    if (!pages.length) {
      const empty = document.createElement("div");
      empty.className = "locksEmpty";
      empty.textContent = "Нет доступных разделов";
      els.pages.appendChild(empty);
      return;
    }
    for (const p of pages) {
      if (!p || typeof p !== "object" || !p.key) continue;
      const o = !!others[p.key], me = !!self[p.key];
      const item = document.createElement("div");
      item.className = "pageItem splitPageItem" + (o || me ? " locked" : "");
      item.innerHTML = '<div style="min-width:0;flex:1"><div class="pageItemLabel">' + escapeHtml(p.label || p.key) + '</div><div class="pageItemKey">' + escapeHtml(p.key) + (p.perm ? " · привязано к «" + escapeHtml(permLabel(p.perm)) + "»" : "") + "</div></div>" + splitSwitches("page", p.key, o, me);
      item.querySelectorAll("input").forEach(cb => cb.addEventListener("change", () => {
        item.classList.toggle("locked", !!item.querySelector("input:checked"));
        _dirty = true;
        updateStats();
      }));
      els.pages.appendChild(item);
    }
  }
  function renderMode() {
    if (els.modeAll) {
      els.modeAll.classList.add("on");
      els.modeAll.textContent = "Раздельная блокировка";
    }
    if (els.modeOthers) els.modeOthers.style.display = "none";
    els.statMode.textContent = "Раздельно";
    els.modeHint.textContent = "У каждой блокировки два переключателя: «Остальные» и «Я (KP)». Можно блокировать отдельно для всех игроков и отдельно для себя.";
    els.note.value = _data && _data.note || "";
  }
  function updateStats() {
    let permCount = 0, pageCount = 0;
    els.permGroups.querySelectorAll("input[type=checkbox]:checked").forEach(() => permCount++);
    els.pages.querySelectorAll("input[type=checkbox]:checked").forEach(() => pageCount++);
    els.statPerms.textContent = String(permCount);
    els.statPages.textContent = String(pageCount);
  }
  function renderAll() {
    renderMode();
    renderPermGroups();
    renderPages();
    els.updated.textContent = "Обновлено: " + (_data.updated_by || "—") + " · " + fmtTime(_data.updated_at);
    updateStats();
  }
  function collectPayload() {
    const permissions_others = {}, permissions_self = {}, pages_others = {}, pages_self = {};
    els.permGroups.querySelectorAll("input[data-perm-key]").forEach(cb => {
      const key = cb.getAttribute("data-perm-key");
      const scope = cb.getAttribute("data-lock-scope");
      if (scope === "self") permissions_self[key] = cb.checked; else permissions_others[key] = cb.checked;
    });
    els.pages.querySelectorAll("input[data-page-key]").forEach(cb => {
      const key = cb.getAttribute("data-page-key");
      const scope = cb.getAttribute("data-lock-scope");
      if (scope === "self") pages_self[key] = cb.checked; else pages_others[key] = cb.checked;
    });
    return {
      permissions_others: permissions_others,
      permissions_self: permissions_self,
      pages_others: pages_others,
      pages_self: pages_self,
      note: (els.note.value || "").slice(0, 200)
    };
  }
  async function save() {
    if (!_me || _me.role !== "KP") {
      showError("Только KP может менять блокировки.");
      return;
    }
    const payload = collectPayload();
    els.save.disabled = true;
    setApi("сохранение...");
    try {
      const r = await fetch("./api/locks", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        credentials: "include",
        body: JSON.stringify(payload)
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j || !j.ok) {
        const err = j && j.error || "HTTP " + r.status;
        throw new Error(err);
      }
      _data = Object.assign({}, _data, j.locks);
      _data.pages = _data.pages || (j.locks.pages && j.locks.pages.length ? j.locks.pages : _data.pages);
      _data.pages_state = j.locks.pages_state || _data.pages_state || {};
      _data.keys = _data.keys || j.locks.keys || [];
      _data.groups = _data.groups || j.locks.groups || {};
      _data.labels = _data.labels || j.locks.labels || {};
      _dirty = false;
      renderAll();
      setApi("online");
      try {
        if (window.UI && window.UI.toast) window.UI.toast({
          text: "Блокировки сохранены",
          icon: "✓"
        });
      } catch (e) {}
      try {
        if (window.__locksBroadcastChannel) window.__locksBroadcastChannel.postMessage({
          type: "locks-changed"
        });
      } catch (e) {}
    } catch (e) {
      setApi("ошибка");
      showError("Не удалось сохранить: " + e.message);
    } finally {
      els.save.disabled = false;
    }
  }
  async function clearAll() {
    if (!_me || _me.role !== "KP") {
      showError("Только KP может менять блокировки.");
      return;
    }
    if (!confirm("Снять ВСЕ блокировки? Все действия и разделы снова станут доступны всем.")) return;
    try {
      const r = await fetch("./api/locks/clear", {
        method: "POST",
        credentials: "include"
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j || !j.ok) throw new Error(j && j.error || "HTTP " + r.status);
      _data = Object.assign({}, _data, j.locks);
      _data.pages_state = j.locks.pages_state || _data.pages_state || {};
      renderAll();
      try {
        if (window.UI && window.UI.toast) window.UI.toast({
          text: "Все блокировки сняты",
          icon: "✓"
        });
      } catch (e) {}
      try {
        if (window.__locksBroadcastChannel) window.__locksBroadcastChannel.postMessage({
          type: "locks-changed"
        });
      } catch (e) {}
      try {
        window.UI && window.UI.toast && window.UI.toast({
          text: "Все блокировки сняты",
          icon: "✓"
        });
      } catch (e) {}
    } catch (e) {
      showError("Не удалось снять блокировки: " + e.message);
    }
  }
  function setAllPerms(value) {
    els.permGroups.querySelectorAll("input[type=checkbox]").forEach(cb => {
      cb.checked = value;
      cb.closest(".lockItem").classList.toggle("locked", !!cb.closest(".lockItem").querySelector("input:checked"));
    });
    _dirty = true;
    updateStats();
  }
  function setAllPages(value) {
    els.pages.querySelectorAll("input[type=checkbox]").forEach(cb => {
      cb.checked = value;
      cb.closest(".pageItem").classList.toggle("locked", !!cb.closest(".pageItem").querySelector("input:checked"));
    });
    _dirty = true;
    updateStats();
  }
  function bindUI() {
    els.reload.addEventListener("click", load);
    els.save.addEventListener("click", save);
    els.clear.addEventListener("click", clearAll);
    if (els.modeAll) els.modeAll.addEventListener("click", () => {
      els.modeHint.textContent = "Используй переключатели в каждой строке: Остальные / Я (KP).";
    });
    if (els.modeOthers) els.modeOthers.addEventListener("click", () => {
      els.modeHint.textContent = "Используй переключатели в каждой строке: Остальные / Я (KP).";
    });
    els.note.addEventListener("input", () => {
      _dirty = true;
    });
    els.checkAllPerms.addEventListener("click", () => setAllPerms(true));
    els.uncheckAllPerms.addEventListener("click", () => setAllPerms(false));
    els.checkAllPages.addEventListener("click", () => setAllPages(true));
    els.uncheckAllPages.addEventListener("click", () => setAllPages(false));
    window.addEventListener("beforeunload", e => {
      if (_dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    });
  }
  async function load() {
    clearError();
    const me = await fetchMe();
    if (!me) {
      location.href = "/login";
      return;
    }
    if (me.role !== "KP") {
      els.guard.style.display = "block";
      els.content.style.display = "none";
      applyNavRoleVisibility();
      return;
    }
    els.guard.style.display = "none";
    els.content.style.display = "";
    applyNavRoleVisibility();
    const data = await fetchLocks();
    if (!data) return;
    _data = data;
    if (!_data.pages_state || typeof _data.pages_state !== "object" || Array.isArray(_data.pages_state)) {
      _data.pages_state = {};
    }
    _data.keys = Array.isArray(_data.keys) ? _data.keys : [];
    _data.groups = _data.groups && typeof _data.groups === "object" ? _data.groups : {};
    _data.labels = _data.labels && typeof _data.labels === "object" ? _data.labels : {};
    _dirty = false;
    renderAll();
  }
  document.addEventListener("DOMContentLoaded", () => {
    bindUI();
    load();
  });
})();
