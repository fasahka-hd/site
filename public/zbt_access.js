const apiStatus = document.getElementById("apiStatus");

const zbtBody = document.getElementById("zbtBody");

const zbtStatus = document.getElementById("zbtStatus");

const zbtSearch = document.getElementById("zbtSearch");

const zbtAdd = document.getElementById("zbtAdd");

const zbtSave = document.getElementById("zbtSave");

let rows = [];

let saveTimer = null;

let saving = false;

let dirty = false;

function uid() {
  return "tmp_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

function esc(s) {
  return (s ?? "").toString().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function emptyRow() {
  return {
    id: uid(),
    nickname: "",
    steamid: "",
    discord: "",
    steam_url: "",
    access: false
  };
}

function normalizeUrl(url) {
  url = String(url || "").trim();
  if (!url) return "";
  if (!/^https?:\/\//i.test(url)) return "";
  return url;
}

function steamLink(row) {
  const custom = normalizeUrl(row.steam_url);
  if (custom) return custom;
  const sid = String(row.steamid || "").trim();
  if (/^\d{17}$/.test(sid)) return "https://steamcommunity.com/profiles/" + sid;
  return "";
}

function hasContent(row) {
  return !!(String(row.nickname || "").trim() || String(row.steamid || "").trim() || String(row.discord || "").trim() || String(row.steam_url || "").trim() || row.access);
}

function visibleRows() {
  const q = String(zbtSearch.value || "").trim().toLowerCase();
  const list = rows.length ? rows : [];
  if (!q) return list;
  return list.filter(r => [ r.nickname, r.steamid, r.discord, r.steam_url, r.access ? "есть доступ" : "нет доступа" ].join(" ").toLowerCase().includes(q));
}

function ensureOneRow() {
  if (!rows.length) rows.push(emptyRow());
}

function render() {
  ensureOneRow();
  const list = visibleRows();
  zbtBody.innerHTML = "";
  if (!list.length) {
    zbtBody.innerHTML = `<tr><td colspan="7" class="banEmpty">Ничего не найдено</td></tr>`;
    return;
  }
  list.forEach(row => {
    const idx = rows.indexOf(row);
    const link = steamLink(row);
    const tr = document.createElement("tr");
    tr.dataset.id = row.id;
    tr.innerHTML = `\n      <td class="zbtNum">${idx + 1}</td>\n      <td><input class="zbtInput" data-field="nickname" value="${esc(row.nickname)}" placeholder="Ник"></td>\n      <td><input class="zbtInput mono" data-field="steamid" value="${esc(row.steamid)}" placeholder="STEAM_0:1:... / 765..."></td>\n      <td><input class="zbtInput" data-field="discord" value="${esc(row.discord)}" placeholder="discord"></td>\n      <td>\n        <div class="zbtSteamCell">\n          <input class="zbtInput" data-field="steam_url" value="${esc(row.steam_url)}" placeholder="steamcommunity.com/...">\n          ${link ? `<a class="zbtOpen" href="${esc(link)}" target="_blank" rel="noopener" title="Открыть Steam">↗</a>` : `<span class="zbtOpen disabled">↗</span>`}\n        </div>\n      </td>\n      <td>\n        <button class="zbtAccessPill ${row.access ? "yes" : "no"}" data-field="access" data-val="${row.access ? "yes" : "no"}" type="button">\n          <span class="zbtAccessDot"></span>\n          <span class="zbtAccessText">${row.access ? "Доступ открыт" : "Нет доступа"}</span>\n        </button>\n      </td>\n      <td><button class="zbtDelete" type="button" title="Удалить строку">×</button></td>\n    `;
    zbtBody.appendChild(tr);
  });
}

function readTable() {
  zbtBody.querySelectorAll("tr[data-id]").forEach(tr => {
    const row = rows.find(r => String(r.id) === String(tr.dataset.id));
    if (!row) return;
    tr.querySelectorAll("[data-field]").forEach(el => {
      const field = el.dataset.field;
      if (field === "access") row.access = el.dataset.val === "yes"; else row[field] = el.value;
    });
  });
}

function setStatus(text, ok = true) {
  if (!zbtStatus) return;
  zbtStatus.textContent = text || "";
  zbtStatus.style.display = text ? "inline-flex" : "none";
  zbtStatus.classList.toggle("bad", !ok);
  zbtStatus.classList.toggle("ok", ok);
}

function scheduleSave() {
  dirty = true;
  setStatus("Есть несохранённые изменения", true);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveAll, 1200);
}

async function saveAll() {
  if (saving) return;
  readTable();
  saving = true;
  zbtSave.disabled = true;
  setStatus("Сохранение...", true);
  try {
    const payload = rows.filter(hasContent).map((r2, i) => ({
      ...r2,
      order: i
    }));
    const r = await fetch("./api/zbt_access", {
      method: "PUT",
      credentials: "include",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        rows: payload
      })
    });
    const d = await r.json().catch(() => null);
    if (!r.ok || !d || !d.ok) throw new Error(d?.error || "SAVE_ERROR");
    rows = Array.isArray(d.rows) ? d.rows : [];
    ensureOneRow();
    dirty = false;
    render();
    setStatus("Сохранено", true);
    if (apiStatus) apiStatus.textContent = "API: OK";
  } catch (e) {
    setStatus("Ошибка сохранения", false);
    if (apiStatus) apiStatus.textContent = "API: ERROR";
    if (window.UI) UI.toast({
      ok: false,
      text: "Не удалось сохранить таблицу"
    });
  } finally {
    saving = false;
    zbtSave.disabled = false;
  }
}

async function loadRows() {
  if (apiStatus) apiStatus.textContent = "API: загрузка...";
  if (window.UI) UI.skeletonRows(zbtBody, 10, 7);
  try {
    const r = await fetch("./api/zbt_access", {
      cache: "no-store",
      credentials: "include"
    });
    const d = await r.json();
    if (!r.ok || !d.ok) throw new Error(d.error || "LOAD_ERROR");
    rows = Array.isArray(d.rows) ? d.rows : [];
    ensureOneRow();
    render();
    setStatus("", true);
    if (apiStatus) apiStatus.textContent = "API: OK";
  } catch (e) {
    zbtBody.innerHTML = `<tr><td colspan="7" class="banEmpty">Ошибка загрузки</td></tr>`;
    setStatus("Ошибка загрузки", false);
    if (apiStatus) apiStatus.textContent = "API: ERROR";
  }
}

zbtBody.addEventListener("input", e => {
  if (!e.target.matches(".zbtInput")) return;
  scheduleSave();
});

zbtBody.addEventListener("click", e => {
  const access = e.target.closest(".zbtAccessPill");
  if (access) {
    const tr2 = access.closest("tr[data-id]");
    const row = rows.find(r => String(r.id) === String(tr2.dataset.id));
    if (!row) return;
    row.access = !row.access;
    access.dataset.val = row.access ? "yes" : "no";
    access.classList.toggle("yes", row.access);
    access.classList.toggle("no", !row.access);
    access.querySelector(".zbtAccessText").textContent = row.access ? "Доступ открыт" : "Нет доступа";
    scheduleSave();
    return;
  }
  const del = e.target.closest(".zbtDelete");
  if (!del) return;
  const tr = del.closest("tr[data-id]");
  rows = rows.filter(r => String(r.id) !== String(tr.dataset.id));
  ensureOneRow();
  render();
  scheduleSave();
});

zbtAdd.addEventListener("click", () => {
  readTable();
  rows.push(emptyRow());
  render();
  const last = zbtBody.querySelector("tr:last-child .zbtInput");
  if (last) last.focus();
});

zbtSave.addEventListener("click", saveAll);

zbtSearch.addEventListener("input", render);

window.addEventListener("beforeunload", e => {
  if (!dirty) return;
  e.preventDefault();
  e.returnValue = "";
});

document.addEventListener("DOMContentLoaded", async () => {
  if (typeof requireAuth === "function") {
    try {
      await requireAuth();
    } catch {
      return;
    }
  }
  loadRows();
});
