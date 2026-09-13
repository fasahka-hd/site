import { Router } from "express";

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "fs";

import { join, dirname } from "path";

import { fileURLToPath } from "url";

import { randomUUID } from "crypto";

import { authGuard } from "../lib/guard.js";

import { requirePerm } from "../lib/roles.js";

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data");

const FILE = join(DATA_DIR, "zbt_access.json");

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, {
    recursive: true
  });
}

function readRows() {
  ensureDir();
  if (!existsSync(FILE)) return [];
  try {
    const data = JSON.parse(readFileSync(FILE, "utf8") || "[]");
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function cleanRow(row, index = 0) {
  const id = String(row?.id || "").trim() || randomUUID();
  const nickname = String(row?.nickname || "").trim().slice(0, 64);
  const steamid = String(row?.steamid || "").trim().slice(0, 64);
  const discord = String(row?.discord || "").trim().slice(0, 80);
  let steam_url = String(row?.steam_url || "").trim().slice(0, 300);
  if (steam_url && !/^https?:\/\//i.test(steam_url)) steam_url = "";
  const access = row?.access === true || row?.access === "yes" || row?.access === "1";
  return {
    id: id,
    nickname: nickname,
    steamid: steamid,
    discord: discord,
    steam_url: steam_url,
    access: access,
    order: index
  };
}

function hasContent(row) {
  return !!(row.nickname || row.steamid || row.discord || row.steam_url || row.access);
}

function writeRows(rows) {
  ensureDir();
  const cleaned = rows.map(cleanRow).filter(hasContent).slice(0, 500);
  const tmp = FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(cleaned, null, 2), "utf8");
  renameSync(tmp, FILE);
  return cleaned;
}

function zbtAccessRoutes() {
  const r = Router();
  r.get("/api/zbt_access", authGuard, requirePerm("manage_zbt_access"), (_req, res) => {
    res.json({
      ok: true,
      rows: readRows()
    });
  });
  r.put("/api/zbt_access", authGuard, requirePerm("manage_zbt_access"), (req, res) => {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    res.json({
      ok: true,
      rows: writeRows(rows)
    });
  });
  r.post("/api/zbt_access", authGuard, requirePerm("manage_zbt_access"), (req, res) => {
    const rows = readRows();
    const row = cleanRow(req.body || {}, rows.length);
    const idx = rows.findIndex(x => String(x.id) === String(row.id));
    if (idx >= 0) rows[idx] = row; else rows.push(row);
    res.json({
      ok: true,
      row: row,
      rows: writeRows(rows)
    });
  });
  r.delete("/api/zbt_access/:id", authGuard, requirePerm("manage_zbt_access"), (req, res) => {
    const id = String(req.params.id || "").trim();
    const rows = readRows().filter(row => String(row.id) !== id);
    res.json({
      ok: true,
      rows: writeRows(rows)
    });
  });
  return r;
}

export { zbtAccessRoutes as default };
