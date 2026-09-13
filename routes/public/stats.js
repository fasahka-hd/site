const apiStatus = document.getElementById("apiStatus");

const refreshBtn = document.getElementById("refresh");

const totalPlayers = document.getElementById("totalPlayers");

const totalBans = document.getElementById("totalBans");

const activeBans = document.getElementById("activeBans");

const topPlaytime = document.getElementById("topPlaytime");

const topMoney = document.getElementById("topMoney");

function formatPlaytime(seconds) {
  if (!seconds) return "0ч";
  const hours = Math.floor(seconds / 3600);
  const days = Math.floor(hours / 24);
  if (days > 0) {
    return `${days}д ${hours % 24}ч`;
  }
  return `${hours}ч`;
}

function formatMoney(amount) {
  if (!amount) return "0 ₽";
  return amount.toLocaleString("ru-RU") + " ₽";
}

function escapeHtml(str) {
  return (str ?? "").toString().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
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
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transform = "translateY(-6px)";
  }, 2400);
  setTimeout(() => {
    el.remove();
  }, 3e3);
}

let _statsLoadedOnce = false;

async function loadStats() {
  if (apiStatus) apiStatus.textContent = "API: загрузка...";
  if (!_statsLoadedOnce && window.UI) {
    UI.skeletonRows(topPlaytime, 6, 3);
    UI.skeletonRows(topMoney, 6, 3);
  }
  try {
    const response = await fetch("./api/stats?_=" + Date.now(), {
      cache: "no-store",
      credentials: "include",
      headers: {
        "Cache-Control": "no-cache, no-store, must-revalidate",
        Pragma: "no-cache",
        Expires: "0"
      }
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    if (!data.ok) {
      throw new Error(data.error || "API вернул ошибку");
    }
    if (apiStatus) apiStatus.textContent = "API: OK";
    _statsLoadedOnce = true;
    const setNum = (el, v) => {
      if (!el) return;
      if (window.UI && UI.animateNumber) UI.animateNumber(el, Number(v) || 0); else el.textContent = (Number(v) || 0).toLocaleString("ru-RU");
    };
    setNum(totalPlayers, data.stats.total_players);
    setNum(totalBans, data.stats.total_bans);
    setNum(activeBans, data.stats.active_bans);
    if (topPlaytime) {
      topPlaytime.innerHTML = "";
      if (data.top_playtime && data.top_playtime.length > 0) {
        data.top_playtime.forEach((player, index) => {
          const tr = document.createElement("tr");
          tr.innerHTML = `\n                        <td>${index + 1}</td>\n                        <td>\n                            <div style="font-weight: 600;">${escapeHtml(player.name || "Неизвестно")}</div>\n                            <div style="color: var(--muted); font-size: 11px;">${escapeHtml(player.steamid32 || player.steamid || "")}</div>\n                        </td>\n                        <td>${formatPlaytime(player.playtime)}</td>\n                    `;
          topPlaytime.appendChild(tr);
        });
      } else {
        topPlaytime.innerHTML = `<tr><td colspan="3" class="banEmpty">Нет данных</td></tr>`;
      }
    }
    if (topMoney) {
      topMoney.innerHTML = "";
      if (data.top_money && data.top_money.length > 0) {
        data.top_money.forEach((player, index) => {
          const tr = document.createElement("tr");
          tr.innerHTML = `\n                        <td>${index + 1}</td>\n                        <td>\n                            <div style="font-weight: 600;">${escapeHtml(player.name || "Неизвестно")}</div>\n                            <div style="color: var(--muted); font-size: 11px;">${escapeHtml(player.steamid32 || player.steamid || "")}</div>\n                        </td>\n                        <td>${formatMoney(player.money)}</td>\n                    `;
          topMoney.appendChild(tr);
        });
      } else {
        topMoney.innerHTML = `<tr><td colspan="3" class="banEmpty">Нет данных</td></tr>`;
      }
    }
  } catch (error) {
    if (apiStatus) apiStatus.textContent = "API: ERROR";
    console.error("Ошибка загрузки статистики:", error);
    const errorMsg = error.message.includes("UNAUTHORIZED") ? "Нет доступа. Войдите снова." : "Ошибка загрузки данных";
    toast(errorMsg, false);
    if (topPlaytime) topPlaytime.innerHTML = `<tr><td colspan="3" class="banEmpty">Ошибка загрузки</td></tr>`;
    if (topMoney) topMoney.innerHTML = `<tr><td colspan="3" class="banEmpty">Ошибка загрузки</td></tr>`;
    if (totalPlayers) totalPlayers.textContent = "0";
    if (totalBans) totalBans.textContent = "0";
    if (activeBans) activeBans.textContent = "0";
  }
}

if (refreshBtn) refreshBtn.addEventListener("click", loadStats);

document.addEventListener("DOMContentLoaded", loadStats);

setInterval(loadStats, 3e4);
