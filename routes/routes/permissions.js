import { Router } from "express";

import { requirePerm, webRolesDef, isBuiltinRole, PERMISSION_KEYS, PERMISSION_GROUPS, PERMISSION_LABELS, loadPermissions, savePermissions, addRole, updateRole, deleteRole, webNormalizeRole } from "../lib/roles.js";

import { authGuard } from "../lib/guard.js";
import { db } from "../lib/db.js";
import { logAdminAction } from "../lib/helpers.js";

function permissionsRoutes() {
  const r = Router();
  function rolesPayload() {
    return Object.entries(webRolesDef()).map(([k, def]) => ({
      key: k,
      label: String(def.label),
      level: def.level,
      builtin: !!def.builtin
    }));
  }
  r.get("/api/permissions", authGuard, requirePerm("manage_permissions"), (req, res) => {
    res.json({
      ok: true,
      roles: rolesPayload(),
      keys: PERMISSION_KEYS,
      groups: PERMISSION_GROUPS,
      labels: PERMISSION_LABELS,
      perms: loadPermissions()
    });
  });
  r.post("/api/permissions", authGuard, requirePerm("manage_permissions"), async (req, res) => {
    const data = req.body;
    if (!data?.perms || typeof data.perms !== "object") return res.status(400).json({
      ok: false,
      error: "BAD_PAYLOAD"
    });
    const ok = savePermissions(data.perms);
    if (!ok) return res.status(500).json({
      ok: false,
      error: "SAVE_FAILED"
    });
    try { await logAdminAction(db(), req.session.user?.steamid64 || "", "UPDATE_PERMISSIONS", "", JSON.stringify(data.perms).slice(0, 255)); } catch (_) {}
    res.json({
      ok: true
    });
  });
  r.post("/api/roles", authGuard, requirePerm("manage_permissions"), async (req, res) => {
    const {key: key, label: label, level: level} = req.body || {};
    const k = String(key || "").trim();
    if (String(k).length > 64 || !k || /[;\`\"\n\r\x00]/.test(k)) return res.status(400).json({ ok: false, error: "INVALID_KEY" });
    const actorRole = req.session.user?.role ? String(req.session.user.role).trim() : "";
    const actorLevel = (webRolesDef()[actorRole] && webRolesDef()[actorRole].level) || 0;
    const lvl = Number(level) || 0;
    if (lvl > actorLevel) return res.status(403).json({ ok: false, error: "LEVEL_TOO_HIGH" });
    const result = addRole({
      key: k,
      label: label,
      level: lvl
    });
    if (!result.ok) return res.status(400).json(result);
    try { await logAdminAction(db(), req.session.user?.steamid64 || "", "CREATE_ROLE", k, `level=${lvl}`); } catch (_) {}
    res.json({
      ok: true,
      roles: rolesPayload(),
      perms: loadPermissions()
    });
  });
  r.put("/api/roles", authGuard, requirePerm("manage_permissions"), async (req, res) => {
    const {key: key, label: label, level: level} = req.body || {};
    const k = String(key || "").trim();
    if (String(k).length > 64 || !k || /[;\`\"\n\r\x00]/.test(k)) return res.status(400).json({ ok: false, error: "INVALID_KEY" });
    if (isBuiltinRole(k)) return res.status(400).json({ ok: false, error: "ROLE_IS_BUILTIN" });
    const actorRole = req.session.user?.role ? String(req.session.user.role).trim() : "";
    const actorLevel = (webRolesDef()[actorRole] && webRolesDef()[actorRole].level) || 0;
    const lvl = Number(level) || 0;
    if (lvl > actorLevel) return res.status(403).json({ ok: false, error: "LEVEL_TOO_HIGH" });
    const result = updateRole(k, {
      label: label,
      level: lvl
    });
    if (!result.ok) return res.status(400).json(result);
    try { await logAdminAction(db(), req.session.user?.steamid64 || "", "UPDATE_ROLE", k, `level=${lvl}`); } catch (_) {}
    res.json({
      ok: true,
      roles: rolesPayload()
    });
  });
  r.delete("/api/roles", authGuard, requirePerm("manage_permissions"), async (req, res) => {
    const key = String(req.query.key || req.body?.key || "").trim();
    if (String(key).length > 64 || !key || /[;\`\"\n\r\x00]/.test(key)) return res.status(400).json({ ok: false, error: "INVALID_KEY" });
    if (isBuiltinRole(key)) return res.status(400).json({
      ok: false,
      error: "ROLE_IS_BUILTIN"
    });
    if (webNormalizeRole(req.session.user?.role) === key) {
      return res.status(400).json({
        ok: false,
        error: "CANNOT_DELETE_OWN_ROLE"
      });
    }
    const result = deleteRole(key);
    if (!result.ok) return res.status(400).json(result);
    try { await logAdminAction(db(), req.session.user?.steamid64 || "", "DELETE_ROLE", key, ""); } catch (_) {}
    res.json({
      ok: true,
      roles: rolesPayload(),
      perms: loadPermissions()
    });
  });
  return r;
}

export { permissionsRoutes as default };
