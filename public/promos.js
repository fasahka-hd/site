(async () => {
  const $ = id => document.getElementById(id);
  const apiStatus = $("apiStatus");
  const tbody = $("tbody");
  const err = $("err");
  const qInput = $("q");
  const refreshBtn = $("refresh");
  const addPromoBtn = $("addPromoBtn");
  const statsRow = $("statsRow");
  const totalPromos = $("totalPromos");
  const activePromos = $("activePromos");
  const totalUses = $("totalUses");
  const usageModal = $("usageModal");
  const usageCode = $("usageCode");
  const usageTbody = $("usageTbody");
  const usageClose = $("usageClose");
  const usageCloseX = $("usageCloseX");
  const RANK_ID_TO_NAME = {
    1: "User",
    2: "vip",
    3: "d-moderator",
    4: "d-admin",
    5: "superadmin",
    6: "owner",
    7: "inter",
    8: "helper",
    9: "moderator",
    10: "admin",
    11: "head-admin",
    12: "curator",
    13: "head-curator",
    14: "vice-manager",
    15: "manager",
    16: "project-team",
    17: "arizona-team",
    18: "zamuprav",
    19: "uprav",
    20: "co*",
    21: "*"
  };
  const RANK_COLORS = {
    "*": "#ef4444",
    "co*": "#ef4444",
    uprav: "#ef4444",
    zamuprav: "#9ca3af",
    "arizona-team": "#9ca3af",
    "project-team": "#9ca3af",
    manager: "#9ca3af",
    "vice-manager": "#9ca3af",
    "head-curator": "#06b6d4",
    curator: "#06b6d4",
    "head-admin": "#6b7280",
    admin: "#6b7280",
    moderator: "#ec4899",
    helper: "#ec4899",
    inter: "#ec4899",
    owner: "#8b5cf6",
    superadmin: "#8b5cf6",
    "d-admin": "#94a3b8",
    "d-moderator": "#94a3b8",
    vip: "#9ca3af",
    VIP: "#9ca3af",
    User: "#10b981",
    user: "#10b981"
  };
  function resolveRank(rankId) {
    if (!rankId) return "user";
    if (typeof rankId === "number") return RANK_ID_TO_NAME[rankId] || "user";
    if (/^\d+$/.test(rankId)) return RANK_ID_TO_NAME[parseInt(rankId, 10)] || "user";
    return String(rankId).toLowerCase();
  }
  let allItems = [];
  let loading = false;
  const ERROR_TEXT = {
    BAD_CODE: "Код должен быть от 2 до 64 символов: A-Z, 0-9 или _",
    DUPLICATE_CODE: "Такой промокод уже есть",
    BAD_REWARD: "Укажите хотя бы одну награду",
    BAD_ID: "Промокод не найден",
    NOT_FOUND: "Промокод не найден",
    DB_ERROR: "Ошибка базы данных",
    NO_PERM: "Недостаточно прав",
    LOCKED: "Действие заблокировано"
  };
  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, ch => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[ch]));
  }
  function toast(ok, title, text) {
    if (window.UI && UI.toast) {
      UI.toast({
        ok: ok,
        title: title,
        text: text
      });
      return;
    }
    const wrap = $("toastWrap");
    if (!wrap) return;
    const el = document.createElement("div");
    el.className = "toast " + (ok ? "ok" : "bad");
    el.innerHTML = `<div class="toastTitle">${esc(title)}</div><div class="toastText">${esc(text)}</div>`;
    wrap.appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }
  async function confirmAction(opts) {
    if (window.UI && UI.confirm) return UI.confirm(opts);
    return window.confirm(`${opts.title || "Подтвердите"}\n${opts.text || ""}`);
  }
  function lockBody(lock) {
    document.body.style.overflow = lock ? "hidden" : "";
  }
  function modal({title: title, body: body, okText: okText = "Сохранить", cancelText: cancelText = "Отмена", danger: danger = false, onOk: onOk}) {
    const ov = document.createElement("div");
    ov.className = "modalOverlay promoModalOverlay";
    ov.style.backdropFilter = "blur(8px)";
    ov.style.background = "rgba(0, 0, 0, 0.7)";
    const card = document.createElement("div");
    card.className = "modalCard promoModalCard";
    card.innerHTML = `\n      <div class="promoModalHead">\n        <div class="modalTitle">${esc(title)}</div>\n        <button class="promoModalX" type="button" aria-label="Закрыть">×</button>\n      </div>\n      <div class="modalBody"></div>\n      <div class="modalActions">\n        <button class="btn" type="button" data-act="cancel">${esc(cancelText)}</button>\n        <button class="btn ${danger ? "danger" : "gray"}" type="button" data-act="ok">${esc(okText)}</button>\n      </div>`;
    card.querySelector(".modalBody").appendChild(body);
    ov.appendChild(card);
    document.body.appendChild(ov);
    lockBody(true);
    const okBtn = card.querySelector('[data-act="ok"]');
    const close = () => {
      document.removeEventListener("keydown", onKey);
      ov.remove();
      if (!usageModal || usageModal.style.display === "none") lockBody(false);
    };
    const onKey = e => {
      if (e.key === "Escape") close();
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) okBtn.click();
    };
    card.querySelector('[data-act="cancel"]').onclick = close;
    card.querySelector(".promoModalX").onclick = close;
    ov.addEventListener("click", e => {
      if (e.target === ov) close();
    });
    document.addEventListener("keydown", onKey);
    okBtn.onclick = async () => {
      const oldText = okBtn.textContent;
      okBtn.disabled = true;
      okBtn.textContent = "Сохраняю...";
      try {
        await onOk();
        close();
      } catch (e) {
        okBtn.disabled = false;
        okBtn.textContent = oldText;
        toast(false, "Ошибка", normalizeError(e));
      }
    };
    setTimeout(() => {
      const first = card.querySelector("input, select, textarea, button");
      if (first) first.focus();
    }, 30);
    return {
      close: close,
      ov: ov,
      card: card
    };
  }
  async function apiJson(url, opts) {
    const headers = Object.assign({
      "X-Requested-With": "XMLHttpRequest"
    }, opts?.headers || {});
    const r = await fetch(url, Object.assign({
      cache: "no-store",
      credentials: "include",
      headers: headers
    }, opts || {}));
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || !j.ok) {
      const msg = j?.error || "HTTP " + r.status;
      const e = new Error(ERROR_TEXT[msg] || msg);
      e.code = msg;
      throw e;
    }
    return j;
  }
  function normalizeError(e) {
    const msg = e?.message || e?.code || "Ошибка";
    return ERROR_TEXT[msg] || msg;
  }
  function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  function normalizePromo(p) {
    return {
      ...p,
      id: num(p.id),
      donate: num(p.donate),
      money: num(p.money),
      max_uses: num(p.max_uses),
      used_count: num(p.used_count),
      is_active: Number(p.is_active) === 1 || p.is_active === true
    };
  }
  function parseDateValue(s) {
    if (!s) return null;
    if (typeof s === "string" && /^\d+$/.test(s)) s = parseInt(s, 10);
    if (typeof s === "number") {
      return new Date(s < 1e10 ? s * 1e3 : s);
    }
    const raw = String(s).trim();
    if (!raw) return null;
    const d = new Date(raw.replace(" ", "T"));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  function fmtDate(s) {
    if (typeof s === "number" && s > 1e12) s = Math.floor(s / 1e3);
    const d = parseDateValue(s);
    if (!d) return s ? String(s) : "—";
    return d.toLocaleString("ru-RU", {
      dateStyle: "short",
      timeStyle: "short"
    });
  }
  function toDatetimeLocal(s) {
    if (!s) return "";
    return String(s).replace(" ", "T").slice(0, 16);
  }
  function isExpired(dateStr) {
    const d = parseDateValue(dateStr);
    return !!d && d.getTime() < Date.now();
  }
  function isLimitReached(p) {
    return p.max_uses > 0 && p.used_count >= p.max_uses;
  }
  function getState(p) {
    if (isExpired(p.expiration_date)) return {
      cls: "expired",
      text: "Истёк",
      icon: "⏰"
    };
    if (isLimitReached(p)) return {
      cls: "limit",
      text: "Лимит",
      icon: "🚫"
    };
    if (p.is_active) return {
      cls: "active",
      text: "Активен",
      icon: "✅"
    };
    return {
      cls: "off",
      text: "Выключен",
      icon: "⏸"
    };
  }
  function rewardHtml(p) {
    const parts = [];
    if (p.donate > 0) parts.push(`<span class="promoReward donate">₽ ${p.donate.toLocaleString("ru-RU")}</span>`);
    if (p.money > 0) parts.push(`<span class="promoReward money">💰 ${p.money.toLocaleString("ru-RU")}</span>`);
    return parts.length ? `<div class="promoRewards">${parts.join("")}</div>` : "—";
  }
  function limitHtml(p) {
    if (p.max_uses <= 0) return `<div class="promoLimit"><b>∞</b><span>без лимита</span></div>`;
    const pct = Math.max(0, Math.min(100, Math.round(p.used_count / p.max_uses * 100)));
    return `\n      <div class="promoLimit">\n        <b>${p.used_count.toLocaleString("ru-RU")} / ${p.max_uses.toLocaleString("ru-RU")}</b>\n        <span class="promoProgress"><i style="width:${pct}%"></i></span>\n      </div>`;
  }
  function createBtn(text, title, cls, onClick) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `btn small ${cls || ""}`.trim();
    b.textContent = text;
    b.title = title || text;
    b.addEventListener("click", async () => {
      if (b.disabled) return;
      try {
        b.disabled = true;
        await onClick(b);
      } catch (e) {
        toast(false, "Ошибка", normalizeError(e));
      } finally {
        b.disabled = false;
      }
    });
    return b;
  }
  function render(items) {
    const filter = (qInput.value || "").toLowerCase().trim();
    let filtered = items.map(normalizePromo);
    if (filter) filtered = filtered.filter(p => (p.code || "").toLowerCase().includes(filter));
    if (!filtered.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="banEmpty">${filter ? "Ничего не найдено" : "Промокодов пока нет"}</td></tr>`;
      return;
    }
    tbody.innerHTML = "";
    for (const p of filtered) {
      const state = getState(p);
      const tr = document.createElement("tr");
      tr.className = "promoRow";
      tr.innerHTML = `\n        <td>\n          <div class="promoCodeCell">\n            <code>${esc(p.code)}</code>\n            <button class="promoCopy" type="button" title="Скопировать код">⧉</button>\n          </div>\n          <div class="muted" style="font-size:11px">Создал: ${esc(p.created_by || "—")}</div>\n        </td>\n        <td>${rewardHtml(p)}</td>\n        <td>${limitHtml(p)}</td>\n        <td>${p.expiration_date ? fmtDate(p.expiration_date) : "Бессрочный"}</td>\n        <td><strong>${p.used_count.toLocaleString("ru-RU")}</strong></td>\n        <td><span class="promoStatus ${state.cls}">${state.icon} ${state.text}</span></td>\n        <td><div class="promoActions"></div></td>`;
      tr.querySelector(".promoCopy").onclick = async () => {
        try {
          const textToCopy = p.code;
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(textToCopy);
          } else {
            const textArea = document.createElement("textarea");
            textArea.value = textToCopy;
            textArea.style.position = "fixed";
            textArea.style.left = "-9999px";
            textArea.style.top = "0";
            document.body.appendChild(textArea);
            textArea.focus();
            textArea.select();
            document.execCommand("copy");
            textArea.remove();
          }
          toast(true, "Скопировано", p.code);
        } catch (e) {
          console.error("Copy error:", e);
          toast(false, "Ошибка", "Не удалось скопировать");
        }
      };
      const actions = tr.querySelector(".promoActions");
      actions.appendChild(createBtn("Информация", "Кто активировал", "", () => showUsage(p)));
      actions.appendChild(createBtn(p.is_active ? "Выкл" : "Вкл", p.is_active ? "Выключить" : "Включить", "", async () => {
        await apiJson("./api/promos", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            action: "toggle",
            id: p.id
          })
        });
        toast(true, "Готово", p.is_active ? "Промокод выключен" : "Промокод включён");
        await load();
      }));
      actions.appendChild(createBtn("Изм.", "Редактировать", "", () => showPromoForm(p)));
      actions.appendChild(createBtn("Сброс", "Сбросить активации", "", async () => {
        const ok = await confirmAction({
          title: "Сбросить активации?",
          text: `У промокода ${p.code} будут удалены все записи активаций.`,
          okText: "Сбросить",
          cancelText: "Отмена",
          danger: true,
          icon: "↺"
        });
        if (!ok) return;
        await apiJson("./api/promos", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            action: "reset_usage",
            id: p.id
          })
        });
        toast(true, "Готово", "Активации сброшены");
        await load();
      }));
      actions.appendChild(createBtn("Удалить", "Удалить", "danger", async () => {
        const ok = await confirmAction({
          title: "Удалить промокод?",
          text: `Промокод ${p.code} и все его активации будут удалены без восстановления.`,
          okText: "Удалить",
          cancelText: "Отмена",
          danger: true,
          icon: "🗑️"
        });
        if (!ok) return;
        await apiJson("./api/promos", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            action: "delete",
            id: p.id
          })
        });
        toast(true, "Готово", "Промокод удалён");
        await load();
      }));
      tbody.appendChild(tr);
    }
  }
  function updateStats(items) {
    const normalized = items.map(normalizePromo);
    const total = normalized.length;
    const active = normalized.filter(p => p.is_active && !isExpired(p.expiration_date) && !isLimitReached(p)).length;
    const uses = normalized.reduce((s, p) => s + p.used_count, 0);
    totalPromos.textContent = total.toLocaleString("ru-RU");
    activePromos.textContent = active.toLocaleString("ru-RU");
    totalUses.textContent = uses.toLocaleString("ru-RU");
    statsRow.style.display = "";
  }
  async function load() {
    if (loading) return;
    loading = true;
    apiStatus.textContent = "API: загрузка...";
    err.style.display = "none";
    refreshBtn.disabled = true;
    try {
      const j = await apiJson("./api/promos");
      allItems = (j.items || []).map(normalizePromo);
      render(allItems);
      updateStats(allItems);
      apiStatus.textContent = "API: OK";
    } catch (e) {
      apiStatus.textContent = "API: ERROR";
      err.textContent = normalizeError(e);
      err.style.display = "";
      tbody.innerHTML = `<tr><td colspan="7" class="banEmpty">Ошибка загрузки</td></tr>`;
      toast(false, "Ошибка", "Не удалось загрузить промокоды");
    } finally {
      refreshBtn.disabled = false;
      loading = false;
    }
  }
  function field(label, id, type, value, hint = "", extra = "") {
    return `\n      <label class="promoField">\n        <span>${esc(label)}</span>\n        <input class="modalInput" id="${esc(id)}" type="${esc(type)}" value="${esc(value ?? "")}" ${extra} />\n        ${hint ? `<small>${esc(hint)}</small>` : ""}\n      </label>`;
  }
  function showPromoForm(p = null) {
    const isEdit = !!p;
    if (p) p = normalizePromo(p);
    const wrap = document.createElement("div");
    wrap.className = "promoForm";
    wrap.innerHTML = `\n      ${isEdit ? `<div class="promoFormNotice">Редактирование: <strong>${esc(p.code)}</strong></div>` : ""}\n      <div class="promoFormGrid">\n        ${!isEdit ? field("Код промокода", "pCode", "text", "", "A-Z, 0-9, _, минимум 2 символа", 'maxlength="64" autocomplete="off" style="text-transform:uppercase"') : ""}\n        ${field("Донат-рубли", "pDonate", "number", p?.donate ?? 0, "0 = не выдавать", 'min="0" step="1"')}\n        ${field("Игровые деньги", "pMoney", "number", p?.money ?? 0, "0 = не выдавать", 'min="0" step="1"')}\n        ${field("Макс. активаций", "pMaxUses", "number", p?.max_uses ?? 0, "0 = без лимита", 'min="0" step="1"')}\n        ${field("Дата истечения", "pExpDate", "datetime-local", toDatetimeLocal(p?.expiration_date), "Пусто = бессрочный")}\n      </div>\n      <label class="uiCheck promoActiveCheck">\n        <input id="pActive" type="checkbox" ${!isEdit || p.is_active ? "checked" : ""} />\n        <span>Промокод включён</span>\n      </label>`;
    modal({
      title: isEdit ? "Редактировать промокод" : "Создать промокод",
      body: wrap,
      okText: isEdit ? "Сохранить" : "Создать",
      onOk: async () => {
        let code = p?.code;
        if (!isEdit) {
          code = (wrap.querySelector("#pCode").value || "").trim().toUpperCase().replace(/[^A-Z0-9_]/g, "");
          wrap.querySelector("#pCode").value = code;
          if (!code || code.length < 2 || code.length > 64) throw new Error(ERROR_TEXT.BAD_CODE);
        }
        const donate = Math.max(0, parseInt(wrap.querySelector("#pDonate").value, 10) || 0);
        const money = Math.max(0, parseInt(wrap.querySelector("#pMoney").value, 10) || 0);
        if (donate === 0 && money === 0) throw new Error(ERROR_TEXT.BAD_REWARD);
        const maxUses = Math.max(0, parseInt(wrap.querySelector("#pMaxUses").value, 10) || 0);
        const expRaw = wrap.querySelector("#pExpDate").value;
        const expiration_date = expRaw ? expRaw.replace("T", " ") + ":00" : null;
        const is_active = wrap.querySelector("#pActive").checked;
        await apiJson("./api/promos", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            action: isEdit ? "update" : "create",
            id: p?.id,
            code: code,
            donate: donate,
            money: money,
            max_uses: maxUses,
            expiration_date: expiration_date,
            is_active: is_active
          })
        });
        toast(true, "Готово", isEdit ? "Промокод обновлён" : `Промокод ${code} создан`);
        await load();
      }
    });
  }
  async function showUsage(p) {
    p = normalizePromo(p);
    usageCode.textContent = p.code;
    usageTbody.innerHTML = `<tr><td colspan="3" class="banEmpty">Загрузка...</td></tr>`;
    usageModal.style.display = "flex";
    usageModal.style.backdropFilter = "blur(8px)";
    usageModal.style.background = "rgba(0, 0, 0, 0.7)";
    usageTbody.style.borderCollapse = "separate";
    usageTbody.style.borderSpacing = "0 8px";
    lockBody(true);
    try {
      const j = await apiJson(`./api/promos/usage?promo_id=${encodeURIComponent(p.id)}`);
      const items = j.items || [];
      if (!items.length) {
        usageTbody.innerHTML = `<tr><td colspan="3" class="banEmpty">Никто ещё не активировал</td></tr>`;
        return;
      }
      usageTbody.innerHTML = "";
      for (const u of items) {
        const tr = document.createElement("tr");
        const profileUrl = u.steamid64 ? `/player?sid=${encodeURIComponent(u.steamid64)}` : "#";
        const rankName = resolveRank(u.rank_id);
        const rankColor = RANK_COLORS[rankName] || RANK_COLORS[rankName.toLowerCase()] || "var(--muted)";
        tr.innerHTML = `\n          <td style="padding: 12px 10px; vertical-align: middle;">\n            <div style="display:flex;flex-direction:column;gap:4px;">\n              <a href="${profileUrl}" class="promoUsageNick" style="color:var(--accent);font-weight:600;font-size:14px;display:block;">${esc(u.nickname || "—")}</a>\n              <span class="promoRankBadge" style="font-size:10px;padding:2px 8px;border-radius:4px;border:1px solid ${rankColor};color:${rankColor};width:fit-content;text-transform:uppercase;font-weight:700;line-height:1;">\n                ${esc(rankName)}\n              </span>\n            </div>\n          </td>\n          <td style="padding: 12px 10px; vertical-align: middle;">\n            <div style="display:flex;flex-direction:column;gap:2px;">\n              <code style="color:var(--text);font-family:monospace;">${esc(u.steamid32 || "—")}</code>\n              <small class="muted" style="font-size:10px; opacity: 0.6;">${esc(u.steamid64 || "")}</small>\n            </div>\n          </td>\n          <td style="padding: 12px 10px; vertical-align: middle; white-space: nowrap;">\n            <span style="color:var(--text);">${fmtDate(u.used_at)}</span>\n          </td>`;
        usageTbody.appendChild(tr);
      }
    } catch (e) {
      usageTbody.innerHTML = `<tr><td colspan="3" class="banEmpty">${esc(normalizeError(e))}</td></tr>`;
    }
  }
  function hideUsage() {
    usageModal.style.display = "none";
    if (!document.querySelector(".promoModalOverlay")) lockBody(false);
  }
  usageClose.onclick = hideUsage;
  if (usageCloseX) usageCloseX.onclick = hideUsage;
  usageModal.onclick = e => {
    if (e.target === usageModal) hideUsage();
  };
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && usageModal.style.display !== "none") hideUsage();
  });
  addPromoBtn.onclick = () => showPromoForm();
  refreshBtn.onclick = async () => {
    await load();
    toast(true, "Обновлено", "Данные актуальны");
  };
  let searchTimer = null;
  qInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => render(allItems), 120);
  });
  await load();
})();
