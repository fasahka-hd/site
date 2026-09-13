let all = [];

let page = 1;

const $ = id => document.getElementById(id);

const apiStatus = $("apiStatus");

const err = $("err");

const tbody = $("tbody");

const q = $("q");

const perPageSel = $("perPage");

const pager = $("pager");

const pageInfo = $("pageInfo");

const prevPage = $("prevPage");

const nextPage = $("nextPage");

const refreshBtn = $("refresh");

const massAddBtn = $("massAdd");

function escapeHtml(s) {
  return (s ?? "").toString().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function fmtTs(ts) {
  const n = Number(ts || 0);
  if (!n) return "—";
  const d = new Date(n * 1e3);
  const pad = x => String(x).padStart(2, "0");
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toast(ok, title, msg) {
  if (window.UI && UI.toast) {
    UI.toast({
      ok: ok,
      title: title,
      text: msg
    });
    return;
  }
  const wrap = document.getElementById("toastWrap");
  if (!wrap) return;
  const box = document.createElement("div");
  box.className = "toast " + (ok ? "ok" : "bad");
  box.innerHTML = `<div class="toastTitle"></div><div class="toastText"></div>`;
  box.querySelector(".toastTitle").textContent = title || "";
  box.querySelector(".toastText").textContent = msg || "";
  wrap.appendChild(box);
  setTimeout(() => {
    box.style.opacity = "0";
  }, 2400);
  setTimeout(() => box.remove(), 3e3);
}

function modal({title: title, body: body, onOk: onOk, okText: okText, okClass: okClass}) {
  const overlay = document.createElement("div");
  overlay.className = "modalOverlay";
  const card = document.createElement("div");
  card.className = "modalCard";
  card.innerHTML = `\n    <div class="modalTitle">${title || ""}</div>\n    <div class="modalBody"></div>\n    <div class="modalActions">\n      <button class="btn" id="mCancel">Отмена</button>\n      <button class="btn ${okClass || "gray"}" id="mOk">${okText || "ОК"}</button>\n    </div>\n  `;
  card.querySelector(".modalBody").appendChild(body);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  overlay.addEventListener("click", e => {
    if (e.target === overlay) overlay.remove();
  });
  card.querySelector("#mCancel").onclick = () => overlay.remove();
  card.querySelector("#mOk").onclick = async () => {
    const okBtn = card.querySelector("#mOk");
    okBtn.disabled = true;
    okBtn.textContent = "Загрузка...";
    try {
      await (onOk && onOk());
      overlay.remove();
    } catch (e) {
      okBtn.disabled = false;
      okBtn.textContent = okText || "ОК";
      toast(false, "Ошибка", e?.message || e);
    }
  };
}

async function sendCommand(text) {
  const params = new URLSearchParams;
  params.append("type", "console");
  params.append("text", String(text || ""));
  const rr = await fetch("api/command", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: params.toString(),
    credentials: "include"
  });
  const jj = await rr.json().catch(() => null);
  if (!rr.ok || !jj || !jj.ok) throw new Error(jj?.error || "HTTP " + rr.status);
  return jj;
}

const STEAMID64_BASE = BigInt("76561197960265728");

function steamIdTo64(input) {
  const s = String(input || "").trim();
  if (!s) return "";
  if (/^\d{17}$/.test(s)) return s;
  const m = /^STEAM_\d:([01]):(\d+)$/.exec(s);
  if (m) {
    const y = BigInt(m[1]);
    const z = BigInt(m[2]);
    return String(STEAMID64_BASE + z * 2n + y);
  }
  const m3 = /^\[U:1:(\d+)\]$/.exec(s);
  if (m3) {
    const a = BigInt(m3[1]);
    return String(STEAMID64_BASE + a);
  }
  return "";
}

function escapeArg(s) {
  return String(s || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function getFiltered() {
  const query = (q.value || "").trim().toLowerCase();
  if (!query) return all.slice();
  return all.filter(r => {
    const hay = `${r.nickname || ""} ${r.steamid || ""} ${r.steamid64 || ""} ${r.ip || ""} ${r.reason || ""} ${r.added_by || ""}`.toLowerCase();
    return hay.includes(query);
  });
}

function render() {
  err.style.display = "none";
  tbody.innerHTML = "";
  const perPage = parseInt(perPageSel.value || "20", 10);
  const list = getFiltered();
  const totalPages = Math.max(1, Math.ceil(list.length / perPage));
  if (page > totalPages) page = totalPages;
  const start = (page - 1) * perPage;
  const slice = list.slice(start, start + perPage);
  if (!slice.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="banEmpty">Нет записей</td></tr>`;
  } else {
    for (const r of slice) {
      const tr = document.createElement("tr");
      const nick = escapeHtml(r.nickname || "—");
      const sid = escapeHtml(r.steamid || "—");
      const sid64 = escapeHtml(r.steamid64 || "—");
      const ip = escapeHtml(r.ip || "—");
      const reason = escapeHtml(r.reason || "—");
      const by = escapeHtml(r.added_by || "—");
      const upd = escapeHtml(fmtTs(r.updated_at || r.added_at || 0));
      tr.innerHTML = `\n        <td>${nick}</td>\n        <td class="mono" style="font-size:12px">${sid}</td>\n        <td class="mono" style="font-size:12px">${sid64}</td>\n        <td class="mono" style="font-size:12px">${ip}</td>\n        <td>${reason}</td>\n        <td>${by}</td>\n        <td>${upd}</td>\n      `;
      tbody.appendChild(tr);
    }
  }
  pager.style.display = totalPages > 1 ? "" : "none";
  pageInfo.textContent = `Страница ${page}/${totalPages} • Записей: ${list.length}`;
  prevPage.disabled = page <= 1;
  nextPage.disabled = page >= totalPages;
}

let _blLoadedOnce = false;

async function load() {
  apiStatus.textContent = "API: загрузка...";
  if (!_blLoadedOnce && window.UI) UI.skeletonRows(tbody, 8, 7);
  err.style.display = "none";
  try {
    const r = await fetch(`./api/blacklist?_=${Date.now()}`, {
      cache: "no-store",
      credentials: "include"
    });
    const data = await r.json().catch(() => null);
    if (!r.ok || !data || !data.ok) throw new Error(data?.error || "HTTP " + r.status);
    all = Array.isArray(data.items) ? data.items : [];
    apiStatus.textContent = "API: OK";
    _blLoadedOnce = true;
    render();
  } catch (e) {
    apiStatus.textContent = "API: ошибка";
    err.textContent = "Ошибка загрузки: " + (e?.message || e);
    err.style.display = "";
    tbody.innerHTML = `<tr><td colspan="7" class="banEmpty">Ошибка</td></tr>`;
  }
}

q.addEventListener("input", () => {
  page = 1;
  render();
});

perPageSel.addEventListener("change", () => {
  page = 1;
  render();
});

prevPage.addEventListener("click", () => {
  if (page > 1) {
    page--;
    render();
  }
});

nextPage.addEventListener("click", () => {
  page++;
  render();
});

refreshBtn.addEventListener("click", () => load());

if (massAddBtn) massAddBtn.addEventListener("click", () => massAddModal());

async function massAddModal() {
  const wrap = document.createElement("div");
  wrap.className = "massOriginal massChspOriginal";
  wrap.innerHTML = `\n    <div class="massOriginalBody chsp">\n      <div class="massOriginalListBox">\n        <div class="massFieldTitle">SteamID игроков</div>\n        <div class="massOriginalList" id="chspList"></div>\n        <div class="massToolbar compact">\n          <button class="btn" id="chspAdd" type="button">Добавить строку</button>\n          <button class="btn" id="chspPaste" type="button">Вставить списком</button>\n        </div>\n      </div>\n      <div class="massOriginalSettings">\n        <div class="massFieldCard">\n          <div class="massFieldTitle">Причина</div>\n          <select class="modalSelect" id="chspReasonSel">\n            <option value="">Выбрать причину</option>\n            <option value="Вы в черном списке проекта.">Вы в черном списке проекта.</option>\n            <option value="Читы / обход / вред проекту.">Читы / обход / вред проекту.</option>\n            <option value="Мультиаккаунт / абуз.">Мультиаккаунт / абуз.</option>\n            <option value="Другое">Другое</option>\n          </select>\n          <input class="modalInput" id="chspReasonCustom" placeholder="Своя причина" />\n        </div>\n      </div>\n    </div>\n    <div class="massStatus" id="chspStatus"></div>\n  `;
  const listBox = wrap.querySelector("#chspList");
  const addBtn = wrap.querySelector("#chspAdd");
  const pasteBtn = wrap.querySelector("#chspPaste");
  const reasonSel = wrap.querySelector("#chspReasonSel");
  const reasonCustom = wrap.querySelector("#chspReasonCustom");
  const statusBar = wrap.querySelector("#chspStatus");
  const counter = wrap.querySelector("#chspCounter");
  function addRow(val = "") {
    const row = document.createElement("div");
    row.className = "massOriginalRow";
    const inp = document.createElement("input");
    inp.className = "modalInput chspSteam";
    inp.placeholder = "STEAM_0:1:123456";
    inp.value = val;
    const del = document.createElement("button");
    del.className = "btn danger massOriginalDel";
    del.textContent = "×";
    del.onclick = () => {
      row.remove();
      updateStatus();
    };
    inp.addEventListener("input", updateStatus);
    row.appendChild(inp);
    row.appendChild(del);
    listBox.appendChild(row);
    updateStatus();
  }
  const idsNow = () => Array.from(listBox.querySelectorAll(".chspSteam")).map(i => i.value.trim()).filter(Boolean);
  const validIdsNow = () => idsNow().map(sid => steamIdTo64(sid)).filter(Boolean);
  const invalidIdsNow = () => idsNow().filter(sid => !steamIdTo64(sid));
  const reasonNow = () => reasonSel.value === "Другое" ? (reasonCustom.value || "").trim() : (reasonCustom.value || "").trim() || (reasonSel.value || "").trim();
  function markSteamInputs() {
    listBox.querySelectorAll(".chspSteam").forEach(inp => {
      const val = inp.value.trim();
      inp.classList.toggle("steamInvalid", !!val && !steamIdTo64(val));
    });
  }
  function updateStatus() {
    const ids = idsNow();
    const validIds = validIdsNow();
    const invalidIds = invalidIdsNow();
    markSteamInputs();
    const reason = reasonNow();
    const ready = validIds.length > 0 && invalidIds.length === 0 && !!reason;
    if (counter) counter.textContent = String(validIds.length);
    reasonCustom.style.display = reasonSel.value === "Другое" || reasonCustom.value ? "" : "none";
    statusBar.className = "massStatus " + (ready ? "ok" : "bad");
    statusBar.innerHTML = `\n      <div class="massStatusGrid chsp">\n        <div><span>Игроков</span><b>${validIds.length}${invalidIds.length ? ` / ошибок ${invalidIds.length}` : ""}</b></div>\n        <div><span>Причина</span><b>${escapeHtml(reason || "—")}</b></div>\n      </div>\n      <div class="massStatusLine">${ready ? "Готово к занесению в ЧСП" : invalidIds.length ? "Проверь неверные SteamID" : "Добавь SteamID и выбери причину"}</div>\n    `;
  }
  addBtn.onclick = () => addRow("");
  pasteBtn.onclick = async () => {
    try {
      const txt = await navigator.clipboard.readText();
      const parts = (txt || "").split(/[\s,;]+/).map(x => x.trim()).filter(Boolean);
      if (!parts.length) return;
      listBox.innerHTML = "";
      for (const part of parts) addRow(part);
      updateStatus();
    } catch (e) {
      toast(false, "Ошибка", "Не удалось прочитать буфер обмена");
    }
  };
  reasonSel.addEventListener("change", updateStatus);
  reasonCustom.addEventListener("input", updateStatus);
  addRow("");
  updateStatus();
  modal({
    title: "Массовое ЧСП",
    body: wrap,
    okText: "Занести в ЧСП",
    okClass: "danger",
    onOk: async () => {
      const ids = idsNow();
      const invalidIds = invalidIdsNow();
      if (!ids.length) throw new Error("Нужен хотя бы 1 SteamID");
      if (invalidIds.length) {
        markSteamInputs();
        throw new Error("Неверный SteamID: " + invalidIds.slice(0, 3).join(", "));
      }
      const reason = reasonNow();
      if (!reason) throw new Error("Укажи причину");
      const adminNick = window.__ME?.nickname || "Site";
      let okCount = 0;
      let badCount = 0;
      for (const raw of ids) {
        const sid64 = steamIdTo64(raw);
        if (!sid64) {
          badCount++;
          continue;
        }
        try {
          await sendCommand(`blacklist_add ${sid64} 1 ${escapeArg(adminNick)} "${escapeArg(reason || "")}"`);
        } catch (e) {}
        const params = new URLSearchParams;
        params.append("action", "add");
        params.append("steamid64", sid64);
        params.append("ip", "");
        params.append("nickname", "");
        params.append("reason", reason);
        const rr = await fetch("api/chsp_action", {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded"
          },
          body: params.toString(),
          credentials: "include"
        });
        const jj = await rr.json().catch(() => null);
        if (rr.ok && jj && jj.ok) okCount++; else badCount++;
      }
      toast(true, "Готово", `Добавлено: ${okCount}, ошибок: ${badCount}`);
      setTimeout(load, 400);
    }
  });
  setTimeout(() => listBox.querySelector("input")?.focus(), 60);
}

document.addEventListener("DOMContentLoaded", async () => {
  await requireAuth();
  load();
  if (location.hash === "#mass") setTimeout(() => massAddModal(), 500);
});
