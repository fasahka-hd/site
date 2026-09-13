import { Router } from "express";

import bcrypt from "bcryptjs";

import { db } from "../lib/db.js";

import { webNormalizeRole, webRoleLabel, getUserRole, loadPermissions, PERMISSION_KEYS, hasPerm } from "../lib/roles.js";

import { steamGetPersonaname } from "../lib/helpers.js";

const BCRYPT_COST = 12;

const MAX_PASSWORD_LENGTH = 200;

const FAILED_LOGIN_WINDOW = 60 * 1e3;

const FAILED_LOGIN_MAX = 5;

async function checkFailedLoginLimit(ip) {
  try {
    const now = Date.now();
    const [rows] = await db().query("SELECT attempts, window_start FROM web_login_attempts WHERE ip = ? LIMIT 1", [ String(ip) ]);
    const row = rows[0];
    if (!row) return true;
    if (now - Number(row.window_start) > FAILED_LOGIN_WINDOW) return true;
    return Number(row.attempts) < FAILED_LOGIN_MAX;
  } catch (e) {
    console.error("[AUTH] failed login check error:", e.message);
    return true;
  }
}

async function incrementFailedLogin(ip) {
  try {
    const now = Date.now();
    await db().query(`INSERT INTO web_login_attempts (ip, attempts, window_start) VALUES (?, 1, ?) ON DUPLICATE KEY UPDATE attempts = IF(? - window_start > ?, 1, attempts + 1), window_start = IF(? - window_start > ?, ?, window_start)`, [ String(ip), now, now, FAILED_LOGIN_WINDOW, now, FAILED_LOGIN_WINDOW, now ]);
  } catch (e) {
    console.error("[AUTH] failed login increment error:", e.message);
  }
}

async function clearFailedLogin(ip) {
  try {
    await db().query("DELETE FROM web_login_attempts WHERE ip = ?", [ String(ip) ]);
  } catch (e) {
    console.error("[AUTH] clear failed login error:", e.message);
  }
}

const DUMMY_HASH = bcrypt.hashSync("dummy_constant", BCRYPT_COST);

function dummyBcrypt() {
  return bcrypt.compareSync("x", DUMMY_HASH);
}

function authRoutes(cfg, loginLimiter, steamCallbackLimiter) {
  const r = Router();
  r.post("/api/login", loginLimiter, async (req, res) => {
    const {steamid64: steamid64, password: password} = req.body || {};
    if (!steamid64 || !password) return res.status(400).json({
      ok: false,
      error: "EMPTY_FIELDS"
    });
    const passwordStr = String(password).trim();
    if (passwordStr.length > MAX_PASSWORD_LENGTH) return res.status(400).json({
      ok: false,
      error: "BAD_LOGIN"
    });
    const steamidStr = String(steamid64).trim();
    if (!/^\d{17}$/.test(steamidStr)) return res.status(400).json({
      ok: false,
      error: "BAD_LOGIN"
    });
    const clientIp = req.ip || req.connection?.remoteAddress || "unknown";
    if (!await checkFailedLoginLimit(clientIp)) {
      return res.status(429).json({
        ok: false,
        error: "TOO_MANY_REQUESTS"
      });
    }
    try {
      const [rows] = await db().query("SELECT id, steamid64, role, password_hash, COALESCE(nickname,'') AS nickname FROM web_users WHERE steamid64 = ? LIMIT 1", [ steamidStr ]);
      const user = rows[0];
      if (!user) {
        await incrementFailedLogin(clientIp);
        dummyBcrypt();
        return res.status(401).json({
          ok: false,
          error: "BAD_LOGIN"
        });
      }
      const valid = await bcrypt.compare(passwordStr, user.password_hash);
      if (!valid) {
        await incrementFailedLogin(clientIp);
        return res.status(401).json({
          ok: false,
          error: "BAD_LOGIN"
        });
      }
      await clearFailedLogin(clientIp);
      let nickname = String(user.nickname || "").trim();
      if (!nickname) {
        const pn = await steamGetPersonaname(cfg.STEAM_API_KEY, user.steamid64);
        if (pn) {
          nickname = pn;
          await db().query("UPDATE web_users SET nickname = ? WHERE steamid64 = ? LIMIT 1", [ nickname, user.steamid64 ]).catch(() => {});
        }
      }
      req.session.regenerate(err => {
        if (err) return res.status(500).json({
          ok: false,
          error: "SESSION_ERROR"
        });
        req.session.user = {
          id: user.id,
          steamid64: user.steamid64,
          role: webNormalizeRole(user.role),
          nickname: nickname,
          auth: "password",
          time: Math.floor(Date.now() / 1e3)
        };
        res.json({
          ok: true
        });
      });
    } catch (e) {
      console.error("login error:", e.message);
      return res.status(500).json({
        ok: false,
        error: "INTERNAL_ERROR"
      });
    }
  });
  r.get("/api/steam_login", (req, res) => {
    const baseUrl = cfg.BASE_URL || `${req.protocol}://${req.get("host")}`;
    const realm = baseUrl + "/";
    const returnTo = baseUrl + "/api/steam_callback";
    const params = new URLSearchParams({
      "openid.ns": "http://specs.openid.net/auth/2.0",
      "openid.mode": "checkid_setup",
      "openid.return_to": returnTo,
      "openid.realm": realm,
      "openid.identity": "http://specs.openid.net/auth/2.0/identifier_select",
      "openid.claimed_id": "http://specs.openid.net/auth/2.0/identifier_select"
    });
    res.redirect("https://steamcommunity.com/openid/login?" + params.toString());
  });
  r.get("/api/steam_callback", steamCallbackLimiter, async (req, res) => {
    const fail = msg => res.redirect("/login.html?e=" + encodeURIComponent(msg));
    const mode = req.query["openid.mode"] || req.query.openid_mode || "";
    if (mode !== "id_res") return fail("STEAM_AUTH_CANCEL");
    const claimed = req.query["openid.claimed_id"] || req.query.openid_claimed_id || "";
    const m = claimed.match(/https?:\/\/steamcommunity\.com\/openid\/id\/(\d{17})/);
    if (!m) return fail("STEAM_BAD_ID");
    const steamid64 = m[1];
    const check = {
      ...req.query
    };
    check["openid.mode"] = "check_authentication";
    try {
      const r2 = await fetch("https://steamcommunity.com/openid/login", {
        method: "POST",
        body: new URLSearchParams(check),
        signal: AbortSignal.timeout(8e3)
      });
      if (!r2.ok) return fail("STEAM_VERIFY_FAIL");
      const text = await r2.text();
      if (!text.includes("is_valid:true")) return fail("STEAM_INVALID");
    } catch {
      return fail("STEAM_VERIFY_FAIL");
    }
    try {
      const [rows] = await db().query("SELECT id, role, COALESCE(nickname,'') AS nickname FROM web_users WHERE steamid64 = ? LIMIT 1", [ steamid64 ]);
      if (!rows.length) return fail("NOT_ALLOWED");
      const {id: id, role: role, nickname: rawNick} = rows[0];
      let nickname = String(rawNick || "").trim();
      if (!nickname) {
        const pn = await steamGetPersonaname(cfg.STEAM_API_KEY, steamid64);
        if (pn) {
          nickname = pn;
          await db().query("UPDATE web_users SET nickname = ? WHERE steamid64 = ? LIMIT 1", [ nickname, steamid64 ]).catch(() => {});
        }
      }
      req.session.regenerate(err => {
        if (err) return fail("SESSION_ERROR");
        req.session.user = {
          id: id,
          steamid64: steamid64,
          role: webNormalizeRole(role),
          nickname: nickname,
          auth: "steam",
          time: Math.floor(Date.now() / 1e3)
        };
        res.redirect("/");
      });
    } catch (e) {
      console.error("steam_callback db error:", e.message);
      return fail("INTERNAL_ERROR");
    }
  });
  r.post("/api/logout", (req, res) => {
    req.session.destroy(() => {
      res.clearCookie("connect.sid");
      res.json({
        ok: true
      });
    });
  });
  r.get("/api/me", async (req, res) => {
    if (!req.session?.user) return res.status(401).json({
      ok: false,
      error: "UNAUTHORIZED"
    });
    const u = req.session.user;
    let rows = [];
    let dbError = false;
    try {
      const [r2] = await db().query("SELECT role, COALESCE(nickname,'') AS nickname FROM web_users WHERE steamid64 = ? LIMIT 1", [ u.steamid64 ]);
      rows = r2;
    } catch (e) {
      console.error("/api/me db error:", e.message);
      dbError = true;
    }
    if (!dbError && !rows.length) {
      req.session.destroy(() => {});
      return res.status(401).json({
        ok: false,
        error: "UNAUTHORIZED"
      });
    }
    if (!dbError && rows.length) {
      const freshRole = webNormalizeRole(rows[0].role);
      if (freshRole !== u.role) req.session.user.role = freshRole;
      const freshNick = String(rows[0].nickname || "").trim();
      if (freshNick && freshNick !== u.nickname) req.session.user.nickname = freshNick;
    }
    const freshUser = req.session.user;
    const role = freshUser.role;
    const allPerms = loadPermissions();
    const perms = {};
    for (const k of PERMISSION_KEYS) {
      perms[k] = role === "KP" ? true : Boolean(allPerms[role]?.[k]);
    }
    res.json({
      ok: true,
      user: {
        id: freshUser.id,
        steamid64: freshUser.steamid64,
        role: freshUser.role,
        nickname: freshUser.nickname || "",
        role_label: webRoleLabel(freshUser.role),
        auth: freshUser.auth || "unknown"
      },
      perms: perms
    });
  });
  return r;
}

export { authRoutes as default };
