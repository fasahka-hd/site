(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const grid = $("gangGrid"), stats = $("gangStats"), q = $("gangQ"), system = $("gangSystem"), count = $("gangCount"), err = $("gangErr");
  let timer = null;
  function esc(s) {
    const d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }
  function money(v) {
    if (v === null || v === undefined || v === "") return "—";
    return Number(v || 0).toLocaleString("ru-RU") + " ₽";
  }
  function num(v) {
    if (v === null || v === undefined || v === "") return "—";
    return Number(v || 0).toLocaleString("ru-RU");
  }
  function date(ts) {
    ts = Number(ts || 0);
    if (!ts) return "—";
    return new Date(ts * 1e3).toLocaleString("ru-RU");
  }
  function toast(ok, title, text) {
    if (window.UI) window.UI.toast({
      ok: ok,
      title: title,
      text: text
    });
  }
  function totalPill(total) {
    return `<div class="gangTotalPill"><span>🛡️</span><strong>${Number(total || 0).toLocaleString("ru-RU")}</strong><em>всего банд</em></div>`;
  }
  async function api(url, opts) {
    const r = await fetch(url, {
      cache: "no-store",
      credentials: "include",
      ...opts || {}
    });
    if (r.status === 401) {
      location.href = "/login";
      throw new Error("NOT_AUTH");
    }
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || !j.ok) throw new Error(j?.error || "HTTP " + r.status);
    return j;
  }
  function skeleton() {
    grid.innerHTML = "";
    for (let i = 0; i < 8; i++) {
      const c = document.createElement("div");
      c.className = "skeletonCard";
      c.innerHTML = '<div class="skel skelLine w70"></div><div class="skel skelLine w40"></div><div class="skel skelLine"></div>';
      grid.appendChild(c);
    }
  }
  async function load(showSkeleton = true) {
    try {
      err.style.display = "none";
      if (showSkeleton) skeleton();
      const params = new URLSearchParams({
        q: q.value.trim(),
        system: system.value || "all"
      });
      const j = await api("./api/tech_gangs?" + params);
      render(j.items || []);
    } catch (e) {
      grid.innerHTML = '<div class="banEmpty">Ошибка загрузки</div>';
      err.style.display = "";
      toast(false, "Ошибка", e.message || "Не удалось загрузить банды");
    }
  }
  function render(items) {
    count.textContent = `Банд найдено: ${Number(items.length || 0).toLocaleString("ru-RU")}`;
    stats.innerHTML = totalPill(items.length);
    grid.innerHTML = "";
    if (!items.length) {
      grid.innerHTML = '<div class="banEmpty">Банды не найдены</div>';
      return;
    }
    for (const g of items) {
      const metrics = [];
      if (g.reputation !== null && g.reputation !== undefined) metrics.push([ "Репутация", num(g.reputation) ]);
      if (g.lvl !== null && g.lvl !== undefined) metrics.push([ "Уровень", num(g.lvl) ]);
      if (g.xp !== null && g.xp !== undefined) metrics.push([ "XP", num(g.xp) ]);
      if (g.points !== null && g.points !== undefined) metrics.push([ "Очки", `${num(g.points)} / ${num(g.maxpoints)}` ]);
      if (g.bank !== null && g.bank !== undefined) metrics.push([ "Банк", money(g.bank) ]);
      metrics.push([ "Участники", num(g.members_count) ]);
      const rankLine = Array.isArray(g.ranks) && g.ranks.length ? `<div class="gangRanks"><strong>Ранги:</strong> ${esc(g.ranks.slice(0, 6).join(", "))}${g.ranks.length > 6 ? "…" : ""}</div>` : "";
      const card = document.createElement("div");
      card.className = "gangCard";
      card.innerHTML = `<div class="gangHead"><div><div class="gangName">${esc(g.name)}</div><div class="gangSystem">ID: ${esc(g.id)}</div></div></div><div class="gangOwner"><span>Владелец:</span><strong>${esc(g.owner_name || "—")}</strong><code>${esc(g.owner_steamid64 || "—")}</code></div><div class="gangMetrics">${metrics.map(([k, v]) => `<div><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`).join("")}</div><div class="gangDesc">${esc(g.description || "Описание отсутствует")}</div>${rankLine}<div class="gangCreated">Создано: ${esc(date(g.created))}</div><div class="gangActions"><button class="btn gray gangOpenBtn" type="button">Войти / управлять</button></div>`;
      card.querySelector("button").addEventListener("click", () => openGang(g.system, g.id));
      grid.appendChild(card);
    }
  }
  async function openGang(sys, id) {
    try {
      const j = await api("./api/tech_gangs/detail?" + new URLSearchParams({
        system: sys,
        id: String(id)
      }));
      showGangModal(j.gang, j.members || []);
    } catch (e) {
      toast(false, "Ошибка", e.message || "Не удалось открыть банду");
    }
  }
  function closeModal() {
    document.querySelector(".gangModalOverlay")?.remove();
  }
  function showGangModal(g, members) {
    closeModal();
    const ov = document.createElement("div");
    ov.className = "gangModalOverlay";
    const isF4 = g.system === "f4";
    const controls = isF4 ? `<button data-act="bank_delta" data-sign="1" class="btn gangCtl green">+ деньги</button><button data-act="bank_delta" data-sign="-1" class="btn gangCtl danger">- деньги</button><button data-act="reputation_delta" data-sign="1" class="btn gangCtl green">+ репутация</button><button data-act="reputation_delta" data-sign="-1" class="btn gangCtl danger">- репутация</button><button data-act="set_bank" class="btn gangCtl">Поставить банк</button><button data-act="set_reputation" class="btn gangCtl">Поставить репутацию</button>` : `<button data-act="bank_delta" data-sign="1" class="btn gangCtl green">+ деньги</button><button data-act="bank_delta" data-sign="-1" class="btn gangCtl danger">- деньги</button><button data-act="xp_delta" data-sign="1" class="btn gangCtl green">+ XP</button><button data-act="xp_delta" data-sign="-1" class="btn gangCtl danger">- XP</button><button data-act="points_delta" data-sign="1" class="btn gangCtl green">+ очки</button><button data-act="points_delta" data-sign="-1" class="btn gangCtl danger">- очки</button><button data-act="set_bank" class="btn gangCtl">Поставить банк</button><button data-act="set_lvl" class="btn gangCtl">Поставить уровень</button>`;
    ov.innerHTML = `<div class="gangModal"><div class="gangModalHead"><div class="gangModalTitleWrap"><div class="gangModalTitle">${esc(g.name)}</div><div class="muted">ID: ${esc(g.id)}</div></div><button class="btn gangCloseBtn" data-close="1" type="button">Закрыть</button></div><div class="gangModalBody"><section class="gangModalMain"><div class="gangMetrics modalMetrics">${metricHtml("Банк", money(g.bank))}${isF4 ? metricHtml("Репутация", num(g.reputation)) : metricHtml("Уровень", num(g.lvl)) + metricHtml("XP", num(g.xp)) + metricHtml("Очки", `${num(g.points)} / ${num(g.maxpoints)}`)}${metricHtml("Участники", members.length)}</div><div class="gangControlBox"><div class="gangControlTitle">Операции</div><input class="input gangAmountInput" id="gangAmount" type="number" step="1" placeholder="Введите значение"><div class="gangControlHint">Без значения операция не выполнится.</div><div class="gangControlButtons">${controls}</div></div><button data-act="reset_rating" class="btn gangCtl danger gangResetBtn">${isF4 ? "Обнулить репутацию" : "Обнулить рейтинг (очки, XP, уровень)"}</button><button data-act="delete_gang" class="btn danger gangDeleteBtn">Удалить банду</button></section><section class="gangMembersPanel"><div class="gangPanelHead"><div class="h2">Участники</div><div class="muted">Нажми на игрока, чтобы открыть профиль</div></div><div class="gangMemberList">${members.map(memberHtml).join("") || '<div class="banEmpty">Участников нет</div>'}</div></section></div></div>`;
    document.body.appendChild(ov);
    ov.querySelector("[data-close]").addEventListener("click", closeModal);
    ov.addEventListener("click", e => {
      if (e.target === ov) closeModal();
    });
    ov.querySelectorAll("[data-act]").forEach(btn => btn.addEventListener("click", () => handleAction(g, btn)));
    ov.querySelectorAll("[data-kick]").forEach(btn => btn.addEventListener("click", e => {
      e.stopPropagation();
      kickMember(g, btn.dataset.kick);
    }));
    ov.querySelectorAll("[data-profile]").forEach(row => row.addEventListener("click", () => {
      location.href = "/player?sid=" + encodeURIComponent(row.dataset.profile);
    }));
    setTimeout(() => ov.querySelector("#gangAmount")?.focus(), 80);
  }
  function metricHtml(k, v) {
    return `<div><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`;
  }
  function memberHtml(m) {
    return `<div class="gangMember" data-profile="${esc(m.steamid64)}" role="button" tabindex="0"><div class="gangMemberInfo"><strong>${esc(m.name || m.steamid64)}</strong><div class="muted">${esc(m.rank_name || "—")} · ${esc(m.steamid64)}</div></div><button class="btn small danger" data-kick="${esc(m.steamid64)}" type="button">Выгнать</button></div>`;
  }
  async function handleAction(g, btn) {
    const act = btn.dataset.act;
    if (act === "reset_rating") {
      const isF4 = g.system === "f4";
      const ok = window.UI && window.UI.confirm ? await window.UI.confirm({
        title: "Обнулить рейтинг банды?",
        text: isF4 ? `Репутация банды «${g.name}» будет обнулена.` : `Очки, XP и уровень банды «${g.name}» будут обнулены.`,
        okText: "Обнулить",
        cancelText: "Отмена",
        danger: true,
        icon: "🧹"
      }) : confirm(`Обнулить рейтинг банды ${g.name}?`);
      if (!ok) return;
      await doAction({
        system: g.system,
        id: g.id,
        action: act
      });
      await refreshModal(g);
      await load(false);
      return;
    }
    if (act === "delete_gang") {
      const ok = await confirmDeleteGang(g);
      if (!ok) return;
      await doAction({
        system: g.system,
        id: g.id,
        action: act
      });
      closeModal();
      await load(false);
      return;
    }
    const inp = document.getElementById("gangAmount");
    const raw = (inp?.value || "").trim();
    if (!raw) return toast(false, "Ошибка", "Сначала впишите значение");
    let amount = Number(raw);
    if (!Number.isFinite(amount)) return toast(false, "Ошибка", "Введите нормальное число");
    const sign = Number(btn.dataset.sign || 1);
    if (btn.dataset.sign) amount = Math.abs(amount) * sign;
    await doAction({
      system: g.system,
      id: g.id,
      action: act,
      amount: amount
    });
    await refreshModal(g);
    await load(false);
  }
  async function kickMember(g, sid) {
    const ok = window.UI && window.UI.confirm ? await window.UI.confirm({
      title: "Выгнать игрока?",
      text: `SteamID64: ${sid}`,
      okText: "Выгнать",
      cancelText: "Отмена",
      danger: true,
      icon: "👢"
    }) : confirm(`Выгнать игрока ${sid} из банды?`);
    if (!ok) return;
    await doAction({
      system: g.system,
      id: g.id,
      action: "kick_member",
      steamid64: sid
    });
    await refreshModal(g);
    await load(false);
  }
  function confirmDeleteGang(g) {
    return new Promise(resolve => {
      const ov = document.createElement("div");
      ov.className = "gangDeleteConfirmOverlay";
      ov.innerHTML = `<div class="gangDeleteConfirm"><div class="confirmIcon danger">🗑️</div><div class="confirmTitle">Удалить банду?</div><div class="confirmText">Это удалит банду <strong>${esc(g.name)}</strong> и связанных участников. Для подтверждения впишите название банды:</div><input class="input" id="deleteGangName" placeholder="${esc(g.name)}"><div class="confirmActions"><button class="btn" data-cancel>Отмена</button><button class="btn danger" data-ok disabled>Удалить</button></div></div>`;
      document.body.appendChild(ov);
      const inp = ov.querySelector("#deleteGangName"), ok = ov.querySelector("[data-ok]"), cancel = ov.querySelector("[data-cancel]");
      const close = val => {
        ov.remove();
        resolve(val);
      };
      inp.addEventListener("input", () => {
        ok.disabled = inp.value.trim() !== String(g.name).trim();
      });
      ok.addEventListener("click", () => close(true));
      cancel.addEventListener("click", () => close(false));
      ov.addEventListener("click", e => {
        if (e.target === ov) close(false);
      });
      setTimeout(() => inp.focus(), 60);
    });
  }
  async function doAction(payload) {
    await api("./api/tech_gangs/action", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Requested-With": "XMLHttpRequest"
      },
      body: JSON.stringify(payload)
    });
    toast(true, "Готово", "Операция выполнена");
  }
  async function refreshModal(g) {
    try {
      const j = await api("./api/tech_gangs/detail?" + new URLSearchParams({
        system: g.system,
        id: String(g.id)
      }));
      showGangModal(j.gang, j.members || []);
    } catch (e) {
      closeModal();
      toast(false, "Ошибка", "Банда больше не найдена");
    }
  }
  function debounce() {
    clearTimeout(timer);
    timer = setTimeout(() => load(false), 350);
  }
  async function resetAllRatings() {
    const sys = system.value || "all";
    const sysLabel = sys === "f4" ? "F4 gangs (репутация)" : sys === "legacy" ? "gangs (очки, XP, уровень)" : "обеих систем (репутация F4 и очки/XP/уровень gangs)";
    const ok = window.UI && window.UI.confirm ? await window.UI.confirm({
      title: "Обнулить рейтинг всех банд?",
      text: `Будет обнулён рейтинг ВСЕХ банд — ${sysLabel}. Отменить действие нельзя.`,
      okText: "Обнулить всё",
      cancelText: "Отмена",
      danger: true,
      icon: "🧹"
    }) : confirm("Обнулить рейтинг всех банд?");
    if (!ok) return;
    try {
      await api("./api/tech_gangs/action", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "XMLHttpRequest"
        },
        body: JSON.stringify({
          system: sys,
          action: "reset_rating_all"
        })
      });
      toast(true, "Готово", "Рейтинг банд обнулён");
      await load(false);
    } catch (e) {
      toast(false, "Ошибка", e.message || "Не удалось обнулить рейтинг");
    }
  }
  q.addEventListener("input", debounce);
  system.addEventListener("change", () => load());
  $("gangRefresh").addEventListener("click", () => load());
  $("gangResetAll").addEventListener("click", resetAllRatings);
  document.addEventListener("DOMContentLoaded", () => load());
})();
