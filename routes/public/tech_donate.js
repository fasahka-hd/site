(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const tbody = $("donateTbody"), q = $("donateQ"), type = $("donateType"), per = $("donatePerPage"), count = $("donateCount"), pageLine = $("donatePage"), err = $("donateErr");
  let page = 1, pages = 1, timer = null;
  function esc(s) {
    const d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }
  function fmtMoney(v) {
    v = Number(v || 0);
    return (v > 0 ? "+" : "") + v.toLocaleString("ru-RU") + " ₽";
  }
  function fmtTime(iso) {
    if (!iso) return "—";
    try {
      return new Date(iso).toLocaleString("ru-RU");
    } catch {
      return "—";
    }
  }
  function categoryBadge(cat) {
    const map = {
      topup: {
        cls: "donateTopup",
        text: "Пополнение"
      },
      purchase: {
        cls: "donatePurchase",
        text: "Покупка"
      },
      reward: {
        cls: "donateReward",
        text: "Награда"
      },
      other: {
        cls: "donateOther",
        text: "Другое"
      }
    };
    const m = map[cat] || map.other;
    return `<span class="badge ${esc(m.cls)}">${esc(m.text)}</span>`;
  }
  async function load() {
    try {
      err.style.display = "none";
      if (window.UI) window.UI.skeletonRows(tbody, 8, 8); else tbody.innerHTML = '<tr><td colspan="8" class="banEmpty">Загрузка...</td></tr>';
      const params = new URLSearchParams({
        page: String(page),
        per_page: per.value || "50",
        q: q.value.trim(),
        type: type.value || "all"
      });
      const r = await fetch("./api/donate_logs?" + params, {
        cache: "no-store",
        credentials: "include"
      });
      if (r.status === 401) {
        location.href = "/login";
        throw new Error("NOT_AUTH");
      }
      const j = await r.json().catch(() => null);
      if (!r.ok || !j || !j.ok) throw new Error(j?.error || "HTTP " + r.status);
      pages = j.pages || 1;
      page = j.page || page;
      count.textContent = `Операций: ${Number(j.total || 0).toLocaleString("ru-RU")}`;
      pageLine.textContent = `Страница ${page}/${pages}`;
      render(j.items || []);
      renderSummary(j);
    } catch (e) {
      tbody.innerHTML = '<tr><td colspan="8" class="banEmpty">Ошибка загрузки</td></tr>';
      err.style.display = "";
      if (window.UI) window.UI.toast({
        ok: false,
        title: "Ошибка",
        text: e.message || "Не удалось загрузить донат операции"
      });
    }
  }
  function renderSummary(stats) {
    const el = $("donateSummary");
    if (!el) return;
    const f = v => Number(v || 0).toLocaleString("ru-RU");
    el.innerHTML = `<div class="extractStat income"><div class="esLabel">Пополнения</div><div class="esValue">+${f(stats.sum_topup)} ₽</div></div>` + `<div class="extractStat expense"><div class="esLabel">Покупки</div><div class="esValue">−${f(stats.sum_purchase)} ₽</div></div>` + `<div class="extractStat reward"><div class="esLabel">Награды</div><div class="esValue">+${f(stats.sum_reward)} ₽</div></div>` + `<div class="extractStat total"><div class="esLabel">Сальдо</div><div class="esValue">${(stats.sum_total >= 0 ? "+" : "−") + f(Math.abs(stats.sum_total || 0))} ₽</div></div>`;
  }
  function render(items) {
    tbody.innerHTML = "";
    if (!items.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="banEmpty">Операций не найдено</td></tr>';
      return;
    }
    for (const it of items) {
      const tr = document.createElement("tr");
      tr.className = Number(it.sum) >= 0 ? "moneyIncome" : "moneyExpense";
      const itemText = it.item ? esc(it.item) : it.note && it.note !== "—" ? esc(it.note) : "—";
      const fromText = it.counterparty ? `<code class="copyId" data-copy="${esc(it.steamid64)}" title="Копировать">${esc(it.counterparty)}</code>` : "—";
      tr.innerHTML = `<td data-label="Время">${esc(fmtTime(it.tx_time))}</td>` + `<td data-label="Игрок"><strong class="nickText">${esc(it.name || "—")}</strong></td>` + `<td data-label="SteamID64"><code class="copyId" data-copy="${esc(it.steamid64)}" title="Копировать">${esc(it.steamid64)}</code></td>` + `<td data-label="Тип операции">${categoryBadge(it.category)}</td>` + `<td data-label="Сумма"><span class="moneyPill">${esc(fmtMoney(it.sum))}</span></td>` + `<td data-label="Текущий баланс">${esc(fmtMoney(it.current_balance))}</td>` + `<td data-label="Описание / предмет"><span class="moneyDesc">${itemText}</span></td>` + `<td data-label="От кого">${fromText}</td>`;
      tbody.appendChild(tr);
    }
  }
  function debounce() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      page = 1;
      load();
    }, 350);
  }
  q.addEventListener("input", debounce);
  type.addEventListener("change", () => {
    page = 1;
    load();
  });
  per.addEventListener("change", () => {
    page = 1;
    load();
  });
  $("donateRefresh").addEventListener("click", load);
  $("donatePrev").addEventListener("click", () => {
    if (page > 1) {
      page--;
      load();
    }
  });
  $("donateNext").addEventListener("click", () => {
    if (page < pages) {
      page++;
      load();
    }
  });
  document.addEventListener("DOMContentLoaded", () => {
    const qs = new URLSearchParams(location.search).get("q");
    if (qs) {
      q.value = qs;
    }
    load();
  });
  tbody.addEventListener("click", e => {
    const el = e.target.closest(".copyId");
    if (!el) return;
    const v = el.getAttribute("data-copy");
    if (!v) return;
    navigator.clipboard?.writeText(v).then(() => {
      if (window.UI && window.UI.toast) window.UI.toast({
        ok: true,
        text: "Скопировано: " + v,
        duration: 1500
      });
    }).catch(() => {});
  });
})();
