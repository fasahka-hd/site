const apiStatus = document.getElementById("apiStatus");

const subLine = document.getElementById("subLine");

const err = document.getElementById("err");

const q = document.getElementById("q");

const perPageSel = document.getElementById("perPage");

const refreshBtn = document.getElementById("refresh");

const activeOnly = document.getElementById("activeOnly");

const tbody = document.getElementById("tbody");

const pager = document.getElementById("pager");

const prevPageBtn = document.getElementById("prevPage");

const nextPageBtn = document.getElementById("nextPage");

const pageInfo = document.getElementById("pageInfo");

let page = 1;

function escapeArg(s) {
  return String(s || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function toast(text, ok = true) {
  if (window.UI && UI.toast) {
    UI.toast({
      text: text,
      ok: ok
    });
    return;
  }
  const wrap = document.getElementById("toastWrap");
  const el = document.createElement("div");
  el.className = "toast " + (ok ? "ok" : "bad");
  el.innerHTML = `<div class="toastTitle"></div><div class="toastText"></div>`;
  el.querySelector(".toastTitle").textContent = ok ? "OK" : "Ошибка";
  el.querySelector(".toastText").textContent = text;
  wrap.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transform = "translateY(-6px)";
  }, 2400);
  setTimeout(() => {
    el.remove();
  }, 3e3);
}

function fmtDate(ts) {
  if (!ts) return "—";
  const d = new Date(Number(ts) * 1e3);
  return d.toLocaleString("ru-RU");
}

function fmtLen(sec) {
  sec = Number(sec || 0);
  if (sec === 0) return "PERM";
  if (!sec) return "—";
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ч`;
  const d = Math.floor(h / 24);
  return `${d} д`;
}

function escapeHtml(str) {
  return (str ?? "").toString().replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function modal({title: title, body: body, onOk: onOk, okText: okText, okClass: okClass}) {
  const ov = document.createElement("div");
  ov.className = "modalOverlay";
  const card = document.createElement("div");
  card.className = "modalCard";
  card.innerHTML = `\n    <div class="modalTitle">${title}</div>\n    <div class="modalBody"></div>\n    <div class="modalActions">\n      <button class="btn" id="mCancel">Отмена</button>\n      <button class="btn ${okClass || "gray"}" id="mOk">${okText || "OK"}</button>\n    </div>\n  `;
  card.querySelector(".modalBody").appendChild(body);
  ov.appendChild(card);
  document.body.appendChild(ov);
  ov.addEventListener("click", e => {
    if (e.target === ov) ov.remove();
  });
  card.querySelector("#mCancel").onclick = () => ov.remove();
  card.querySelector("#mOk").onclick = async () => {
    const okBtn = card.querySelector("#mOk");
    okBtn.disabled = true;
    okBtn.textContent = "Загрузка...";
    try {
      await onOk();
      ov.remove();
    } catch (error) {
      toast("Ошибка: " + error.message, false);
      okBtn.disabled = false;
      okBtn.textContent = okText || "OK";
    }
  };
}

function steamid64ToSteamid(steamid64) {
  if (!steamid64 || steamid64 === "") return steamid64;
  if (steamid64.includes("STEAM_")) return steamid64;
  if (!/^\d{17}$/.test(steamid64)) return steamid64;
  try {
    const base = BigInt("76561197960265728");
    const sid64 = BigInt(steamid64);
    if (sid64 < base) return steamid64;
    const diff = sid64 - base;
    const y = Number(diff % 2n);
    const z = Number((diff - BigInt(y)) / 2n);
    return `STEAM_0:${y}:${z}`;
  } catch (e) {
    return steamid64;
  }
}

function steamInputToCommand(value) {
  const s = String(value || "").trim();
  if (!s) return "";
  if (/^7656119\d{10}$/.test(s)) return s;
  const m = /^STEAM_[0-5]:([01]):(\d+)$/i.exec(s);
  if (m) return `STEAM_0:${m[1]}:${m[2]}`;
  const u = /^\[U:1:(\d+)\]$/i.exec(s);
  if (u) return String(76561197960265728n + BigInt(u[1]));
  return "";
}

const _unbannedSet = new Set;

window.unbanPlayer = function(steamid, playerName) {
  if (_unbannedSet.has(steamid)) {
    toast("Игрок уже разбанен", false);
    return;
  }
  let steamidToUse = steamid;
  if (!steamidToUse.includes("STEAM_") && /^\d{17}$/.test(steamidToUse)) {
    steamidToUse = steamid64ToSteamid(steamidToUse);
  }
  const inp = document.createElement("input");
  inp.className = "modalInput";
  inp.placeholder = "Причина разбана";
  inp.value = "";
  modal({
    title: `Разбан игрока ${escapeHtml(playerName)}`,
    body: inp,
    okText: "Разбанить",
    okClass: "green",
    onOk: async () => {
      const reason = inp.value.trim() || "";
      const command = `ba unban ${steamidToUse} "${escapeArg(reason)}"`;
      const params = new URLSearchParams;
      params.append("type", "console");
      params.append("text", command);
      const r = await fetch("./api/command", {
        method: "POST",
        headers: {
          "X-Requested-With": "XMLHttpRequest",
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: params.toString(),
        cache: "no-store",
        credentials: "include"
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j || !j.ok) throw new Error(j?.error || "HTTP " + r.status);
      _unbannedSet.add(steamid);
      const sidSel = window.CSS && CSS.escape ? CSS.escape(steamid) : String(steamid).replace(/["\\]/g, "\\$&");
      document.querySelectorAll(`[data-unban-sid="${sidSel}"]`).forEach(btn => {
        btn.disabled = true;
        btn.className = "btn small";
        btn.textContent = "Разбанен";
        btn.style.opacity = "0.5";
        btn.style.cursor = "not-allowed";
      });
      toast("Игрок разбанен", true);
      setTimeout(() => load(), 3e3);
    }
  });
};

function render(items) {
  tbody.innerHTML = "";
  if (!items.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="banEmpty">Нет записей</td></tr>`;
    return;
  }
  for (const b of items) {
    const tr = document.createElement("tr");
    const player = escapeHtml((b.name || "—").toString());
    const playerSteam = escapeHtml((b.steamid || "").toString());
    const playerSteam64 = escapeHtml((b.steamid64 || "").toString());
    const admin = escapeHtml((b.a_name || "—").toString());
    const adminSteam = escapeHtml((b.a_steamid || "").toString());
    const banTime = escapeHtml(fmtDate(b.ban_time));
    const unbanTime = b.unban_time ? escapeHtml(fmtDate(b.unban_time)) : "";
    const rawSteamid = b.steamid || "";
    const rawName = b.name || "";
    const wasUnbanned = _unbannedSet.has(rawSteamid);
    const active = wasUnbanned ? false : !!b.active;
    const unbanReason = (b.unban_reason || "").toString().trim();
    const expiredSelf = !active && !unbanReason && !wasUnbanned && Number(b.ban_len) > 0;
    let exitLabel = "";
    if (!active) {
      if (unbanReason) exitLabel = "Разбан: " + unbanReason; else if (wasUnbanned) exitLabel = "Разбан админом"; else if (expiredSelf) exitLabel = "Истёк срок бана (отсидел)";
    }
    const actionType = active ? Number(b.ban_len) === 0 ? "В бане PERM" : "В бане" : expiredSelf ? "Срок истёк" : unbanReason || wasUnbanned ? "Разбанен" : "Не в бане";
    const reason = escapeHtml((b.reason || "—").toString());
    const banLength = Number(b.ban_len) === 0 ? "PERM" : fmtLen(b.ban_len);
    const statusClass = active ? "active" : unbanReason || wasUnbanned || expiredSelf ? "done" : "idle";
    tr.className = "banRow " + statusClass;
    tr.innerHTML = `\n      <td>\n        <div class="banPerson">\n          <div class="banPersonName">${player}</div>\n          <div class="banSteam mono" title="${playerSteam64 ? "SteamID64: " + playerSteam64 : ""}">${playerSteam}</div>\n        </div>\n      </td>\n      <td>\n        <div class="banPerson admin">\n          <div class="banPersonName">${admin}</div>\n          <div class="banSteam mono">${adminSteam}</div>\n        </div>\n      </td>\n      <td>\n        <div class="banTimeStack">\n          <div><span>Бан</span><b>${banTime}</b></div>\n          ${unbanTime ? `<div class="unban"><span>Разбан</span><b>${unbanTime}</b></div>` : ""}\n        </div>\n      </td>\n      <td>\n        <span class="banStatus ${statusClass}">${actionType}</span>\n        <div class="banLen">${banLength === "PERM" ? "Перманентно" : `Длительность: ${banLength}`}</div>\n      </td>\n      <td>\n        <div class="banReasonText">${reason}</div>\n        ${exitLabel ? `<div class="banReasonSub">${escapeHtml(exitLabel)}</div>` : ``}\n      </td>\n      <td></td>\n    `;
    const actionCell = tr.querySelector("td:last-child");
    const unbanBtnEl = document.createElement("button");
    unbanBtnEl.setAttribute("data-unban-sid", rawSteamid);
    unbanBtnEl.setAttribute("data-perm", "unban");
    unbanBtnEl.className = active ? "btn small green" : "btn small";
    unbanBtnEl.disabled = !active;
    unbanBtnEl.textContent = active ? "Разбанить" : "Разбанен";
    if (!active) {
      unbanBtnEl.style.opacity = "0.5";
      unbanBtnEl.style.cursor = "not-allowed";
    }
    if (active) {
      unbanBtnEl.addEventListener("click", () => unbanPlayer(rawSteamid, rawName));
    }
    if (window.__PERMS && window.__PERMS.unban !== true && window.__PERMS.unban !== 1 && window.__PERMS.unban !== "true" && window.__PERMS.unban !== "yes") {
      unbanBtnEl.style.display = "none";
    }
    actionCell.appendChild(unbanBtnEl);
    tbody.appendChild(tr);
  }
}

let _bansLoadedOnce = false;

async function load() {
  apiStatus.textContent = "API: загрузка...";
  if (!_bansLoadedOnce && window.UI) UI.skeletonRows(tbody, 8, 6);
  err.style.display = "none";
  const perPage = parseInt(perPageSel.value || "20", 10);
  const qs = new URLSearchParams;
  qs.set("page", String(page));
  qs.set("per_page", String(perPage));
  if ((q.value || "").trim()) qs.set("q", (q.value || "").trim());
  qs.set("_", Date.now());
  if (activeOnly && activeOnly.checked) qs.set("active_only", "1");
  try {
    const r = await fetch("./api/bans?" + qs.toString(), {
      cache: "no-store",
      credentials: "include"
    });
    const data = await r.json().catch(() => null);
    if (!r.ok || !data || !data.ok) throw new Error(data?.error || "HTTP " + r.status);
    apiStatus.textContent = "API: OK";
    _bansLoadedOnce = true;
    const total = parseInt(data.total || 0, 10);
    const pages = Math.max(1, Math.ceil(total / perPage));
    if (page > pages) page = pages;
    if (page < 1) page = 1;
    subLine.textContent = `Всего банов: ${total} • Страница ${page}/${pages}`;
    render(Array.isArray(data.items) ? data.items : []);
    pager.style.display = pages > 1 ? "flex" : "none";
    pageInfo.textContent = `Страница ${page}/${pages}`;
    prevPageBtn.disabled = page <= 1;
    nextPageBtn.disabled = page >= pages;
  } catch (e) {
    apiStatus.textContent = "API: ERROR";
    err.style.display = "block";
    subLine.textContent = "Ошибка загрузки";
    toast("Ошибка загрузки банов: " + (e.message || e), false);
    tbody.innerHTML = `<tr><td colspan="6" class="banEmpty">Ошибка загрузки</td></tr>`;
    pager.style.display = "none";
  }
}

perPageSel.addEventListener("change", () => {
  page = 1;
  load();
});

refreshBtn.addEventListener("click", load);

q.addEventListener("input", () => {
  clearTimeout(window.__bq);
  window.__bq = setTimeout(() => {
    page = 1;
    load();
  }, 250);
});

prevPageBtn.addEventListener("click", () => {
  if (page > 1) {
    page--;
    load();
  }
});

nextPageBtn.addEventListener("click", () => {
  page++;
  load();
});

load();

setInterval(load, 3e4);

if (activeOnly) activeOnly.addEventListener("change", () => {
  page = 1;
  load();
});

const massBanBtn = document.getElementById("massBanBtn");

function buildMassBanUI() {
  const wrap = document.createElement("div");
  wrap.className = "massOriginal massBanOriginal";
  wrap.innerHTML = `\n    <div class="massOriginalBody">\n      <div class="massOriginalListBox">\n        <div class="massFieldTitle">SteamID игроков</div>\n        <div class="massOriginalList" id="mbList"></div>\n        <div class="massToolbar compact">\n          <button class="btn" id="mbAdd" type="button">Добавить строку</button>\n          <button class="btn" id="mbPaste" type="button">Вставить списком</button>\n        </div>\n      </div>\n      <div class="massOriginalSettings">\n        <div class="massFieldCard">\n          <div class="massFieldTitle">Срок бана</div>\n          <div class="massInline">\n            <input class="modalInput" id="mbTime" type="number" min="1" step="1" placeholder="30" />\n            <select class="modalSelect" id="mbTimeUnit">\n              <option value="mi">мин</option>\n              <option value="h">час</option>\n              <option value="d">день</option>\n              <option value="mo">мес</option>\n            </select>\n          </div>\n          <label class="massCheck"><input type="checkbox" id="mbPerma" /><span>Перманентно</span></label>\n        </div>\n        <div class="massFieldCard">\n          <div class="massFieldTitle">Причина</div>\n          <select class="modalSelect" id="mbReasonSel">\n            <option value="">Выбрать причину</option>\n            <option value="RDM">RDM</option>\n            <option value="NRP">NRP</option>\n            <option value="NLR">NLR</option>\n            <option value="MassRDM">Mass RDM</option>\n            <option value="Cheats">Cheats</option>\n            <option value="Abuse">Abuse</option>\n            <option value="Toxic">Toxic</option>\n            <option value="Другое">Другое</option>\n          </select>\n          <input class="modalInput" id="mbReasonCustom" placeholder="Своя причина" />\n        </div>\n      </div>\n    </div>\n    <div class="massStatus" id="mbHint"></div>\n  `;
  return wrap;
}

function addSteamRow(listEl, value = "") {
  const row = document.createElement("div");
  row.className = "massOriginalRow";
  const inp = document.createElement("input");
  inp.className = "modalInput mbSteam";
  inp.placeholder = "STEAM_0:1:123456";
  inp.value = value;
  const del = document.createElement("button");
  del.className = "btn danger massOriginalDel";
  del.textContent = "×";
  del.addEventListener("click", () => {
    row.remove();
    listEl.dispatchEvent(new Event("input", {
      bubbles: true
    }));
  });
  row.appendChild(inp);
  row.appendChild(del);
  listEl.appendChild(row);
  inp.addEventListener("input", () => listEl.dispatchEvent(new Event("input", {
    bubbles: true
  })));
}

async function sendConsoleCommand(text) {
  const params = new URLSearchParams;
  params.append("type", "console");
  params.append("text", text);
  const r = await fetch("./api/command", {
    method: "POST",
    headers: {
      "X-Requested-With": "XMLHttpRequest",
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: params.toString(),
    cache: "no-store",
    credentials: "include"
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || !j.ok) throw new Error(j?.error || "HTTP " + r.status);
  return j;
}

if (massBanBtn) {
  massBanBtn.addEventListener("click", () => {
    const ui = buildMassBanUI();
    const listEl = ui.querySelector("#mbList");
    const addBtn = ui.querySelector("#mbAdd");
    const pasteBtn = ui.querySelector("#mbPaste");
    const timeInp = ui.querySelector("#mbTime");
    const permaCb = ui.querySelector("#mbPerma");
    const timeUnit = ui.querySelector("#mbTimeUnit");
    const reasonSel = ui.querySelector("#mbReasonSel");
    const reasonCustom = ui.querySelector("#mbReasonCustom");
    const hint = ui.querySelector("#mbHint");
    const counter = ui.querySelector("#mbCounter");
    addSteamRow(listEl);
    const idsNow = () => Array.from(ui.querySelectorAll(".mbSteam")).map(i => i.value.trim()).filter(Boolean);
    const validIdsNow = () => idsNow().map(sid => steamInputToCommand(sid)).filter(Boolean);
    const invalidIdsNow = () => idsNow().filter(sid => !steamInputToCommand(sid));
    const reasonNow = () => ((reasonCustom.value || "").trim() || (reasonSel.value || "").trim()).trim();
    const markSteamInputs = () => {
      ui.querySelectorAll(".mbSteam").forEach(inp => {
        const val = inp.value.trim();
        inp.classList.toggle("steamInvalid", !!val && !steamInputToCommand(val));
      });
    };
    const updateHint = () => {
      const ids = idsNow();
      const validIds = validIdsNow();
      const invalidIds = invalidIdsNow();
      markSteamInputs();
      const perma = permaCb.checked;
      const tNum = parseInt((timeInp.value || "").trim(), 10);
      const t = !Number.isNaN(tNum) && tNum > 0 ? `${tNum}${timeUnit.value || "mi"}` : "";
      const reason = reasonNow();
      const ready = validIds.length > 0 && invalidIds.length === 0 && (perma || !!t) && !!reason;
      if (counter) counter.textContent = String(validIds.length);
      timeInp.disabled = perma;
      timeUnit.disabled = perma;
      reasonCustom.style.display = reasonSel.value === "Другое" || reasonCustom.value ? "" : "none";
      hint.className = "massStatus " + (ready ? "ok" : "bad");
      hint.innerHTML = `\n        <div class="massStatusGrid">\n          <div><span>Игроков</span><b>${validIds.length}${invalidIds.length ? ` / ошибок ${invalidIds.length}` : ""}</b></div>\n          <div><span>Срок</span><b>${perma ? "PERMA" : t || "—"}</b></div>\n          <div><span>Причина</span><b>${escapeHtml(reason || "—")}</b></div>\n        </div>\n        <div class="massStatusLine">${ready ? "Готово к выдаче банов" : invalidIds.length ? "Проверь неверные SteamID" : "Заполни SteamID, срок и причину"}</div>\n      `;
    };
    addBtn.addEventListener("click", () => {
      addSteamRow(listEl);
      updateHint();
    });
    pasteBtn.addEventListener("click", async () => {
      try {
        const txt = await navigator.clipboard.readText();
        const lines = (txt || "").split(/[\r\n,;\t ]+/).map(x => x.trim()).filter(Boolean);
        if (!lines.length) return;
        listEl.innerHTML = "";
        for (const line of lines) addSteamRow(listEl, line);
        updateHint();
      } catch (e) {
        toast("Не удалось прочитать буфер обмена", false);
      }
    });
    [ listEl, timeInp, timeUnit, permaCb, reasonSel, reasonCustom ].forEach(el => {
      el.addEventListener("input", updateHint);
      el.addEventListener("change", updateHint);
    });
    updateHint();
    modal({
      title: "Массовые баны",
      body: ui,
      okText: "Забанить всех",
      okClass: "danger",
      onOk: async () => {
        const ids = idsNow();
        const invalidIds = invalidIdsNow();
        const commandIds = validIdsNow();
        const perma = permaCb.checked;
        const tNum = parseInt((timeInp.value || "").trim(), 10);
        const t = !Number.isNaN(tNum) && tNum > 0 ? `${tNum}${timeUnit.value || "mi"}` : "";
        const reason = reasonNow();
        if (!ids.length) {
          toast("Добавь хотя бы один SteamID", false);
          throw new Error("NO_IDS");
        }
        if (invalidIds.length) {
          markSteamInputs();
          toast("Есть неверные SteamID: " + invalidIds.slice(0, 3).join(", "), false);
          throw new Error("BAD_STEAMID");
        }
        if (!commandIds.length) {
          toast("Нет корректных SteamID", false);
          throw new Error("NO_VALID_IDS");
        }
        if (!perma && !t) {
          toast("Укажи срок бана или включи перманентно", false);
          throw new Error("NO_TIME");
        }
        if (!reason) {
          toast("Укажи причину", false);
          throw new Error("NO_REASON");
        }
        let ok = 0, fail = 0;
        for (const sid of commandIds) {
          const cmd = perma ? `ba perma ${sid} "${escapeArg(reason)}"` : `ba ban ${sid} ${t} "${escapeArg(reason)}"`;
          try {
            await sendConsoleCommand(cmd);
            ok++;
          } catch (e) {
            fail++;
          }
        }
        toast(`Массовые баны: успешно ${ok}, ошибок ${fail}`, fail === 0);
        setTimeout(() => {
          page = 1;
          load();
        }, 800);
      }
    });
    setTimeout(() => ui.querySelector(".mbSteam")?.focus(), 60);
  });
}

if (massBanBtn && location.hash === "#mass") {
  setTimeout(() => massBanBtn.click(), 500);
}
