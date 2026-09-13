import { Router } from "express";

import { timingSafeEqual } from "crypto";

import { authGuard } from "../lib/guard.js";

import { requirePerm } from "../lib/roles.js";

let lastRestartState = {
  seconds: 0,
  reason: "",
  restarting: false,
  updated: 0,
  nextDaily: 0
};

function safeCompare(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    const tmp = Buffer.alloc(bufA.length);
    timingSafeEqual(bufA, tmp);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function restartRoutes(cfg) {
  const r = Router();
  function requirePassword(req, res) {
    const pass = String(req.body?.password || req.query?.password || req.headers["x-api-password"] || (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim() || "").trim();
    if (!cfg.WEB_SECRET || !safeCompare(pass, cfg.WEB_SECRET)) {
      res.status(403).json({
        ok: false,
        error: "BAD_PASSWORD"
      });
      return false;
    }
    return true;
  }
  r.post("/api/restart_state", async (req, res) => {
    if (!requirePassword(req, res)) return;
    const body = req.body || {};
    lastRestartState = {
      seconds: Math.max(0, parseInt(body.seconds || 0, 10) || 0),
      reason: String(body.reason || ""),
      restarting: !!body.restarting,
      updated: Math.floor(Date.now() / 1e3),
      nextDaily: parseInt(body.nextDaily || 0, 10) || 0
    };
    res.json({
      ok: true
    });
  });
  r.get("/api/restart_state", authGuard, (req, res) => {
    const MOSCOW_OFFSET = 3 * 3600;
    const now = Math.floor(Date.now() / 1e3);
    const moscow = now + MOSCOW_OFFSET;
    const secondsToday = moscow % 86400;
    let nextDailySec = 6 * 3600;
    if (secondsToday >= nextDailySec) {
      nextDailySec += 86400;
    }
    const dailyLeft = nextDailySec - secondsToday;
    res.json({
      ok: true,
      seconds: lastRestartState.seconds || 0,
      reason: lastRestartState.reason || "",
      restarting: !!lastRestartState.restarting,
      updated: lastRestartState.updated || now,
      nextDaily: lastRestartState.nextDaily > 0 ? lastRestartState.nextDaily : Math.max(0, dailyLeft)
    });
  });
  r.post("/api/restart/schedule", authGuard, requirePerm("raw_console"), async (req, res) => {
    const minutes = parseInt(req.body.minutes || 0, 10);
    let reason = String(req.body.reason || "").trim();
    if (!minutes || minutes < 1 || minutes > 1440) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_MINUTES"
      });
    }
    if (!reason) reason = "Плановый рестарт";
    const encoded = Buffer.from(reason, "utf8").toString("base64");
    const cmdText = `ar_restart_reason_b64 ${minutes} ${encoded}`;
    try {
      const now = Math.floor(Date.now() / 1e3);
      const cmdId = "cmd_" + now + "_" + Math.floor(1e3 + Math.random() * 9e3);
      const {readQueueFile: readQueueFile, writeQueueFile: writeQueueFile} = await import("../lib/helpers.js");
      const data = readQueueFile();
      data.push({
        id: cmdId,
        type: "console",
        text: cmdText,
        admin_steamid64: String(req.session?.user?.steamid64 || ""),
        done: false,
        processing: false,
        time: now
      });
      writeQueueFile(data);
      try {
        const {db: db} = await import("../lib/db.js");
        await db().query("INSERT INTO admin_logs (admin_steamid64, action, target, details, timestamp) VALUES (?, ?, ?, ?, ?)", [ String(req.session?.user?.steamid64 || ""), "restart", "", `Restart scheduled: ${minutes} min, reason: ${reason}`, now ]);
      } catch (e) { console.error("catch error:", e && e.message ? e.message : e); }
      res.json({
        ok: true,
        id: cmdId,
        minutes: minutes,
        reason: reason
      });
    } catch (e) {
      console.error("restart schedule error:", e.message);
      res.status(500).json({
        ok: false,
        error: "INTERNAL"
      });
    }
  });
  r.post("/api/restart/cancel", authGuard, requirePerm("raw_console"), async (req, res) => {
    try {
      const now = Math.floor(Date.now() / 1e3);
      const cmdId = "cmd_" + now + "_" + Math.floor(1e3 + Math.random() * 9e3);
      const {readQueueFile: readQueueFile, writeQueueFile: writeQueueFile} = await import("../lib/helpers.js");
      const data = readQueueFile();
      data.push({
        id: cmdId,
        type: "console",
        text: "ar_restart_cancel",
        admin_steamid64: String(req.session?.user?.steamid64 || ""),
        done: false,
        processing: false,
        time: now
      });
      writeQueueFile(data);
      try {
        const {db: db} = await import("../lib/db.js");
        await db().query("INSERT INTO admin_logs (admin_steamid64, action, target, details, timestamp) VALUES (?, ?, ?, ?, ?)", [ String(req.session?.user?.steamid64 || ""), "restart_cancel", "", "Restart cancelled", now ]);
      } catch (e) { console.error("catch error:", e && e.message ? e.message : e); }
      res.json({
        ok: true
      });
    } catch (e) {
      console.error("restart cancel error:", e.message);
      res.status(500).json({
        ok: false,
        error: "INTERNAL"
      });
    }
  });
  return r;
}

export { restartRoutes as default, lastRestartState };
