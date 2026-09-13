(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const statsEl = $("duelStats"), syncLine = $("duelSyncLine");
  const lobbyGrid = $("duelLobbyGrid"), activeCount = $("duelActiveCount"), activeErr = $("duelActiveErr");
  const topTbody = $("duelTopTbody"), topCount = $("duelTopCount");
  const plTbody = $("duelPlayersTbody"), plCount = $("duelPlayersCount"), plPage = $("duelPlayersPage"), plQ = $("duelPlayerQ"), plSort = $("duelPlayerSort"), plErr = $("duelPlayersErr");
  const hTbody = $("duelHistTbody"), hCount = $("duelHistCount"), hPage = $("duelHistPage"), hQ = $("duelHistQ"), hResult = $("duelHistResult"), hErr = $("duelHistErr");
  let curTab = "active";
  let plPageNum = 1, plPages = 1, plTimer = null;
  let hPageNum = 1, hPages = 1, hTimer = null;
  let lastLobbies = [];
  const WEAPON_NAMES = {
    weapon_pistol: "Пистолет",
    weapon_357: "Magnum .357",
    weapon_smg1: "Пистолет-пулемёт",
    weapon_ar2: "Импульсная винтовка",
    weapon_shotgun: "Дробовик",
    weapon_crossbow: "Арбалет",
    weapon_crowbar: "Монтировка",
    weapon_stunstick: "Электродубинка",
    weapon_deagle: "Desert Eagle",
    weapon_fists: "Кулаки"
  };
  function esc(s) {
    const d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
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
  function ago(ts) {
    ts = Number(ts || 0);
    if (!ts) return "никогда";
    const s = Math.max(0, Math.floor((Date.now() - ts) / 1e3));
    if (s < 5) return "только что";
    if (s < 60) return `${s} сек. назад`;
    if (s < 3600) return `${Math.floor(s / 60)} мин. назад`;
    return new Date(ts).toLocaleString("ru-RU");
  }
  function wepName(cls) {
    cls = String(cls || "");
    if (!cls) return "—";
    return WEAPON_NAMES[cls] || cls;
  }
  function stake(l) {
    const cur = l.donate ? "₽" : "$";
    return Number(l.amount || 0).toLocaleString("ru-RU") + " " + cur;
  }
  function toast(ok, title, text) {
    if (window.UI) window.UI.toast({
      ok: ok,
      title: title,
      text: text
    });
  }
  async function uiConfirm(o) {
    if (window.UI && window.UI.confirm) return window.UI.confirm(o);
    return confirm(`${o.title}\n${o.text || ""}`);
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
  async function postAction(payload) {
    return api("./api/tech_duels/action", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Requested-With": "XMLHttpRequest"
      },
      body: JSON.stringify(payload)
    });
  }
  function statCard(icon, value, title) {
    return `<div class="techStat"><div class="techStatIcon">${icon}</div><div><div class="techStatValue">${esc(value)}</div><div class="techStatTitle">${esc(title)}</div></div></div>`;
  }
  function renderStats(j) {
    const s = j.stats || {};
    const activeNow = (j.lobbies || []).filter(l => l.started).length;
    const waiting = (j.lobbies || []).filter(l => !l.started).length;
    statsEl.innerHTML = statCard("⚔️", num(activeNow), "Идёт боёв сейчас") + statCard("⏳", num(waiting), "Ожидают соперника") + statCard("👥", num(s.players), "Игроков в статистике") + statCard("🏆", num(s.total_wins), "Всего побед") + statCard("💀", num(s.total_losses), "Всего поражений") + statCard("🎯", num(s.total_duels), "Всего рейтинговых дуэлей") + statCard("📜", num(s.history_rows), "Записей в истории");
    const sync = j.sync || {};
    const lobFresh = sync.lobbies_fresh;
    syncLine.innerHTML = lobFresh ? `🟢 Сервер онлайн · обновлено ${esc(ago(sync.lobbies_at))}` : `🔴 Нет связи с игровым сервером · последние данные ${esc(ago(sync.lobbies_at))}`;
    syncLine.classList.toggle("duelSyncBad", !lobFresh);
  }
  function lobbyBadge(l) {
    const badges = [];
    badges.push(l.started ? '<span class="duelBadge live">Бой идёт</span>' : '<span class="duelBadge wait">Ожидание</span>');
    if (l.donate) badges.push('<span class="duelBadge donate">Донат</span>');
    if (l.rating) badges.push('<span class="duelBadge rating">Рейтинговая</span>');
    if (l.armor) badges.push('<span class="duelBadge armor">Броня</span>');
    return badges.join("");
  }
  function renderLobbies(items) {
    lastLobbies = items;
    const started = items.filter(l => l.started).length;
    activeCount.textContent = `Активных дуэлей: ${items.length} · боёв идёт: ${started} · ожидают соперника: ${items.length - started}`;
    lobbyGrid.innerHTML = "";
    if (!items.length) {
      lobbyGrid.innerHTML = '<div class="banEmpty">Сейчас нет активных или занятых дуэлей</div>';
      return;
    }
    for (const l of items) {
      const card = document.createElement("div");
      card.className = "gangCard duelCard";
      const targetHtml = l.target_sid ? `<div class="duelSide"><strong>${esc(l.target_name || "—")}</strong><code>${esc(l.target_sid)}</code></div>` : '<div class="duelSide duelWait"><strong>Пусто</strong><span>соперник не найден</span></div>';
      card.innerHTML = `<div class="gangHead"><div><div class="gangName">Дуэль #${esc(l.id)}</div><div class="gangSystem">${l.started ? `Арена №${esc(l.arena || "—")}` : "Лобби"}</div></div><div class="duelBadges">${lobbyBadge(l)}</div></div><div class="duelVersus"><div class="duelSide"><strong>${esc(l.owner_name || "—")}</strong><code>${esc(l.owner_sid || "—")}</code><div class="duelWr">🏆 ${num(l.victories)} / 💀 ${num(l.losses)}</div></div><div class="duelVs">VS</div>${targetHtml}</div><div class="gangMetrics duelMeta">${metric("Ставка", stake(l))}${metric("Оружие", wepName(l.weapon_name || l.weapon))}${l.started ? metric("Осталось", sec(l.time_left)) : metric("Статус", "Открыта")}${metric("Тип", l.donate ? "На донат" : "На деньги")}</div>`;
      const ownerSide = card.querySelector(".duelSide");
      if (ownerSide && l.owner_sid) ownerSide.style.cursor = "pointer", ownerSide.addEventListener("click", () => openPlayer(l.owner_sid));
      lobbyGrid.appendChild(card);
    }
  }
  function metric(k, v) {
    return `<div><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`;
  }
  function sec(v) {
    v = Math.max(0, Number(v || 0));
    const m = Math.floor(v / 60), s = v % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }
  async function loadOverview() {
    try {
      activeErr.style.display = "none";
      const j = await api("./api/tech_duels/overview");
      renderStats(j);
      renderLobbies(j.lobbies || []);
    } catch (e) {
      activeErr.style.display = "";
      toast(false, "Ошибка", e.message || "Не удалось загрузить дуэли");
    }
  }
  async function loadTop() {
    try {
      if (window.UI && window.UI.skeletonRows) window.UI.skeletonRows(topTbody, 6, 7);
      const j = await api("./api/tech_duels/top?limit=20");
      topCount.textContent = `Топ игроков по победам в рейтинговых дуэлях`;
      topTbody.innerHTML = "";
      if (!j.items.length) {
        topTbody.innerHTML = '<tr><td colspan="7" class="banEmpty">Пока никто не выиграл ни одной рейтинговой дуэли</td></tr>';
        return;
      }
      j.items.forEach((p, i) => {
        const tr = document.createElement("tr");
        tr.className = "duelRowLink";
        const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : String(i + 1);
        tr.innerHTML = `<td data-label="#"><strong>${medal}</strong></td><td data-label="Игрок"><strong class="nickText">${esc(p.name)}</strong></td><td data-label="SteamID64"><code class="copyId">${esc(p.steamid64)}</code></td><td data-label="Побед"><span class="duelWinText">${num(p.wins)}</span></td><td data-label="Поражений"><span class="duelLoseText">${num(p.losses)}</span></td><td data-label="Винрейт"><strong>${p.winrate}%</strong></td><td data-label="Любимое оружие">${esc(wepName(p.favourite))}</td>`;
        tr.addEventListener("click", () => openPlayer(p.steamid64));
        topTbody.appendChild(tr);
      });
    } catch (e) {
      topTbody.innerHTML = '<tr><td colspan="7" class="banEmpty">Ошибка загрузки</td></tr>';
      toast(false, "Ошибка", e.message || "Не удалось загрузить топ");
    }
  }
  async function loadPlayers() {
    try {
      plErr.style.display = "none";
      if (window.UI && window.UI.skeletonRows) window.UI.skeletonRows(plTbody, 8, 8);
      const params = new URLSearchParams({
        page: String(plPageNum),
        per_page: "50",
        q: plQ.value.trim(),
        sort: plSort.value || "total"
      });
      const j = await api("./api/tech_duels/players?" + params);
      plPages = j.pages || 1;
      plPageNum = j.page || plPageNum;
      plCount.textContent = `Игроков: ${num(j.total)}`;
      plPage.textContent = `Страница ${plPageNum}/${plPages}`;
      plTbody.innerHTML = "";
      if (!j.items.length) {
        plTbody.innerHTML = '<tr><td colspan="8" class="banEmpty">Игроки не найдены</td></tr>';
        return;
      }
      for (const p of j.items) {
        const tr = document.createElement("tr");
        tr.className = "duelRowLink";
        tr.innerHTML = `<td data-label="Игрок"><strong class="nickText">${esc(p.name)}</strong></td><td data-label="SteamID64"><code class="copyId">${esc(p.steamid64)}</code></td><td data-label="Побед"><span class="duelWinText">${num(p.wins)}</span></td><td data-label="Поражений"><span class="duelLoseText">${num(p.losses)}</span></td><td data-label="Всего">${num(p.wins + p.losses)}</td><td data-label="Винрейт"><strong>${p.winrate}%</strong></td><td data-label="Любимое оружие">${esc(wepName(p.favourite))}</td><td data-label="Действия"><button class="btn small danger" type="button">Обнулить</button></td>`;
        tr.addEventListener("click", () => openPlayer(p.steamid64));
        tr.querySelector("button").addEventListener("click", async e => {
          e.stopPropagation();
          await resetPlayer(p.steamid64, p.name);
        });
        plTbody.appendChild(tr);
      }
    } catch (e) {
      plTbody.innerHTML = '<tr><td colspan="8" class="banEmpty">Ошибка загрузки</td></tr>';
      plErr.style.display = "";
      toast(false, "Ошибка", e.message || "Не удалось загрузить игроков");
    }
  }
  function histRow(h) {
    const win = String(h.result || "") === "win";
    const tr = document.createElement("tr");
    tr.className = win ? "moneyIncome" : "moneyExpense";
    tr.innerHTML = `<td data-label="Время">${esc(date(h.stamp))}</td><td data-label="Игрок"><strong class="nickText">${esc(h.name)}</strong></td><td data-label="Оппонент"><strong>${esc(h.opponent)}</strong></td><td data-label="Результат">${win ? '<span class="duelBadge win">Победа</span>' : '<span class="duelBadge lose">Поражение</span>'}</td><td data-label="Ставка"><span class="moneyPill">${esc(num(h.amount))} ${h.donate ? "₽" : "$"}</span></td><td data-label="Тип">${h.donate ? '<span class="duelBadge donate">Донат</span>' : '<span class="duelBadge">Деньги</span>'}</td><td data-label="Оружие">${esc(wepName(h.weapon))}</td>`;
    return tr;
  }
  async function loadHistory() {
    try {
      hErr.style.display = "none";
      if (window.UI && window.UI.skeletonRows) window.UI.skeletonRows(hTbody, 8, 7);
      const params = new URLSearchParams({
        page: String(hPageNum),
        per_page: "50",
        q: hQ.value.trim(),
        result: hResult.value || "all"
      });
      const j = await api("./api/tech_duels/history?" + params);
      hPages = j.pages || 1;
      hPageNum = j.page || hPageNum;
      hCount.textContent = `Записей: ${num(j.total)}`;
      hPage.textContent = `Страница ${hPageNum}/${hPages}`;
      hTbody.innerHTML = "";
      if (!j.items.length) {
        hTbody.innerHTML = '<tr><td colspan="7" class="banEmpty">История дуэлей пуста</td></tr>';
        return;
      }
      for (const h of j.items) hTbody.appendChild(histRow(h));
    } catch (e) {
      hTbody.innerHTML = '<tr><td colspan="7" class="banEmpty">Ошибка загрузки</td></tr>';
      hErr.style.display = "";
      toast(false, "Ошибка", e.message || "Не удалось загрузить историю");
    }
  }
  function closeModal() {
    document.querySelector(".gangModalOverlay")?.remove();
  }
  async function openPlayer(sid) {
    try {
      const j = await api("./api/tech_duels/player?" + new URLSearchParams({
        sid: String(sid)
      }));
      showPlayerModal(j);
    } catch (e) {
      toast(false, "Ошибка", e.message || "Не удалось открыть игрока");
    }
  }
  function showPlayerModal(j) {
    closeModal();
    const st = j.stats;
    const ov = document.createElement("div");
    ov.className = "gangModalOverlay";
    if (!st) {
      ov.innerHTML = `<div class="gangModal"><div class="gangModalHead"><div class="gangModalTitleWrap"><div class="gangModalTitle">Игрок не найден</div><div class="muted">Статистика дуэлей отсутствует</div></div><button class="btn gangCloseBtn" data-close="1" type="button">Закрыть</button></div></div>`;
    } else {
      const lobbyHtml = j.lobby ? `<div class="duelNowBox">${lobbyBadge(j.lobby)}<div class="muted">Сейчас в дуэли #${esc(j.lobby.id)} · ставка ${esc(stake(j.lobby))} · ${esc(wepName(j.lobby.weapon_name || j.lobby.weapon))}${j.lobby.started ? ` · осталось ${esc(sec(j.lobby.time_left))}` : ""}</div></div>` : "";
      const weaponsHtml = (j.weapons || []).length ? `<div class="gangControlBox"><div class="gangControlTitle">Оружие в дуэлях</div><div class="duelWeapons">${j.weapons.map(w => `<span class="duelWep"><strong>${esc(wepName(w.weapon))}</strong> ×${num(w.uses)}</span>`).join("")}</div></div>` : "";
      const histHtml = (j.history || []).map(h => {
        const win = String(h.result || "") === "win";
        return `<div class="gangMember duelHistItem"><div class="gangMemberInfo"><strong>${win ? "🏆 Победа" : "💀 Поражение"} против ${esc(h.opponent || "—")}</strong><div class="muted">${esc(date(h.stamp))} · ${esc(wepName(h.weapon))} · ставка ${esc(num(h.amount))} ${h.donate ? "₽" : "$"}</div></div></div>`;
      }).join("");
      ov.innerHTML = `<div class="gangModal"><div class="gangModalHead"><div class="gangModalTitleWrap"><div class="gangModalTitle">${esc(st.name)}</div><div class="muted">SteamID64: ${esc(st.steamid64)}</div></div><button class="btn gangCloseBtn" data-close="1" type="button">Закрыть</button></div><div class="gangModalBody"><section class="gangModalMain"><div class="gangMetrics modalMetrics">${metric("Победы", num(st.wins))}${metric("Поражения", num(st.losses))}${metric("Всего дуэлей", num(st.wins + st.losses))}${metric("Винрейт", st.winrate + "%")}${metric("Любимое оружие", wepName(st.favourite))}${metric("Обновлено", date(st.updated_ts))}</div>${lobbyHtml}${weaponsHtml}<button class="btn danger gangDeleteBtn" id="duelResetPlayerBtn" type="button">🧹 Обнулить победы и поражения</button></section><section class="gangMembersPanel"><div class="gangPanelHead"><div class="h2">Последние дуэли</div><div class="muted">До 50 последних записей</div></div><div class="gangMemberList">${histHtml || '<div class="banEmpty">Дуэлей не найдено</div>'}</div></section></div></div>`;
      ov.querySelector("#duelResetPlayerBtn")?.addEventListener("click", async () => {
        await resetPlayer(st.steamid64, st.name);
        closeModal();
        loadPlayers();
        loadTop();
        loadOverview();
      });
    }
    document.body.appendChild(ov);
    ov.querySelector("[data-close]")?.addEventListener("click", closeModal);
    ov.addEventListener("click", e => {
      if (e.target === ov) closeModal();
    });
  }
  async function resetPlayer(sid, name) {
    const ok = await uiConfirm({
      title: "Обнулить статистику игрока?",
      text: `Победы и поражения игрока ${name || sid} (${sid}) будут обнулены на сервере и на сайте. История дуэлей сохранится.`,
      okText: "Обнулить",
      cancelText: "Отмена",
      danger: true,
      icon: "🧹"
    });
    if (!ok) return;
    try {
      await postAction({
        action: "reset_player",
        steamid64: sid
      });
      toast(true, "Готово", `Статистика игрока ${name || sid} обнулена`);
      loadPlayers();
      loadTop();
      loadOverview();
    } catch (e) {
      toast(false, "Ошибка", e.message || "Не удалось обнулить статистику");
    }
  }
  async function resetAll() {
    const ok = await uiConfirm({
      title: "Обнулить статистику ВСЕМ игрокам?",
      text: "Победы и поражения всех игроков будут обнулены на сервере и на сайте. История дуэлей сохранится. Отменить действие нельзя.",
      okText: "Обнулить всем",
      cancelText: "Отмена",
      danger: true,
      icon: "🧹"
    });
    if (!ok) return;
    try {
      await postAction({
        action: "reset_all"
      });
      toast(true, "Готово", "Статистика дуэлей обнулена всем игрокам");
      plPageNum = 1;
      loadPlayers();
      loadTop();
      loadOverview();
    } catch (e) {
      toast(false, "Ошибка", e.message || "Не удалось обнулить статистику");
    }
  }
  function switchTab(name) {
    curTab = name;
    document.querySelectorAll(".duelTabs .tabBtn").forEach(b => b.classList.toggle("active", b.dataset.tab === name));
    document.querySelectorAll(".tabPanel").forEach(p => p.classList.remove("active"));
    const panel = $({
      active: "panelActive",
      top: "panelTop",
      players: "panelPlayers",
      history: "panelHistory"
    }[name]);
    if (panel) panel.classList.add("active");
    if (name === "top") loadTop();
    if (name === "players") {
      plPageNum = 1;
      loadPlayers();
    }
    if (name === "history") {
      hPageNum = 1;
      loadHistory();
    }
  }
  document.querySelectorAll(".duelTabs .tabBtn").forEach(b => b.addEventListener("click", () => switchTab(b.dataset.tab)));
  $("duelRefresh").addEventListener("click", () => {
    loadOverview();
    if (curTab === "top") loadTop();
    if (curTab === "players") loadPlayers();
    if (curTab === "history") loadHistory();
  });
  $("duelResetAll").addEventListener("click", resetAll);
  plQ.addEventListener("input", () => {
    clearTimeout(plTimer);
    plTimer = setTimeout(() => {
      plPageNum = 1;
      loadPlayers();
    }, 350);
  });
  plSort.addEventListener("change", () => {
    plPageNum = 1;
    loadPlayers();
  });
  $("duelPlayersPrev").addEventListener("click", () => {
    if (plPageNum > 1) {
      plPageNum--;
      loadPlayers();
    }
  });
  $("duelPlayersNext").addEventListener("click", () => {
    if (plPageNum < plPages) {
      plPageNum++;
      loadPlayers();
    }
  });
  hQ.addEventListener("input", () => {
    clearTimeout(hTimer);
    hTimer = setTimeout(() => {
      hPageNum = 1;
      loadHistory();
    }, 350);
  });
  hResult.addEventListener("change", () => {
    hPageNum = 1;
    loadHistory();
  });
  $("duelHistPrev").addEventListener("click", () => {
    if (hPageNum > 1) {
      hPageNum--;
      loadHistory();
    }
  });
  $("duelHistNext").addEventListener("click", () => {
    if (hPageNum < hPages) {
      hPageNum++;
      loadHistory();
    }
  });
  document.addEventListener("DOMContentLoaded", () => {
    loadOverview();
    setInterval(() => {
      if (document.hidden) return;
      loadOverview();
    }, 5e3);
  });
})();
