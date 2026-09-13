(() => {
  "use strict";
  const countdownEl = document.getElementById("countdown");
  const reasonEl = document.getElementById("reasonLine");
  const statusEl = document.getElementById("statusLine");
  const dailyCountdownEl = document.getElementById("dailyCountdown");
  const dailyReasonEl = document.getElementById("dailyReasonLine");
  const reasonSelect = document.getElementById("reasonSelect");
  const customReason = document.getElementById("customReason");
  const minutesInput = document.getElementById("minutes");
  const scheduleBtn = document.getElementById("scheduleBtn");
  const cancelBtn = document.getElementById("cancelBtn");
  let interval = null;
  let currentState = {
    seconds: 0,
    reason: "",
    restarting: false,
    updated: 0,
    nextDaily: 0
  };
  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor(sec % 3600 / 60);
    const s = sec % 60;
    if (h > 0) return `${h}ч ${m}м ${s}с`;
    return `${m}м ${s}с`;
  }
  function updateUI(state) {
    currentState = {
      ...currentState,
      ...state || {}
    };
    if (currentState.restarting) {
      countdownEl.textContent = "РЕСТАРТ ВЫПОЛНЯЕТСЯ";
      countdownEl.className = "restart-countdown restarting";
      reasonEl.textContent = currentState.reason || "Выполняется рестарт карты...";
      statusEl.textContent = "Сервер перезапускается прямо сейчас";
      scheduleBtn.disabled = true;
      cancelBtn.disabled = true;
    } else if (currentState.seconds > 0) {
      countdownEl.textContent = fmtTime(currentState.seconds);
      countdownEl.className = "restart-countdown";
      reasonEl.textContent = currentState.reason || "Без причины";
      statusEl.textContent = "Рестарт запланирован";
      scheduleBtn.disabled = false;
      cancelBtn.disabled = false;
    } else {
      countdownEl.textContent = "—";
      countdownEl.className = "restart-countdown";
      reasonEl.textContent = "Нет активного рестарта";
      statusEl.textContent = "Ожидание...";
      scheduleBtn.disabled = false;
      cancelBtn.disabled = true;
    }
  }
  function forceDailyCountdown() {
    if (!dailyCountdownEl) return;
    const dailySec = calculateDailyMoscow();
    dailyCountdownEl.textContent = fmtTime(dailySec);
    dailyCountdownEl.style.color = "#60a5fa";
  }
  function startIndependentDailyTimer() {
    forceDailyCountdown();
    setInterval(forceDailyCountdown, 1e3);
  }
  async function fetchState() {
    try {
      const res = await fetch("/api/restart_state", {
        credentials: "include"
      });
      if (!res.ok) throw new Error;
      const data = await res.json();
      if (data && data.ok) {
        updateUI({
          seconds: data.seconds || 0,
          reason: data.reason || "",
          restarting: !!data.restarting,
          updated: data.updated || Math.floor(Date.now() / 1e3),
          nextDaily: data.nextDaily || 0
        });
      }
    } catch (e) {
      const clientDaily = calculateDailyMoscow();
      updateUI({
        nextDaily: clientDaily
      });
    }
  }
  function calculateDailyMoscow() {
    const now = Math.floor(Date.now() / 1e3);
    const MOSCOW_OFFSET = 3 * 3600;
    const moscow = now + MOSCOW_OFFSET;
    const secondsToday = moscow % 86400;
    let nextDailySec = 6 * 3600;
    if (secondsToday >= nextDailySec) nextDailySec += 86400;
    return nextDailySec - secondsToday;
  }
  async function scheduleRestart() {
    let mins = parseInt(minutesInput.value, 10);
    if (!mins || mins < 1) mins = 1;
    if (mins > 1440) mins = 1440;
    let reason = reasonSelect.value;
    if (reason === "__custom") {
      reason = (customReason.value || "").trim();
    }
    if (!reason) reason = "Плановый рестарт";
    scheduleBtn.disabled = true;
    scheduleBtn.textContent = "Отправка...";
    try {
      const res = await fetch("/api/restart/schedule", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        credentials: "include",
        body: JSON.stringify({
          minutes: mins,
          reason: reason
        })
      });
      const json = await res.json();
      if (json.ok) {
        showToast("Рестарт запланирован", "success");
        await fetchState();
      } else {
        showToast("Ошибка: " + (json.error || "неизвестно"), "error");
      }
    } catch (e) {
      showToast("Ошибка сети", "error");
    } finally {
      scheduleBtn.disabled = false;
      scheduleBtn.textContent = "Запланировать рестарт";
    }
  }
  async function cancelRestart() {
    if (!confirm("Отменить запланированный рестарт?")) return;
    cancelBtn.disabled = true;
    try {
      const res = await fetch("/api/restart/cancel", {
        method: "POST",
        credentials: "include"
      });
      const json = await res.json();
      if (json.ok) {
        showToast("Рестарт отменён", "success");
        await fetchState();
      } else {
        showToast("Ошибка отмены", "error");
      }
    } catch {
      showToast("Ошибка сети", "error");
    } finally {
      cancelBtn.disabled = false;
    }
  }
  function bindUI() {
    reasonSelect.addEventListener("change", () => {
      customReason.style.display = reasonSelect.value === "__custom" ? "block" : "none";
    });
    scheduleBtn.addEventListener("click", scheduleRestart);
    cancelBtn.addEventListener("click", cancelRestart);
    minutesInput.addEventListener("keydown", e => {
      if (e.key === "Enter") scheduleRestart();
    });
  }
  function startPolling() {
    if (interval) clearInterval(interval);
    fetchState();
    interval = setInterval(fetchState, 1e3);
    setInterval(forceDailyCountdown, 1e3);
  }
  function init() {
    if (typeof window.hasPerm === "function") {}
    bindUI();
    startPolling();
    function startDailyTimer() {
      forceDailyCountdown();
      setInterval(forceDailyCountdown, 1e3);
    }
    startDailyTimer();
    setTimeout(startDailyTimer, 50);
    setTimeout(startDailyTimer, 300);
    setTimeout(startDailyTimer, 1e3);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) forceDailyCountdown();
    });
    window.addEventListener("beforeunload", () => {
      if (interval) clearInterval(interval);
    });
    console.log("%c[Restart] Daily 06:00 МСК timer started (client-side)", "color:#60a5fa");
  }
  if (!window.showToast) {
    window.showToast = function(msg, type = "info") {
      const wrap = document.getElementById("toastWrap");
      if (!wrap) return alert(msg);
      const t = document.createElement("div");
      t.className = `toast ${type}`;
      t.textContent = msg;
      wrap.appendChild(t);
      setTimeout(() => t.remove(), 3200);
    };
  }
  document.addEventListener("DOMContentLoaded", init);
  if (document.readyState !== "loading") init();
  (function forceDailyTimerForever() {
    const dailyEl = document.getElementById("dailyCountdown");
    if (!dailyEl) return;
    function tick() {
      const now = Math.floor(Date.now() / 1e3);
      const moscow = now + 3 * 3600;
      const secToday = moscow % 86400;
      let target = 6 * 3600;
      if (secToday >= target) target += 86400;
      const left = target - secToday;
      const h = Math.floor(left / 3600);
      const m = Math.floor(left % 3600 / 60);
      const s = left % 60;
      dailyEl.textContent = (h > 0 ? h + "ч " : "") + m + "м " + s + "с";
      dailyEl.style.color = "#60a5fa";
    }
    tick();
    setInterval(tick, 1e3);
    console.log("%c[Restart] Direct daily 06:00 timer FORCED", "color:lime");
  })();
})();
