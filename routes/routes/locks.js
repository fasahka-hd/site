import { Router } from "express";

import { authGuard } from "../lib/guard.js";

import { loadLocks, saveLocks, publicLocksSnapshot, LOCKABLE_PAGES } from "../lib/locks.js";

import { PERMISSION_KEYS, PERMISSION_GROUPS, PERMISSION_LABELS } from "../lib/roles.js";

function requireKP(req, res, next) {
  if (!req.session?.user) {
    return res.status(401).json({
      ok: false,
      error: "UNAUTHORIZED"
    });
  }
  if (req.session.user.role !== "KP") {
    return res.status(403).json({
      ok: false,
      error: "KP_ONLY"
    });
  }
  next();
}

function locksRoutes() {
  const r = Router();
  r.get("/api/locks", authGuard, (req, res) => {
    const snap = publicLocksSnapshot(req.session.user);
    res.json({
      ...snap,
      keys: PERMISSION_KEYS,
      groups: PERMISSION_GROUPS,
      labels: PERMISSION_LABELS,
      pages: LOCKABLE_PAGES,
      pages_state: snap.pages
    });
  });
  r.get("/api/locks/state", authGuard, (req, res) => {
    res.json(publicLocksSnapshot(req.session.user));
  });
  r.post("/api/locks", authGuard, requireKP, (req, res) => {
    const body = req.body || {};
    const current = loadLocks();
    const writePermMap = (src, key) => {
      current[key] = {};
      const source = src && typeof src === "object" ? src : {};
      for (const k of PERMISSION_KEYS) current[key][k] = !!source[k];
    };
    const writePageMap = (src, key) => {
      current[key] = {};
      const source = src && typeof src === "object" ? src : {};
      for (const p of LOCKABLE_PAGES) current[key][p.key] = !!source[p.key];
    };
    if (body.permissions_others || body.permissions_self || body.pages_others || body.pages_self) {
      writePermMap(body.permissions_others, "permissions_others");
      writePermMap(body.permissions_self, "permissions_self");
      writePageMap(body.pages_others, "pages_others");
      writePageMap(body.pages_self, "pages_self");
    } else {
      const mode = body.mode === "all" ? "all" : "others";
      writePermMap(body.permissions, "permissions_others");
      writePageMap(body.pages, "pages_others");
      writePermMap(mode === "all" ? body.permissions : {}, "permissions_self");
      writePageMap(mode === "all" ? body.pages : {}, "pages_self");
    }
    if (typeof body.note === "string") {
      current.note = String(body.note).slice(0, 200);
    }
    current.updated_at = Math.floor(Date.now() / 1e3);
    current.updated_by = req.session.user?.nickname || req.session.user?.steamid64 || "KP";
    const ok = saveLocks(current);
    if (!ok) return res.status(500).json({
      ok: false,
      error: "SAVE_FAILED"
    });
    const snap = publicLocksSnapshot(req.session.user);
    res.json({
      ok: true,
      locks: Object.assign({}, snap, {
        pages: LOCKABLE_PAGES,
        pages_state: snap.pages
      })
    });
  });
  r.post("/api/locks/clear", authGuard, requireKP, (req, res) => {
    const current = loadLocks();
    current.permissions_others = {};
    current.permissions_self = {};
    current.pages_others = {};
    current.pages_self = {};
    current.updated_at = Math.floor(Date.now() / 1e3);
    current.updated_by = req.session.user?.nickname || req.session.user?.steamid64 || "KP";
    const ok = saveLocks(current);
    if (!ok) return res.status(500).json({
      ok: false,
      error: "SAVE_FAILED"
    });
    const snap = publicLocksSnapshot(req.session.user);
    res.json({
      ok: true,
      locks: Object.assign({}, snap, {
        pages: LOCKABLE_PAGES,
        pages_state: snap.pages
      })
    });
  });
  return r;
}

export { locksRoutes as default };
