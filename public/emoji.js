const $ = id => document.getElementById(id);

const apiStatus = $("apiStatus");

const err = $("err");

const tbody = $("tbody");

const refreshBtn = $("refresh");

const steamidInp = $("steamid");

const titleInp = $("title");

const emojiList = $("emojiList");

const giveBtn = $("giveBtn");

const previewEmoji = $("previewEmoji");

const previewTitle = $("previewTitle");

let catalog = [];

let selectedEmoji = "🎩";

function toast(text, ok = true) {
  if (window.UI && UI.toast) {
    UI.toast({
      text: text,
      ok: ok
    });
    return;
  }
  const wrap = $("toastWrap");
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
  setTimeout(() => el.remove(), 3e3);
}

function esc(s) {
  return (s ?? "").toString().replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function fmtDate(ts) {
  const n = Number(ts || 0);
  if (!n) return "—";
  return new Date(n * 1e3).toLocaleString("ru-RU");
}

async function apiJson(url, opts) {
  const r = await fetch(url, Object.assign({
    cache: "no-store",
    credentials: "include",
    headers: {
      "X-Requested-With": "XMLHttpRequest"
    }
  }, opts || {}));
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || !j.ok) {
    const map = {
      EMOJI_ALREADY_EXISTS: "У этого игрока уже есть эмодзи. Сначала забери старое.",
      BAD_STEAMID: "Некорректный SteamID",
      BAD_EMOJI: "Некорректное эмодзи",
      NO_TITLE: "Укажи титул"
    };
    throw new Error(map[j?.error] || j?.error || "HTTP " + r.status);
  }
  return j;
}

function renderCatalog() {
  emojiList.innerHTML = "";
  if (!catalog.length) {
    emojiList.innerHTML = `<div class="muted">Список пуст</div>`;
    return;
  }
  for (const item of catalog) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "emojiChoice" + (item.emoji === selectedEmoji ? " active" : "");
    btn.title = item.name;
    btn.innerHTML = `<span>${esc(item.emoji)}</span><small>${esc(item.name)}</small>`;
    btn.addEventListener("click", () => {
      selectedEmoji = item.emoji;
      renderCatalog();
      updatePreview();
    });
    emojiList.appendChild(btn);
  }
}

function updatePreview() {
  previewEmoji.textContent = selectedEmoji || "🎩";
  previewTitle.textContent = (titleInp.value || "").trim() || "Титул появится здесь";
}

titleInp.addEventListener("input", updatePreview);

function renderRows(items) {
  tbody.innerHTML = "";
  if (!items.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="banEmpty">Пока никому не выданы эмодзи</td></tr>`;
    return;
  }
  for (const item of items) {
    const tr = document.createElement("tr");
    tr.innerHTML = `\n      <td>\n        <div class="mono">${esc(item.steamid64)}</div>\n        <div class="muted mono" style="font-size:11px;margin-top:4px">${esc(item.steamid32)}</div>\n      </td>\n      <td><span class="emojiCell">${esc(item.emoji)}</span></td>\n      <td>${esc(item.title || "—")}</td>\n      <td>${esc(item.issued_by || "—")}</td>\n      <td>${esc(fmtDate(item.updated_at || item.issued_at))}</td>\n      <td><button class="btn small danger" data-revoke="${esc(item.steamid64)}">Забрать</button></td>\n    `;
    tr.querySelector("button[data-revoke]").addEventListener("click", async () => {
      const ok = window.UI && UI.confirm ? await UI.confirm({
        title: "Забрать эмодзи?",
        text: `У игрока ${item.steamid64} будет снят значок.`,
        okText: "Забрать",
        danger: true,
        icon: "✨"
      }) : confirm(`Забрать эмодзи у ${item.steamid64}?`);
      if (!ok) return;
      try {
        await apiJson("./api/player_emojis", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Requested-With": "XMLHttpRequest"
          },
          body: JSON.stringify({
            action: "revoke",
            steamid: item.steamid64
          })
        });
        toast("Эмодзи забрано");
        await load();
      } catch (e) {
        toast(e.message || "Ошибка", false);
      }
    });
    tbody.appendChild(tr);
  }
}

async function load() {
  apiStatus.textContent = "API: загрузка...";
  err.style.display = "none";
  try {
    const [cat, rows] = await Promise.all([ apiJson("./api/emojis/catalog?_=" + Date.now()), apiJson("./api/player_emojis?_=" + Date.now()) ]);
    catalog = Array.isArray(cat.items) ? cat.items : [];
    if (catalog.length && !catalog.some(x => x.emoji === selectedEmoji)) selectedEmoji = catalog[0].emoji;
    renderCatalog();
    renderRows(Array.isArray(rows.items) ? rows.items : []);
    updatePreview();
    apiStatus.textContent = "API: OK";
  } catch (e) {
    apiStatus.textContent = "API: ERROR";
    err.textContent = "Ошибка: " + (e.message || e);
    err.style.display = "block";
    tbody.innerHTML = `<tr><td colspan="6" class="banEmpty">Ошибка загрузки</td></tr>`;
    toast("Ошибка загрузки: " + (e.message || e), false);
  }
}

giveBtn.addEventListener("click", async () => {
  const steamid = (steamidInp.value || "").trim();
  const title = (titleInp.value || "").trim();
  if (!steamid) return toast("Укажи SteamID", false);
  if (!selectedEmoji) return toast("Выбери эмодзи", false);
  if (!title) return toast("Укажи титул", false);
  giveBtn.disabled = true;
  try {
    await apiJson("./api/player_emojis", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Requested-With": "XMLHttpRequest"
      },
      body: JSON.stringify({
        action: "give",
        steamid: steamid,
        emoji: selectedEmoji,
        title: title
      })
    });
    toast("Эмодзи выдано");
    steamidInp.value = "";
    titleInp.value = "";
    updatePreview();
    await load();
  } catch (e) {
    toast(e.message || "Ошибка выдачи", false);
  } finally {
    giveBtn.disabled = false;
  }
});

refreshBtn.addEventListener("click", load);

document.addEventListener("DOMContentLoaded", load);
