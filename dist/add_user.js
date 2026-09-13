requireAuth().then(() => {}).catch(() => {});

const apiStatus = document.getElementById("apiStatus");

const err = document.getElementById("err");

const addBtn = document.getElementById("addBtn");

const usersList = document.getElementById("usersList");

const totalUsers = document.getElementById("totalUsers");

const kpUsers = document.getElementById("kpUsers");

const rootUsers = document.getElementById("rootUsers") || document.getElementById("otherUsers");

function roleSlug(role) {
  role = (role || "").toString();
  return role === "KP" ? "kp" : "";
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
  const _t1 = document.createElement("div");
  _t1.className = "toastTitle";
  _t1.textContent = ok ? "OK" : "Ошибка";
  const _t2 = document.createElement("div");
  _t2.className = "toastText";
  _t2.textContent = text;
  el.appendChild(_t1);
  el.appendChild(_t2);
  wrap.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transform = "translateY(-6px)";
  }, 2400);
  setTimeout(() => {
    el.remove();
  }, 3e3);
}

function createModal({title: title, content: content, onConfirm: onConfirm, onCancel: onCancel}) {
  const existingModal = document.querySelector(".custom-modal-overlay");
  if (existingModal) existingModal.remove();
  const modalOverlay = document.createElement("div");
  modalOverlay.className = "custom-modal-overlay";
  const modal = document.createElement("div");
  modal.className = "custom-modal";
  modal.innerHTML = `\n    <div class="custom-modal-header">\n      <div class="custom-modal-title">${title}</div>\n      <button class="custom-modal-close" id="modalCloseBtn">&times;</button>\n    </div>\n    <div class="custom-modal-content">\n      ${content}\n    </div>\n    <div class="custom-modal-footer">\n      <button class="btn" id="modalCancelBtn">Отмена</button>\n      <button class="btn danger" id="modalConfirmBtn">Удалить</button>\n    </div>\n  `;
  modalOverlay.appendChild(modal);
  document.body.appendChild(modalOverlay);
  const closeBtn = modal.querySelector("#modalCloseBtn");
  const cancelBtn = modal.querySelector("#modalCancelBtn");
  const confirmBtn = modal.querySelector("#modalConfirmBtn");
  const closeModal = () => {
    modalOverlay.classList.add("fade-out");
    setTimeout(() => modalOverlay.remove(), 300);
  };
  closeBtn.onclick = closeModal;
  cancelBtn.onclick = closeModal;
  confirmBtn.onclick = () => {
    closeModal();
    if (typeof onConfirm === "function") onConfirm();
  };
  modalOverlay.onclick = e => {
    if (e.target === modalOverlay) {
      if (typeof onCancel === "function") onCancel();
      closeModal();
    }
  };
  setTimeout(() => modalOverlay.classList.add("show"), 10);
  return {
    close: closeModal
  };
}

function clearForm() {
  document.getElementById("steamid64").value = "";
  const nickEl = document.getElementById("nickname");
  if (nickEl) nickEl.value = "";
  document.getElementById("password").value = "";
  const roleEl = document.getElementById("role");
  if (roleEl) roleEl.value = "KP";
}

async function addUser() {
  const steamid64 = document.getElementById("steamid64").value.trim();
  const nickname = (document.getElementById("nickname")?.value || "").trim();
  const password = document.getElementById("password").value.trim();
  const role = document.getElementById("role").value;
  if (!steamid64 || !nickname || !password) {
    toast("Заполните SteamID64, ник и пароль", false);
    return;
  }
  if (nickname.length < 2) {
    toast("Ник слишком короткий", false);
    return;
  }
  if (nickname.length > 32) {
    toast("Ник слишком длинный (макс 32)", false);
    return;
  }
  if (!/^\d{17}$/.test(steamid64)) {
    toast("SteamID64 должен содержать 17 цифр", false);
    return;
  }
  if (password.length < 6) {
    toast("Пароль должен быть минимум 6 символов", false);
    return;
  }
  addBtn.disabled = true;
  addBtn.textContent = "Добавление...";
  try {
    const response = await fetch("./api/add_user", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      credentials: "include",
      body: JSON.stringify({
        steamid64: steamid64,
        nickname: nickname,
        password: password,
        role: role
      })
    });
    const data = await response.json();
    if (data.ok) {
      toast("Пользователь успешно добавлен!");
      clearForm();
      loadUsers();
    } else {
      toast(data.error || "Ошибка добавления", false);
    }
  } catch (error) {
    toast("Ошибка сети: " + error.message, false);
  } finally {
    addBtn.disabled = false;
    addBtn.textContent = "Добавить пользователя";
  }
}

document.addEventListener("click", e => {
  const del = e.target.closest(".delete-btn");
  if (del) {
    if (del.dataset.sid) deleteUser(del.dataset.sid, del.dataset.role);
    return;
  }
  const edit = e.target.closest(".edit-btn");
  if (edit) {
    if (edit.dataset.sid) openEditUser(edit.dataset.sid, edit.dataset.nick || "", edit.dataset.role || "");
    return;
  }
});

let _rolesList = null;

async function fetchRoles() {
  if (_rolesList) return _rolesList;
  try {
    const r = await fetch("./api/permissions?_=" + Date.now(), {
      cache: "no-store",
      credentials: "include"
    });
    if (r.ok) {
      const d = await r.json();
      if (d.ok && Array.isArray(d.roles)) _rolesList = d.roles;
    }
  } catch {}
  if (!_rolesList) _rolesList = [ {
    key: "KP",
    label: "KP"
  } ];
  return _rolesList;
}

async function openEditUser(steamid64, nickname, role) {
  const roles = await fetchRoles();
  const opts = roles.map(r => `<option value="${escapeHtml(r.key)}" ${r.key === role ? "selected" : ""}>${escapeHtml(r.key === "KP" ? "KP (полные права)" : r.label || r.key)}</option>`).join("");
  const ov = document.createElement("div");
  ov.className = "custom-modal-overlay edit-user-overlay";
  ov.innerHTML = `\n    <div class="custom-modal edit-user-modal">\n      <div class="custom-modal-header">\n        <div class="custom-modal-title">Редактирование пользователя</div>\n        <button class="custom-modal-close" data-x>&times;</button>\n      </div>\n      <div class="custom-modal-content">\n        <div class="euAvHero">\n          <div class="euAvWrap">\n            <img id="euAvImg" class="euAvImg" alt="аватар">\n            <button class="euAvEdit" id="euAvPick" type="button" title="Сменить аватарку">📷</button>\n          </div>\n          <input type="file" id="euAvFile" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" hidden>\n          <div class="euAvInfo">\n            <div class="euAvName">${escapeHtml(nickname || "Пользователь")}</div>\n            <div class="euAvSid mono">${escapeHtml(steamid64)}</div>\n            <div class="euAvActions">\n              <button class="btn small" id="euAvPick2" type="button">📁 Загрузить</button>\n              <button class="btn small ghost-danger" id="euAvDel" type="button">Удалить аватар</button>\n            </div>\n            <div class="euAvHint muted">Аватарка показывается в мессенджере · JPG / PNG / WEBP · до 8 МБ</div>\n          </div>\n        </div>\n        <div class="euDivider"></div>\n        <div class="euGrid">\n          <div class="editField">\n            <label class="fieldLabel">Ник</label>\n            <input class="input" id="euNick" maxlength="32" value="${escapeHtml(nickname)}" placeholder="Ник пользователя">\n          </div>\n          <div class="editField">\n            <label class="fieldLabel">Ранг</label>\n            <select class="input" id="euRole">${opts}</select>\n          </div>\n          <div class="editField euFull">\n            <label class="fieldLabel">Новый пароль <span class="muted">— оставь пустым, чтобы не менять</span></label>\n            <input class="input" id="euPass" type="password" placeholder="••••••••" autocomplete="new-password">\n          </div>\n          <div class="editField euFull">\n            <label class="fieldLabel">SteamID64</label>\n            <input class="input" value="${escapeHtml(steamid64)}" disabled>\n          </div>\n        </div>\n      </div>\n      <div class="custom-modal-footer">\n        <button class="btn" data-x>Отмена</button>\n        <button class="btn gray" id="euSave">💾 Сохранить</button>\n      </div>\n    </div>`;
  document.body.appendChild(ov);
  setTimeout(() => ov.classList.add("show"), 10);
  const close = () => {
    ov.classList.add("fade-out");
    setTimeout(() => ov.remove(), 250);
  };
  ov.querySelectorAll("[data-x]").forEach(b => b.onclick = close);
  ov.onclick = e => {
    if (e.target === ov) close();
  };
  const avImg = ov.querySelector("#euAvImg");
  const avFile = ov.querySelector("#euAvFile");
  const avPick = ov.querySelector("#euAvPick");
  const avDel = ov.querySelector("#euAvDel");
  let avPicked = null;
  const initials = window.UI && UI.initialsAvatar ? UI.initialsAvatar(nickname, steamid64) : "/img/noavatar.png";
  avImg.src = initials;
  fetch("./api/custom_avatar_of?steamid=" + encodeURIComponent(steamid64), {
    credentials: "include"
  }).then(r => r.json()).then(d => {
    if (d && d.ok && d.url) avImg.src = d.url;
  }).catch(() => {});
  avPick.onclick = () => avFile.click();
  const avPick2 = ov.querySelector("#euAvPick2");
  if (avPick2) avPick2.onclick = () => avFile.click();
  avFile.onchange = () => {
    const f = avFile.files && avFile.files[0];
    if (!f) return;
    if (!/\.(jpe?g|png|webp)$/i.test(f.name) && !/^image\/(jpe?g|png|webp)$/.test(f.type)) {
      toast("Только JPG, PNG, WEBP", false);
      avFile.value = "";
      return;
    }
    if (f.size > 8 * 1024 * 1024) {
      toast("Файл больше 8 МБ", false);
      avFile.value = "";
      return;
    }
    avPicked = f;
    avImg.src = URL.createObjectURL(f);
  };
  avDel.onclick = async () => {
    try {
      const r = await fetch("./api/custom_avatar?steamid=" + encodeURIComponent(steamid64), {
        method: "DELETE",
        credentials: "include"
      });
      const d = await r.json().catch(() => null);
      if (!r.ok || !d || !d.ok) throw new Error("err");
      avPicked = null;
      avFile.value = "";
      avImg.src = initials;
      toast("Аватарка удалена");
    } catch {
      toast("Не удалось удалить аватарку", false);
    }
  };
  ov.querySelector("#euSave").onclick = async () => {
    const nick = (ov.querySelector("#euNick").value || "").trim();
    const newRole = ov.querySelector("#euRole").value;
    const pass = ov.querySelector("#euPass").value || "";
    if (!nick || nick.length < 2) return toast("Ник слишком короткий", false);
    if (pass && pass.length < 6) return toast("Пароль минимум 6 символов", false);
    const saveBtn = ov.querySelector("#euSave");
    saveBtn.disabled = true;
    saveBtn.textContent = "Сохранение...";
    try {
      const body = {
        steamid64: steamid64,
        nickname: nick,
        role: newRole
      };
      if (pass) body.password = pass;
      const r = await fetch("./api/update_user", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });
      const d = await r.json().catch(() => null);
      if (!r.ok || !d || !d.ok) throw new Error(editErr(d && d.error) || "HTTP " + r.status);
      if (avPicked) {
        const afd = new FormData;
        afd.append("steamid", steamid64);
        afd.append("avatar", avPicked);
        const ar = await fetch("./api/custom_avatar", {
          method: "POST",
          body: afd,
          credentials: "include"
        });
        const ad = await ar.json().catch(() => null);
        if (!ar.ok || !ad || !ad.ok) toast("Данные сохранены, но аватарку загрузить не удалось", false);
      }
      toast("Изменения сохранены");
      close();
      loadUsers();
    } catch (e) {
      toast(e.message || "Ошибка", false);
      saveBtn.disabled = false;
      saveBtn.textContent = "Сохранить";
    }
  };
}

function editErr(code) {
  const m = {
    INVALID_ROLE: "Недопустимый ранг",
    NICKNAME_EMPTY: "Пустой ник",
    NICKNAME_TOO_LONG: "Ник слишком длинный",
    PASSWORD_TOO_SHORT: "Пароль слишком короткий",
    INSUFFICIENT_PRIVILEGES: "Недостаточно прав",
    CANNOT_ASSIGN_HIGHER_OR_EQUAL_ROLE: "Нельзя выдать ранг выше или равный своему",
    CANNOT_CHANGE_OWN_ROLE: "Нельзя менять свой ранг",
    USER_NOT_FOUND: "Пользователь не найден",
    NOTHING_TO_UPDATE: "Нет изменений"
  };
  return m[code] || code;
}

async function deleteUser(steamid64, role) {
  createModal({
    title: "Подтверждение удаления",
    content: `\n      <div class="delete-confirmation">\n        <div class="delete-message">\n          <p>Вы уверены что хотите удалить пользователя?</p>\n          <div class="user-info">\n            <div><strong>SteamID64:</strong> ${escapeHtml(steamid64)}</div>\n            <div><strong>Роль:</strong> <span class="role-badge ${roleSlug(role)}">${escapeHtml(role)}</span></div>\n          </div>\n          <p class="warning-text">Это действие нельзя отменить!</p>\n        </div>\n      </div>\n    `,
    onConfirm: async () => {
      try {
        const response = await fetch(`./api/delete_user?sid=${encodeURIComponent(steamid64)}`, {
          method: "DELETE",
          credentials: "include"
        });
        const data = await response.json();
        if (data.ok) {
          toast("Пользователь успешно удален!");
          loadUsers();
        } else {
          if (data.error === "CANNOT_DELETE_YOURSELF") toast("Нельзя удалить самого себя!", false); else toast(data.error || "Ошибка удаления", false);
        }
      } catch (error) {
        toast("Ошибка сети: " + error.message, false);
      }
    },
    onCancel: () => {}
  });
}

function escapeHtml(str) {
  return (str ?? "").toString().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

async function loadUsers() {
  try {
    const response = await fetch("./api/get_users", {
      credentials: "include"
    });
    const data = await response.json();
    if (data.ok && data.users) {
      let kpCount = 0;
      let otherCount = 0;
      let html = '<table class="users-table"><thead><tr><th>Ник</th><th>SteamID64</th><th>Роль</th><th>Дата добавления</th><th>Действия</th></tr></thead><tbody>';
      data.users.forEach(user => {
        const roleName = user.role_label || user.role;
        const roleClass = roleSlug(roleName);
        if ((user.role || roleName) === "KP" || roleName === "KP") kpCount++; else otherCount++;
        const date = new Date(user.added_at * 1e3);
        const dateStr = date.toLocaleDateString("ru-RU", {
          day: "2-digit",
          month: "2-digit",
          year: "numeric"
        });
        const timeStr = date.toLocaleTimeString("ru-RU", {
          hour: "2-digit",
          minute: "2-digit"
        });
        html += `<tr>\n          <td><strong>${escapeHtml(user.nickname || "—")}</strong></td>\n          <td><strong>${escapeHtml(user.steamid64)}</strong></td>\n          <td><span class="role-badge ${roleClass}">${escapeHtml(roleName)}</span></td>\n          <td class="date-cell">${dateStr} ${timeStr}</td>\n          <td class="actions-cell">\n            <button class="btn edit-btn" data-sid="${escapeHtml(user.steamid64)}" data-nick="${escapeHtml(user.nickname || "")}" data-role="${escapeHtml(user.role)}" title="Изменить пользователя">\n              <span>Изменить</span>\n            </button>\n            <button class="btn delete-btn" data-sid="${escapeHtml(user.steamid64)}" data-role="${escapeHtml(user.role)}" title="Удалить пользователя">\n              <span class="delete-text">Удалить</span>\n            </button>\n          </td>\n        </tr>`;
      });
      html += "</tbody></table>";
      usersList.innerHTML = html;
      if (totalUsers) totalUsers.textContent = data.users.length;
      if (kpUsers) kpUsers.textContent = kpCount;
      if (rootUsers) rootUsers.textContent = otherCount;
    } else {
      usersList.innerHTML = '<div class="no-users"><div class="icon">👤</div><div>Нет пользователей в системе</div></div>';
      if (totalUsers) totalUsers.textContent = "0";
      if (kpUsers) kpUsers.textContent = "0";
      if (rootUsers) rootUsers.textContent = "0";
    }
  } catch (error) {
    usersList.innerHTML = '<div class="err">Ошибка загрузки списка пользователей</div>';
    if (totalUsers) totalUsers.textContent = "0";
    if (kpUsers) kpUsers.textContent = "0";
    if (rootUsers) rootUsers.textContent = "0";
  }
}

async function loadRoles() {
  const sel = document.getElementById("role");
  if (!sel) return;
  try {
    const r = await fetch("./api/permissions?_=" + Date.now(), {
      cache: "no-store",
      credentials: "include"
    });
    if (!r.ok) return;
    const data = await r.json();
    if (!data.ok || !Array.isArray(data.roles)) return;
    const prev = sel.value;
    sel.innerHTML = "";
    for (const role of data.roles) {
      const opt = document.createElement("option");
      opt.value = role.key;
      opt.textContent = role.key === "KP" ? "KP (полные права)" : role.label || role.key;
      sel.appendChild(opt);
    }
    if (prev && [ ...sel.options ].some(o => o.value === prev)) sel.value = prev;
  } catch {}
}

const clearBtn = document.getElementById("clearBtn");

clearBtn?.addEventListener("click", clearForm);

addBtn?.addEventListener("click", addUser);

loadRoles();

loadUsers();

setInterval(loadUsers, 3e4);
