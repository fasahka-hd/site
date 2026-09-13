const apiStatus = document.getElementById("apiStatus");

const err = document.getElementById("err");

const q = document.getElementById("q");

const perPageSel = document.getElementById("perPage");

const actionFilter = document.getElementById("actionFilter");

const refreshBtn = document.getElementById("refresh");

const tbody = document.getElementById("tbody");

const pager = document.getElementById("pager");

const prevPageBtn = document.getElementById("prevPage");

const nextPageBtn = document.getElementById("nextPage");

const pageInfo = document.getElementById("pageInfo");

let page = 1;

function escapeHtml(str) {
  return (str ?? "").toString().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function toast(text, ok = true) {
  const wrap = document.getElementById("toastWrap");
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
  setTimeout(() => el.remove(), 3e3);
}

function renderLogs(logs) {
  tbody.innerHTML = "";
  if (!logs.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="banEmpty">Нет записей</td></tr>`;
    return;
  }
  for (const log of logs) {
    const tr = document.createElement("tr");
    tr.innerHTML = `\n            <td><div class="logTimeMain">${escapeHtml(log.time_formatted)}</div></td>\n            <td><div><strong>${escapeHtml(log.admin_nick || log.admin_steamid64)}</strong></div><div class="muted mono" style="font-size:11px;margin-top:4px">${escapeHtml(log.admin_steamid64 || "—")}</div></td>\n            <td><span class="logAction"><span>${escapeHtml(log.action_icon || "")}</span><strong>${escapeHtml(log.action_label || log.action)}</strong></span></td>\n            <td><div>${escapeHtml(log.target_steamid64 || log.target || "—")}</div><div class="muted mono" style="font-size:11px;margin-top:4px">${escapeHtml(log.target && log.target_steamid64 && log.target !== log.target_steamid64 ? log.target : "")}</div></td>\n            <td><small style="color: var(--muted)">${escapeHtml(log.details_label || log.details || "—")}</small></td>\n        `;
    tbody.appendChild(tr);
  }
}

let _logsLoadedOnce = false;

async function loadLogs() {
  apiStatus.textContent = "API: загрузка...";
  if (!_logsLoadedOnce && window.UI) UI.skeletonRows(tbody, 8, 5);
  err.style.display = "none";
  const perPage = parseInt(perPageSel.value || "50", 10);
  const qs = new URLSearchParams;
  qs.set("page", String(page));
  qs.set("per_page", String(perPage));
  if (q.value.trim()) qs.set("search", q.value.trim());
  if (actionFilter && actionFilter.value) qs.set("action", actionFilter.value);
  try {
    const response = await fetch("./api/admin_logs?" + qs.toString(), {
      cache: "no-store",
      credentials: "include"
    });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const data = await response.json();
    if (!data.ok) throw new Error(data.error || "API error");
    apiStatus.textContent = "API: OK";
    _logsLoadedOnce = true;
    const total = data.total || 0;
    const pages = Math.max(1, Math.ceil(total / perPage));
    if (page > pages) page = pages;
    if (page < 1) page = 1;
    renderLogs(Array.isArray(data.logs) ? data.logs : []);
    pager.style.display = pages > 1 ? "flex" : "none";
    pageInfo.textContent = `Страница ${page}/${pages}`;
    prevPageBtn.disabled = page <= 1;
    nextPageBtn.disabled = page >= pages;
  } catch (error) {
    apiStatus.textContent = "API: ERROR";
    err.style.display = "block";
    err.textContent = `Ошибка загрузки: ${error.message}`;
    tbody.innerHTML = `<tr><td colspan="5" class="banEmpty">Ошибка загрузки</td></tr>`;
    pager.style.display = "none";
  }
}

perPageSel.addEventListener("change", () => {
  page = 1;
  loadLogs();
});

if (actionFilter) actionFilter.addEventListener("change", () => {
  page = 1;
  loadLogs();
});

refreshBtn.addEventListener("click", loadLogs);

q.addEventListener("input", () => {
  clearTimeout(window.__logSearch);
  window.__logSearch = setTimeout(() => {
    page = 1;
    loadLogs();
  }, 300);
});

prevPageBtn.addEventListener("click", () => {
  if (page > 1) {
    page--;
    loadLogs();
  }
});

nextPageBtn.addEventListener("click", () => {
  page++;
  loadLogs();
});

document.addEventListener("DOMContentLoaded", async () => {
  await requireAuth();
  loadLogs();
});

setInterval(loadLogs, 3e4);
