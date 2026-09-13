(function cleanLoginUrl() {
  try {
    const u = new URL(location.href);
    if (u.searchParams.has("next")) {
      u.searchParams.delete("next");
      history.replaceState(null, "", u.toString().replace(/\?$/, ""));
    }
  } catch (e) {}
})();

function toast(ok, title, text) {
  const wrap = document.getElementById("toastWrap");
  const el = document.createElement("div");
  el.className = "toast " + (ok ? "ok" : "bad");
  el.innerHTML = `<div class="toastTitle"></div><div class="toastText"></div>`;
  el.querySelector(".toastTitle").textContent = title;
  el.querySelector(".toastText").textContent = text;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), 3e3);
}

function nextUrl() {
  const u = new URL(location.href);
  const n = u.searchParams.get("next");
  if (!n) return "/";
  if (/^[a-z][a-z0-9+.-]*:/i.test(n)) return "/";
  if (/^\//.test(n)) return n;
  if (/[\u0000-\u001f\u007f]/.test(n)) return "/";
  const path = n.startsWith("/") ? n.slice(1) : n;
  if (!/^[A-Za-z0-9._~\-/?#&=%+]*$/.test(path)) return "/";
  return path;
}

const errLine = document.getElementById("errLine");

const passwordPanel = document.getElementById("passwordPanel");

const passwordOverlay = document.getElementById("passwordOverlay");

const passwordToggle = document.getElementById("btnPasswordToggle");

const passwordClose = document.getElementById("btnPasswordClose");

function showErr(msg) {
  if (!errLine) return;
  errLine.style.display = "block";
  errLine.textContent = msg;
}

function clearErr() {
  if (!errLine) return;
  errLine.style.display = "none";
  errLine.textContent = "";
}

function openPasswordPanel() {
  if (!passwordPanel || !passwordOverlay) return;
  passwordOverlay.classList.add("show");
  passwordPanel.classList.add("show");
  passwordOverlay.setAttribute("aria-hidden", "false");
  document.body.classList.add("loginModalOpen");
  setTimeout(() => document.getElementById("steamid64")?.focus(), 180);
}

function closePasswordPanel() {
  if (!passwordPanel || !passwordOverlay) return;
  passwordPanel.classList.remove("show");
  passwordOverlay.classList.remove("show");
  passwordOverlay.setAttribute("aria-hidden", "true");
  document.body.classList.remove("loginModalOpen");
}

if (passwordToggle) {
  passwordToggle.addEventListener("click", () => {
    clearErr();
    openPasswordPanel();
  });
}

if (passwordClose) passwordClose.addEventListener("click", closePasswordPanel);

if (passwordOverlay) {
  passwordOverlay.addEventListener("click", e2 => {
    if (e2.target === passwordOverlay) closePasswordPanel();
  });
}

document.getElementById("btnSteam").addEventListener("click", () => {
  clearErr();
  const n = nextUrl();
  location.href = "./api/steam_login";
});

async function doLogin() {
  clearErr();
  const steamid64 = (document.getElementById("steamid64").value || "").trim();
  const password = document.getElementById("password").value || "";
  if (!steamid64 || !password) {
    openPasswordPanel();
    showErr("Заполни SteamID64 и пароль.");
    return;
  }
  const r = await fetch("./api/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      steamid64: steamid64,
      password: password
    }),
    cache: "no-store",
    credentials: "include"
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || !j.ok) {
    showErr(j?.error ? "Ошибка: " + j.error : "Неверные данные или нет доступа.");
    return;
  }
  location.href = nextUrl();
}

document.getElementById("btnLogin").addEventListener("click", doLogin);

document.getElementById("btnClear").addEventListener("click", () => {
  clearErr();
  document.getElementById("steamid64").value = "";
  document.getElementById("password").value = "";
});

document.addEventListener("keydown", e2 => {
  if (e2.key === "Escape" && passwordOverlay?.classList.contains("show")) {
    closePasswordPanel();
    return;
  }
  if (e2.key !== "Enter") return;
  if (passwordOverlay && !passwordOverlay.classList.contains("show")) {
    openPasswordPanel();
    return;
  }
  doLogin();
});

const e = new URL(location.href).searchParams.get("e");

if (e) {
  openPasswordPanel();
  toast(false, "Ошибка", e);
  showErr(e);
}
