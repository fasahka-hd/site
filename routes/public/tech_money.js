(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const tbody = $("moneyTbody"), q = $("moneyQ"), type = $("moneyType"), per = $("moneyPerPage"), count = $("moneyCount"), pageLine = $("moneyPage"), err = $("moneyErr");
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
  async function load() {
    try {
      err.style.display = "none";
      if (window.UI) window.UI.skeletonRows(tbody, 8, 7); else tbody.innerHTML = '<tr><td colspan="7" class="banEmpty">Загрузка...</td></tr>';
      const params = new URLSearchParams({
        page: String(page),
        per_page: per.value || "50",
        q: q.value.trim(),
        type: type.value || "all"
      });
      const r = await fetch("./api/money_logs?" + params, {
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
      tbody.innerHTML = '<tr><td colspan="7" class="banEmpty">Ошибка загрузки</td></tr>';
      err.style.display = "";
      if (window.UI) window.UI.toast({
        ok: false,
        title: "Ошибка",
        text: e.message || "Не удалось загрузить операции"
      });
    }
  }
  function moneyOpBadge(it) {
    const a = String(it.action || "").toLowerCase();
    if (it.direction === "out" || a.includes("передал")) return `<span class="moneyOp transferOut">Перевод →</span>`;
    if (it.direction === "in" || a.includes("получил перевод")) return `<span class="moneyOp transferIn">Перевод ←</span>`;
    if (a.includes("вывод с принтера")) return `<span class="moneyOp withdraw">Вывод</span>`;
    if (a.includes("пэйдей") || a.includes("payday")) return `<span class="moneyOp payday">Пэйдей</span>`;
    if (a.includes("купил") || a.includes("энтити")) return `<span class="moneyOp purchase">Покупка</span>`;
    if (a.includes("списание")) return `<span class="moneyOp expense">Списание</span>`;
    if (a.includes("начисление") || a.includes("addmoney")) return `<span class="moneyOp income">Начисление</span>`;
    return `<span class="moneyOp other">${esc(it.action || "—")}</span>`;
  }
  function renderSummary(stats) {
    const el = $("moneySummary");
    if (!el) return;
    const f = v => Number(v || 0).toLocaleString("ru-RU");
    el.innerHTML = `<div class="extractStat income"><div class="esLabel">Приход</div><div class="esValue">+${f(stats.sum_income)} ₽</div></div>` + `<div class="extractStat expense"><div class="esLabel">Расход</div><div class="esValue">−${f(stats.sum_expense)} ₽</div></div>` + `<div class="extractStat net"><div class="esLabel">Сальдо</div><div class="esValue">${(stats.sum_net >= 0 ? "+" : "−") + f(Math.abs(stats.sum_net || 0))} ₽</div></div>` + `<div class="extractStat total"><div class="esLabel">Операций</div><div class="esValue">${f(stats.total)}</div></div>`;
  }
  function render(items) {
    tbody.innerHTML = "";
    if (!items.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="banEmpty">Операций не найдено</td></tr>';
      return;
    }
    for (const it of items) {
      const cp = it.counterparty_steamid64 ? `<div class="cpChip"><strong>${esc(it.counterparty_name || "—")}</strong><code class="copyId" data-copy="${esc(it.counterparty_steamid64)}" title="Копировать">${esc(it.counterparty_steamid64)}</code></div>` : "—";
      const tr = document.createElement("tr");
      tr.className = Number(it.money) >= 0 ? "moneyIncome" : "moneyExpense";
      tr.innerHTML = `<td data-label="Время">${esc(fmtTime(it.time))}</td>` + `<td data-label="Игрок"><strong class="nickText">${esc(it.name || "—")}</strong></td>` + `<td data-label="SteamID64"><code class="copyId" data-copy="${esc(it.steamid64)}" title="Копировать">${esc(it.steamid64)}</code></td>` + `<td data-label="Операция">${moneyOpBadge(it)}</td>` + `<td data-label="Сумма"><span class="moneyPill">${esc(fmtMoney(it.money))}</span></td>` + `<td data-label="Кому / от кого">${cp}</td>` + `<td data-label="Описание"><span class="moneyDesc">${esc(it.description || "—")}</span></td>`;
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
  $("moneyRefresh").addEventListener("click", load);
  $("moneyPrev").addEventListener("click", () => {
    if (page > 1) {
      page--;
      load();
    }
  });
  $("moneyNext").addEventListener("click", () => {
    if (page < pages) {
      page++;
      load();
    }
  });
  document.addEventListener("DOMContentLoaded", load);
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
