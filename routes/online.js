import { Router } from "express";

import { timingSafeEqual } from "crypto";

import { writeOnlineMap, flushOnlineToDisk } from "../lib/helpers.js";

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

function onlineRoutes(cfg) {
  const r = Router();
  let flushTimer = null;
  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      try {
        flushOnlineToDisk();
      } catch (e) {
        console.error("online flush error:", e.message);
      }
    }, 2e3);
    if (typeof flushTimer.unref === "function") flushTimer.unref();
  }
  function requirePassword(req) {
    const pass = String(req.body?.password || req.headers["x-api-password"] || (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim() || "").trim();
    return cfg.WEB_SECRET && safeCompare(pass, cfg.WEB_SECRET);
  }
  r.post("/api/online", (req, res) => {
    if (!requirePassword(req)) return res.status(403).json({
      ok: false,
      error: "BAD_PASSWORD"
    });
    let payload = req.body;
    if (payload?.data) {
      const inner = payload.data;
      if (typeof inner === "string") {
        try {
          payload = inner.trim() ? JSON.parse(inner) : [];
        } catch (e) {
          return res.status(400).json({
            ok: false,
            error: "BAD_JSON"
          });
        }
      } else if (Array.isArray(inner) || typeof inner === "object" && inner !== null) {
        payload = inner;
      }
    } else if (payload?.players && Array.isArray(payload.players)) {
      payload = payload.players;
    }
    if (!payload || typeof payload !== "object") {
      return res.status(400).json({
        ok: false,
        error: "BAD_JSON"
      });
    }
    writeOnlineMap(payload);
    scheduleFlush();
    res.json({
      ok: true,
      count: Array.isArray(payload) ? payload.length : Object.keys(payload).length
    });
  });
  return r;
}

export { onlineRoutes as default };
