(() => {
  "use strict";
  const frame = document.getElementById("techFrame");
  const tabs = [ ...document.querySelectorAll(".hubTab") ];
  tabs.forEach(t => {
    t.style.display = "none";
    t.classList.remove("perm-allowed");
  });
  function allowed(tab) {
    const perm = tab.getAttribute("data-perm");
    const roleOnly = tab.getAttribute("data-role-only");
    if (roleOnly) return (window.__ME && window.__ME.role || window.__EARLY_ROLE || "") === roleOnly;
    if (!perm) return true;
    return typeof window.hasPerm === "function" ? window.hasPerm(perm) : !!(window.__PERMS && window.__PERMS[perm]);
  }
  function setTabVisible(tab, ok) {
    tab.classList.toggle("perm-allowed", !!ok);
    tab.style.display = ok ? "" : "none";
    tab.setAttribute("aria-hidden", ok ? "false" : "true");
  }
  function wantedTab() {
    try {
      const p = new URLSearchParams(location.search).get("tab");
      if (!p) return null;
      return tabs.find(t => (t.dataset.frame || "").includes("/" + p)) || null;
    } catch {
      return null;
    }
  }
  function sync() {
    let first = null;
    for (const tab of tabs) {
      const ok = allowed(tab);
      setTabVisible(tab, ok);
      if (ok && !first) first = tab;
    }
    const wanted = wantedTab();
    const active = (wanted && allowed(wanted) && wanted.style.display !== "none" ? wanted : null) || tabs.find(t => t.classList.contains("active") && t.style.display !== "none") || first;
    if (active) activate(active); else if (frame) frame.removeAttribute("src");
  }
  function activate(tab) {
    if (!tab || !allowed(tab)) return;
    tabs.forEach(t => t.classList.toggle("active", t === tab));
    if (frame) {
      const next = tab.dataset.frame + (tab.dataset.frame.includes("?") ? "&" : "?") + "embed=1";
      if (frame.getAttribute("src") !== next) frame.src = next;
    }
  }
  tabs.forEach(tab => tab.addEventListener("click", () => activate(tab)));
  window.addEventListener("perms:updated", sync);
  document.addEventListener("DOMContentLoaded", sync);
  sync();
  setTimeout(sync, 50);
  setTimeout(sync, 300);
  setTimeout(sync, 1e3);
})();
