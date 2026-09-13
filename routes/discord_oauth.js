import { Router } from "express";

import crypto from "crypto";

import { db } from "../lib/db.js";

import { steamid64ToSteamid } from "../lib/helpers.js";

const DISCORD_VERIFIED_ROLE_ID = "1522314766490533979";

const DISCORD_RANK_ROLE_IDS = {
  "d-moderator": [ "1508578795932876820", "1508578733995327658" ],
  "d-admin": [ "1508578837682983092", "1508578733995327658" ],
  "superadmin": [ "1508578913759002767", "1508578733995327658" ],
  "manager": ["1265404218689327219", "1512070090265460898", "1512069798450827274", "1512068748121739324", "1512070569154052167"],
  "vice-manager": ["1512068748121739324", "1512069798450827274", "1512070090265460898", "1265403682565001308", "1512070569154052167"],
  "owner": [ "1508578969857818684", "1508578733995327658" ],
  "head-admin": [ "1512068748121739324", "1512069798450827274", "1508579802188218368" ],
  "curator": [ "1512068748121739324", "1512069798450827274", "1508579870257446912" ],
  "inter": [ "1508579495010107543", "1512068748121739324" ],
  "helper": [ "1508579549598716115", "1512068748121739324" ],
  "moderator": [ "1508579591621574686", "1512068748121739324" ],
  "admin": [ "1508579623766855961", "1512068748121739324" ],
  "head-curator": [ "1508579917628047390", "1512069798450827274", "1512068748121739324" ]
};

const BA_RANK_ID_TO_NAME = {
  1: "user",
  2: "vip",
  3: "d-moderator",
  4: "d-admin",
  5: "superadmin",
  6: "owner",
  7: "inter",
  8: "helper",
  9: "moderator",
  10: "admin",
  11: "head-admin",
  12: "curator",
  13: "head-curator",
  14: "vice-manager",
  15: "manager",
  16: "project-team",
  17: "arizona-team",
  18: "zamuprav",
  19: "uprav",
  20: "co*",
  21: "*"
};

function normalizePlayerRank(rank) {
  const raw = String(rank ?? "").trim();
  if (!raw) return "";
  if (/^\d+$/.test(raw)) return BA_RANK_ID_TO_NAME[parseInt(raw, 10)] || "";
  const lower = raw.toLowerCase();
  if (lower === "headcurator" || lower === "head_curator" || lower === "head curator") return "head-curator";
  if (lower === "headadmin" || lower === "head_admin" || lower === "head admin") return "head-admin";
  if (lower === "dmoderator" || lower === "d_moderator" || lower === "d moderator") return "d-moderator";
  if (lower === "dadmin" || lower === "d_admin" || lower === "d admin") return "d-admin";
  if (lower === "vicemanager" || lower === "vice_manager" || lower === "vice manager") return "vice-manager";
  return lower;
}

function normalizeSteamId64(value) {
  const sid = String(value || "").trim();
  return /^\d{17}$/.test(sid) ? sid : "";
}

function normalizeDiscordId(value) {
  const did = String(value || "").trim();
  return /^\d{5,32}$/.test(did) ? did : "";
}

function toUnixSeconds(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : 0;
}

function dbBool(value) {
  return value === true || value === 1 || value === "1" || value === "true";
}

async function baPreferredSvId(pool) {
  try {
    const [rows] = await pool.query("SELECT sv_id, COUNT(*) AS c FROM ba_ranks WHERE sv_id != 'ROOT_ID' AND sv_id != 'ROOT' GROUP BY sv_id ORDER BY c DESC LIMIT 1");
    if (rows[0]?.sv_id) return rows[0].sv_id;
    const [allRows] = await pool.query("SELECT sv_id, COUNT(*) AS c FROM ba_ranks GROUP BY sv_id ORDER BY c DESC LIMIT 1");
    return allRows[0]?.sv_id || "NOT_SET";
  } catch {
    return "NOT_SET";
  }
}

async function getPlayerRankForDiscord(pool, steamId64) {
  const sid64 = String(steamId64 || "").trim();
  const sid32 = steamid64ToSteamid(sid64);
  const svId = await baPreferredSvId(pool);
  try {
    const ids = [ sid64, sid32 ].filter(Boolean);
    if (ids.length) {
      const placeholders = ids.map(() => "?").join(",");
      const [rows] = await pool.query(`\n        SELECT rank FROM ba_ranks\n        WHERE CAST(steamid AS CHAR) IN (${placeholders})\n        ORDER BY CASE WHEN sv_id = ? THEN 0 WHEN sv_id != 'ROOT_ID' AND sv_id != 'ROOT' THEN 1 ELSE 2 END ASC, expire_time DESC\n        LIMIT 1\n      `, [ ...ids, svId ]);
      const rank = normalizePlayerRank(rows[0]?.rank);
      if (rank) return rank;
    }
  } catch (e) {
    console.error("[DISCORD ROLES] ba_ranks direct lookup failed:", e.message);
  }
  try {
    const [rows] = await pool.query(`\n      SELECT\n        (SELECT r.rank FROM ba_ranks r WHERE r.steamid = u.steamid\n          ORDER BY CASE WHEN r.sv_id = ? THEN 0 WHEN r.sv_id != 'ROOT_ID' AND r.sv_id != 'ROOT' THEN 1 ELSE 2 END ASC, r.expire_time DESC LIMIT 1) AS rank_id\n      FROM ba_users u\n      WHERE CAST(u.steamid AS CHAR) = ? OR CAST(u.steamid AS CHAR) = ?\n      LIMIT 1\n    `, [ svId, sid64, sid32 ]);
    const rank = normalizePlayerRank(rows[0]?.rank_id);
    if (rank) return rank;
  } catch (e) {
    console.error("[DISCORD ROLES] ba_users rank lookup failed:", e.message);
  }
  return "";
}

async function resolveDiscordGuildId(cfg, botToken) {
  const explicitGuildId = String(cfg.DISCORD_GUILD_ID || process.env.DISCORD_GUILD_ID || process.env.GUILD_ID || "").trim();
  if (explicitGuildId) return explicitGuildId;
  const logChannelId = String(cfg.DISCORD_LINK_LOG_CHANNEL_ID || "").trim();
  if (!botToken || !logChannelId) return "";
  try {
    const channelRes = await fetch(`https://discord.com/api/v10/channels/${logChannelId}`, {
      headers: {
        Authorization: `Bot ${botToken}`
      },
      signal: AbortSignal.timeout(1e4)
    });
    if (!channelRes.ok) return "";
    const channelData = await channelRes.json().catch(() => null);
    return String(channelData?.guild_id || "").trim();
  } catch (e) {
    console.error("[DISCORD ROLES] Failed to resolve guild id:", e.message);
    return "";
  }
}

async function discordApi(method, path, botToken, body) {
  const hasBody = body !== undefined;
  const res = await fetch(`https://discord.com/api/v10${path}`, {
    method: method,
    headers: {
      Authorization: `Bot ${botToken}`,
      ...hasBody ? {
        "Content-Type": "application/json"
      } : {}
    },
    ...hasBody ? {
      body: JSON.stringify(body)
    } : {},
    signal: AbortSignal.timeout(1e4)
  });
  if (res.ok) {
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    return {
      ok: true,
      status: res.status,
      data: data
    };
  }
  const text = await res.text().catch(() => "");
  return {
    ok: false,
    status: res.status,
    text: text
  };
}

async function sendDiscordLogMessage(cfg, embed) {
  try {
    const logChannelId = String(cfg.DISCORD_LINK_LOG_CHANNEL_ID || "1522262339464986715").trim();
    const botToken = String(cfg.DISCORD_BOT_TOKEN || "").trim();
    if (!botToken || !logChannelId) return;
    const res = await discordApi("POST", `/channels/${logChannelId}/messages`, botToken, {
      embeds: [ embed ]
    });
    if (!res.ok) {
      console.error("[DISCORD LOG] Failed to send log message:", res.status, res.text);
    }
  } catch (err) {
    console.error("[DISCORD LOG] Error sending log embed:", err.message);
  }
}

async function assignDiscordVerificationRoles(cfg, steamId64, discordId, isNewLink = false) {
  const botToken = String(cfg.DISCORD_BOT_TOKEN || "").trim();
  if (!botToken || !discordId) {
    console.error("[DISCORD ROLES] DISCORD_BOT_TOKEN or discordId is missing — roles were not issued.");
    return {
      ok: false,
      reason: "NO_BOT_TOKEN_OR_ID",
      playerRank: "",
      issuedRoleIds: []
    };
  }
  const guildId = await resolveDiscordGuildId(cfg, botToken);
  if (!guildId) {
    console.error("[DISCORD ROLES] DISCORD_GUILD_ID is missing and could not be resolved — roles were not issued.");
    return {
      ok: false,
      reason: "NO_GUILD_ID",
      playerRank: "",
      issuedRoleIds: []
    };
  }
  const playerRank = await getPlayerRankForDiscord(db(), steamId64);
  const rankRolesRaw = DISCORD_RANK_ROLE_IDS[playerRank];
  const rankRoleIds = Array.isArray(rankRolesRaw) ? rankRolesRaw : rankRolesRaw ? [ rankRolesRaw ] : [];
  const targetRoleIds = new Set([ DISCORD_VERIFIED_ROLE_ID, ...rankRoleIds ].filter(Boolean));
  const allRankRoleIds = Object.values(DISCORD_RANK_ROLE_IDS).flatMap(v => Array.isArray(v) ? v : [ v ]);
  const allPossibleRankRoleIds = new Set(allRankRoleIds.filter(Boolean));
  const getRes = await discordApi("GET", `/guilds/${guildId}/members/${discordId}`, botToken);
  if (getRes.status === 404) {
    return {
      ok: false,
      reason: "NOT_IN_GUILD",
      guildId: guildId,
      playerRank: playerRank,
      issuedRoleIds: []
    };
  }
  if (!getRes.ok || !getRes.data || !Array.isArray(getRes.data.roles)) {
    console.error(`[DISCORD ROLES] Failed to fetch member roles for ${discordId}:`, getRes.status, getRes.text || "NO_ROLES_DATA");
    return {
      ok: false,
      reason: "MEMBER_FETCH_FAILED",
      guildId: guildId,
      playerRank: playerRank,
      issuedRoleIds: [],
      removedRoleIds: [],
      failed: [ {
        action: "GET_MEMBER",
        status: getRes.status,
        text: getRes.text || "NO_ROLES_DATA"
      } ]
    };
  }
  const currentMemberRoles = new Set(getRes.data.roles.map(String));
  const issuedRoleIds = [];
  const removedRoleIds = [];
  const failed = [];
  for (const roleId of targetRoleIds) {
    if (currentMemberRoles && currentMemberRoles.has(roleId)) {
      continue;
    }
    const result = await discordApi("PUT", `/guilds/${guildId}/members/${discordId}/roles/${roleId}`, botToken);
    if (result.ok) {
      if (currentMemberRoles) currentMemberRoles.add(roleId);
      issuedRoleIds.push(roleId);
    } else {
      failed.push({
        roleId: roleId,
        action: "PUT",
        status: result.status,
        text: result.text
      });
      console.error(`[DISCORD ROLES] Failed to issue role ${roleId} to ${discordId}:`, result.status, result.text);
    }
  }
  for (const roleId of allPossibleRankRoleIds) {
    if (roleId === DISCORD_VERIFIED_ROLE_ID) continue;
    if (targetRoleIds.has(roleId)) continue;
    if (currentMemberRoles && !currentMemberRoles.has(roleId)) continue;
    const result = await discordApi("DELETE", `/guilds/${guildId}/members/${discordId}/roles/${roleId}`, botToken);
    if (result.ok || result.status === 404) {
      if (currentMemberRoles) currentMemberRoles.delete(roleId);
      if (result.ok && result.status !== 404) removedRoleIds.push(roleId);
    } else {
      failed.push({
        roleId: roleId,
        action: "DELETE",
        status: result.status,
        text: result.text
      });
      console.error(`[DISCORD ROLES] Failed to remove role ${roleId} from ${discordId}:`, result.status, result.text);
    }
  }
  const ok = failed.length === 0;
  const nowSec = Math.floor(Date.now() / 1e3);
  await db().query("UPDATE donate_discord_users SET role_synced = ?, last_rank = ?, last_sync_time = ? WHERE steamid64 = ? LIMIT 1", [ ok ? 1 : 0, String(playerRank || ""), nowSec, String(steamId64) ]).catch(() => {});
  if (issuedRoleIds.length || removedRoleIds.length || failed.length) {
    console.log(`[DISCORD ROLES] Updated roles for ${steamId64} (@${discordId}). Rank: "${playerRank || "none"}". Added: [${issuedRoleIds.join(",")}], Removed: [${removedRoleIds.join(",")}], Failed: ${failed.length}`);
    if (!isNewLink && (issuedRoleIds.length > 0 || removedRoleIds.length > 0)) {
      const addedText = issuedRoleIds.length ? issuedRoleIds.map(id => `<@&${id}>`).join(", ") : "—";
      const removedText = removedRoleIds.length ? removedRoleIds.map(id => `<@&${id}>`).join(", ") : "—";
      await sendDiscordLogMessage(cfg, {
        title: "🔄 Обновление ролей и ранга",
        color: 16705372,
        fields: [ {
          name: "Steam ID64",
          value: String(steamId64),
          inline: true
        }, {
          name: "Discord",
          value: `<@${discordId}>`,
          inline: true
        }, {
          name: "Актуальный ранг",
          value: playerRank || "—",
          inline: true
        }, {
          name: "➕ Выданы роли",
          value: addedText,
          inline: false
        }, {
          name: "➖ Сняты роли",
          value: removedText,
          inline: false
        } ],
        footer: {
          text: "Выдача ранга ArizonaRP"
        },
        timestamp: (new Date).toISOString()
      });
    }
  }
  return {
    ok: ok,
    reason: ok ? "OK" : "ROLE_SYNC_FAILED",
    guildId: guildId,
    playerRank: playerRank,
    issuedRoleIds: issuedRoleIds,
    removedRoleIds: removedRoleIds,
    failed: failed
  };
}

async function removeDiscordVerificationRoles(cfg, discordId) {
  const botToken = String(cfg.DISCORD_BOT_TOKEN || "").trim();
  if (!botToken || !discordId) return {
    ok: false,
    reason: "NO_BOT_TOKEN_OR_DISCORD_ID",
    removedRoleIds: []
  };
  const guildId = await resolveDiscordGuildId(cfg, botToken);
  if (!guildId) return {
    ok: false,
    reason: "NO_GUILD_ID",
    removedRoleIds: []
  };
  const allRankRoleIds = Object.values(DISCORD_RANK_ROLE_IDS).flatMap(v => Array.isArray(v) ? v : [ v ]);
  const roleIds = [ ...new Set([ DISCORD_VERIFIED_ROLE_ID, ...allRankRoleIds ]) ].filter(Boolean);
  const removedRoleIds = [];
  const failed = [];
  for (const roleId of roleIds) {
    const result = await discordApi("DELETE", `/guilds/${guildId}/members/${discordId}/roles/${roleId}`, botToken);
    if (result.ok || result.status === 404) {
      removedRoleIds.push(roleId);
    } else {
      failed.push({
        roleId: roleId,
        status: result.status,
        text: result.text
      });
      console.error(`[DISCORD ROLES] Failed to remove role ${roleId} from ${discordId}:`, result.status, result.text);
    }
  }
  return {
    ok: failed.length === 0,
    reason: failed.length ? "ROLE_REMOVE_FAILED" : "OK",
    guildId: guildId,
    removedRoleIds: removedRoleIds,
    failed: failed
  };
}

let bgSyncStarted = false;

function startBackgroundRoleSync(cfg) {
  if (bgSyncStarted) return;
  bgSyncStarted = true;
  const SYNC_INTERVAL_MS = 30 * 1e3;
  setInterval(async () => {
    try {
      const pool = db();
      if (!pool) return;
      const [users] = await pool.query("SELECT steamid64, discord_id, role_synced, last_rank, last_sync_time FROM donate_discord_users WHERE discord_id IS NOT NULL AND discord_id != ''");
      if (!users || !users.length) return;
      const nowSec = Math.floor(Date.now() / 1e3);
      for (const user of users) {
        try {
          const currentRank = await getPlayerRankForDiscord(pool, user.steamid64);
          if (currentRank !== (user.last_rank || "") || !dbBool(user.role_synced) || nowSec - (Number(user.last_sync_time) || 0) > 300) {
            await assignDiscordVerificationRoles(cfg, user.steamid64, user.discord_id);
            await new Promise(resolve => setTimeout(resolve, 300));
          }
        } catch (err) {
          console.error(`[DISCORD BG SYNC] Error checking user ${user.steamid64}:`, err.message);
        }
      }
    } catch (e) {
      console.error("[DISCORD BG SYNC] Background sync loop error:", e.message);
    }
  }, SYNC_INTERVAL_MS);
}

function discordOauthRoutes(cfg) {
  const r = Router();
  startBackgroundRoleSync(cfg);
  r.use([ "/discord", "/api/discord" ], (req, res, next) => {
    if (cfg.DISCORD_OAUTH_ENABLED) return next();
    return res.status(503).json({
      ok: false,
      error: "DISCORD_OAUTH_DISABLED"
    });
  });
  r.get("/discord", async (req, res) => {
    const {code: code, state: state} = req.query || {};
    if (!code || !state) {
      return res.status(400).send(`\n        <!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><title>Ошибка</title>\n        <style>body{background:#18181b;color:#f4f4f5;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;} .card{background:#27272a;padding:30px;border-radius:12px;text-align:center;border:1px solid #3f3f46;}</style></head>\n        <body><div class="card"><h1 style="color:#ef4444;">❌ Ошибка</h1><p>Отсутствуют параметры авторизации от Discord.</p></div></body></html>\n      `);
    }
    let stateObj = null;
    try {
      stateObj = JSON.parse(String(state));
    } catch (e) {
      return res.status(400).send(`\n        <!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><title>Ошибка</title>\n        <style>body{background:#18181b;color:#f4f4f5;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;} .card{background:#27272a;padding:30px;border-radius:12px;text-align:center;border:1px solid #3f3f46;}</style></head>\n        <body><div class="card"><h1 style="color:#ef4444;">❌ Ошибка</h1><p>Неверный формат параметра state.</p></div></body></html>\n      `);
    }
    const {steamId64: steamId64, time: time, hash: hash, serverId: serverId} = stateObj || {};
    const normalizedSteamId64 = normalizeSteamId64(steamId64);
    const stateTime = toUnixSeconds(time);
    const nowSec = Math.floor(Date.now() / 1e3);
    const rawLifetime = Number(cfg.DISCORD_LINK_TOKEN_LIFETIME);
    const tokenLifetime = Math.max(60, Number.isFinite(rawLifetime) && rawLifetime > 0 ? rawLifetime : 600);
    const stateHash = String(hash || "").trim().toLowerCase();
    if (!normalizedSteamId64 || !stateTime || !/^[a-f0-9]{32}$/i.test(stateHash)) {
      return res.status(400).send(`\n        <!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><title>Ошибка</title>\n        <style>body{background:#18181b;color:#f4f4f5;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;} .card{background:#27272a;padding:30px;border-radius:12px;text-align:center;border:1px solid #3f3f46;}</style></head>\n        <body><div class="card"><h1 style="color:#ef4444;">❌ Ошибка</h1><p>В параметре state не хватает корректных данных Steam ID, времени или хеша.</p></div></body></html>\n      `);
    }
    if (Math.abs(nowSec - stateTime) > tokenLifetime) {
      console.warn(`[DISCORD OAUTH] Expired state for ${normalizedSteamId64}. time=${stateTime}, now=${nowSec}`);
      return res.status(403).send(`\n        <!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><title>Ссылка устарела</title>\n        <style>body{background:#18181b;color:#f4f4f5;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;} .card{background:#27272a;padding:30px;border-radius:12px;text-align:center;border:1px solid #3f3f46;}</style></head>\n        <body><div class="card"><h1 style="color:#ef4444;">⏱️ Ссылка устарела</h1><p>Пожалуйста, заново нажмите кнопку привязки Discord в игре.</p></div></body></html>\n      `);
    }
    const secret = cfg.DISCORD_LINK_SECRET || "CHANGE_ME";
    const sidNum = serverId !== undefined ? serverId : 1;
    const expectedHash = crypto.createHash("md5").update(`${normalizedSteamId64}${stateTime}${sidNum}${secret}`).digest("hex");
    if (stateHash !== expectedHash) {
      console.warn(`[DISCORD OAUTH] Security Hash Mismatch for ${normalizedSteamId64}. Expected ${expectedHash}, got ${stateHash}`);
      return res.status(403).send(`\n        <!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><title>Ошибка безопасности</title>\n        <style>body{background:#18181b;color:#f4f4f5;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;} .card{background:#27272a;padding:30px;border-radius:12px;text-align:center;border:1px solid #3f3f46;}</style></head>\n        <body><div class="card"><h1 style="color:#ef4444;">❌ Ошибка безопасности</h1><p>Подпись запроса не совпадает или ссылка устарела.<br>Пожалуйста, сгенерируйте ссылку заново в игре.</p></div></body></html>\n      `);
    }
    try {
      const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
        method: "POST",
        body: new URLSearchParams({
          client_id: cfg.DISCORD_CLIENT_ID || "1030097984458858516",
          client_secret: cfg.DISCORD_CLIENT_SECRET || "",
          grant_type: "authorization_code",
          code: String(code),
          redirect_uri: cfg.DISCORD_REDIRECT_URI || "http://212.22.93.35/discord"
        }),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        },
        signal: AbortSignal.timeout(1e4)
      });
      if (!tokenRes.ok) {
        const errText = await tokenRes.text();
        console.error("[DISCORD OAUTH] Token exchange failed:", tokenRes.status, errText);
        return res.status(500).send(`\n          <!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><title>Ошибка авторизации</title>\n          <style>body{background:#18181b;color:#f4f4f5;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;} .card{background:#27272a;padding:30px;border-radius:12px;text-align:center;border:1px solid #3f3f46;}</style></head>\n          <body><div class="card"><h1 style="color:#ef4444;">❌ Ошибка Discord API</h1><p>Не удалось обменять код на токен.<br>Проверьте Client Secret в конфигурации сервера.</p></div></body></html>\n        `);
      }
      const tokenData = await tokenRes.json();
      const accessToken = tokenData.access_token;
      const userRes = await fetch("https://discord.com/api/users/@me", {
        headers: {
          Authorization: `Bearer ${accessToken}`
        },
        signal: AbortSignal.timeout(1e4)
      });
      if (!userRes.ok) {
        throw new Error(`Failed to fetch user profile: ${userRes.status}`);
      }
      const userData = await userRes.json();
      const discordId = normalizeDiscordId(userData.id);
      const discordTag = String(userData.global_name || userData.username || "Discord User").slice(0, 128);
      if (!discordId) {
        throw new Error("Discord API returned invalid user id");
      }
      const [sameDiscordRows] = await db().query("SELECT steamid64 FROM donate_discord_users WHERE discord_id = ? AND steamid64 <> ? LIMIT 1", [ discordId, normalizedSteamId64 ]);
      if (sameDiscordRows.length) {
        console.warn(`[DISCORD OAUTH] Discord ID ${discordId} is already linked to SteamID64 ${sameDiscordRows[0].steamid64}; refused linking to ${normalizedSteamId64}`);
        return res.status(409).send(`\n          <!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><title>Discord уже привязан</title>\n          <style>body{background:#18181b;color:#f4f4f5;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;} .card{background:#27272a;padding:30px;border-radius:12px;text-align:center;border:1px solid #3f3f46;max-width:460px;} p{color:#a1a1aa;line-height:1.5}</style></head>\n          <body><div class="card"><h1 style="color:#38bdf8;">⚠️ Discord уже привязан</h1><p>Этот Discord-аккаунт уже привязан к другому SteamID.<br>Сначала отвяжите старую привязку или используйте другой Discord.</p></div></body></html>\n        `);
      }
      await db().query(`INSERT INTO donate_discord_users (steamid64, discord_id, discord_username, role_synced, linked_time)\n         VALUES (?, ?, ?, 0, ?)\n         ON DUPLICATE KEY UPDATE\n           discord_id = VALUES(discord_id),\n           discord_username = VALUES(discord_username),\n           role_synced = 0,\n           linked_time = VALUES(linked_time)`, [ normalizedSteamId64, discordId, discordTag, Math.floor(Date.now() / 1e3) ]);
      const discordRoleSync = await assignDiscordVerificationRoles(cfg, normalizedSteamId64, discordId, true);
      await db().query("UPDATE donate_discord_users SET role_synced = ? WHERE steamid64 = ? LIMIT 1", [ discordRoleSync.ok ? 1 : 0, normalizedSteamId64 ]).catch(() => {});
      await db().query("DELETE FROM donate_discord_pending WHERE hash = ?", [ stateHash ]).catch(() => {});
      console.log(`[DISCORD OAUTH] Successfully linked SteamID64 ${normalizedSteamId64} to Discord ID ${discordId} (@${discordTag}). Discord roles: ${discordRoleSync.reason}, rank=${discordRoleSync.playerRank || "none"}, issued=${discordRoleSync.issuedRoleIds.join(",") || "none"}`);
      try {
        const logChannelId = cfg.DISCORD_LINK_LOG_CHANNEL_ID || "1522262339464986715";
        const botToken = cfg.DISCORD_BOT_TOKEN || "";
        if (botToken && logChannelId) {
          const logRes = await fetch(`https://discord.com/api/v10/channels/${logChannelId}/messages`, {
            method: "POST",
            headers: {
              Authorization: `Bot ${botToken}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              embeds: [ {
                title: "🔗 Новая привязка Discord",
                color: 5793266,
                fields: [ {
                  name: "Steam ID64",
                  value: normalizedSteamId64,
                  inline: true
                }, {
                  name: "Discord",
                  value: `<@${discordId}> (@${discordTag})`,
                  inline: true
                }, {
                  name: "Ранг",
                  value: discordRoleSync.playerRank || "роль ранга не выдана",
                  inline: true
                }, {
                  name: "Выданные роли",
                  value: discordRoleSync.issuedRoleIds.length ? discordRoleSync.issuedRoleIds.map(id => `<@&${id}>`).join(", ") : "—",
                  inline: false
                } ],
                timestamp: (new Date).toISOString()
              } ]
            }),
            signal: AbortSignal.timeout(1e4)
          });
          if (!logRes.ok) {
            const errText = await logRes.text().catch(() => "");
            console.error("[DISCORD OAUTH] Failed to send log message:", logRes.status, errText);
          }
        }
      } catch (logErr) {
        console.error("[DISCORD OAUTH] Error sending log message:", logErr.message);
      }
      return res.send(`\n        <!DOCTYPE html>\n        <html lang="ru">\n        <head>\n          <meta charset="UTF-8">\n          <title>Привязка Discord успешна</title>\n          <style>\n            body { background: #18181b; color: #f4f4f5; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }\n            .card { background: #27272a; padding: 35px 30px; border-radius: 16px; box-shadow: 0 10px 30px rgba(0,0,0,0.6); text-align: center; max-width: 420px; border: 1px solid #3f3f46; }\n            h1 { color: #5865f2; margin-top: 0; font-size: 26px; margin-bottom: 15px; }\n            p { color: #a1a1aa; font-size: 15px; line-height: 1.6; margin: 10px 0; }\n            .badge { display: inline-block; background: #3f3f46; color: #fff; padding: 4px 10px; border-radius: 6px; font-family: monospace; font-size: 14px; border: 1px solid #52525b; margin: 0 3px; }\n            .success-icon { font-size: 48px; margin-bottom: 10px; }\n          </style>\n        </head>\n        <body>\n          <div class="card">\n            <div class="success-icon">🎉</div>\n            <h1>Успешная привязка!</h1>\n            <p>Ваш Steam ID <span class="badge">${normalizedSteamId64}</span> был успешно привязан к аккаунту Discord <span class="badge">@${discordTag}</span>.</p>\n            <p style="margin-top: 25px; font-size: 14px; color: #71717a;">Вы можете закрыть это окно и вернуться в Garry's Mod!</p>\n          </div>\n        </body>\n        </html>\n      `);
    } catch (e) {
      console.error("[DISCORD OAUTH] Error during OAuth process:", e.message);
      return res.status(500).send(`\n        <!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><title>Внутренняя ошибка</title>\n        <style>body{background:#18181b;color:#f4f4f5;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;} .card{background:#27272a;padding:30px;border-radius:12px;text-align:center;border:1px solid #3f3f46;}</style></head>\n        <body><div class="card"><h1 style="color:#ef4444;">❌ Внутренняя ошибка сервера</h1><p>${e.message}</p></div></body></html>\n      `);
    }
  });
  const unlinkDiscordHandler = async (req, res) => {
    const src = req.method === "GET" ? req.query || {} : {
      ...req.query || {},
      ...req.body || {}
    };
    const steamid64 = normalizeSteamId64(src.steamid64 || src.steamId64 || src.sid || "");
    const secret = String(src.secret || "");
    const expectedSecret = cfg.DISCORD_LINK_SECRET || "CHANGE_ME";
    if (secret !== expectedSecret) {
      return res.status(403).json({
        ok: false,
        error: "FORBIDDEN"
      });
    }
    if (!/^\d{17}$/.test(steamid64)) {
      return res.status(400).json({
        ok: false,
        error: "BAD_STEAMID64"
      });
    }
    try {
      const [rows] = await db().query("SELECT discord_id FROM donate_discord_users WHERE steamid64 = ? LIMIT 1", [ steamid64 ]);
      const discordId = String(rows[0]?.discord_id || "");
      const [del] = await db().query("DELETE FROM donate_discord_users WHERE steamid64 = ? LIMIT 1", [ steamid64 ]);
      await db().query("DELETE FROM donate_discord_pending WHERE steamid64 = ?", [ steamid64 ]).catch(() => {});
      let discordRoles = null;
      if (discordId) {
        discordRoles = await removeDiscordVerificationRoles(cfg, discordId).catch(e => ({
          ok: false,
          reason: e.message,
          removedRoleIds: []
        }));
      }
      console.log(`[DISCORD UNLINK] SteamID64 ${steamid64} unlinked. Discord ID: ${discordId || "none"}. DB deleted: ${del?.affectedRows || 0}`);
      return res.json({
        ok: true,
        linked: false,
        steamid64: steamid64,
        discord_id: discordId,
        deleted: del?.affectedRows || 0,
        discord_roles: discordRoles
      });
    } catch (e) {
      console.error("[DISCORD UNLINK API] Database error:", e.message);
      return res.status(500).json({
        ok: false,
        error: "DATABASE_ERROR"
      });
    }
  };
  r.get("/api/unlink", unlinkDiscordHandler);
  r.post("/api/unlink", unlinkDiscordHandler);
  r.get("/api/status", async (req, res) => {
    const {secret: secret} = req.query || {};
    const steamid64 = normalizeSteamId64(req.query?.steamid64 || req.query?.steamId64 || req.query?.sid || "");
    const expectedSecret = cfg.DISCORD_LINK_SECRET || "CHANGE_ME";
    if (secret !== expectedSecret) {
      return res.status(403).json({
        ok: false,
        error: "FORBIDDEN"
      });
    }
    if (!steamid64) {
      return res.status(400).json({
        ok: false,
        error: "BAD_STEAMID64"
      });
    }
    try {
      const [rows] = await db().query("SELECT discord_id, role_synced, last_rank, last_sync_time FROM donate_discord_users WHERE steamid64 = ? LIMIT 1", [ steamid64 ]);
      if (rows && rows.length > 0) {
        const row = rows[0];
        const nowSec = Math.floor(Date.now() / 1e3);
        const currentRank = await getPlayerRankForDiscord(db(), steamid64);
        if (currentRank !== (row.last_rank || "") || !dbBool(row.role_synced) || nowSec - (Number(row.last_sync_time) || 0) > 60) {
          assignDiscordVerificationRoles(cfg, steamid64, String(row.discord_id || "")).catch(() => {});
        }
        return res.json({
          ok: true,
          linked: true,
          discord_id: String(row.discord_id || ""),
          role_synced: dbBool(row.role_synced)
        });
      } else {
        return res.json({
          ok: true,
          linked: false,
          discord_id: "",
          role_synced: false
        });
      }
    } catch (e) {
      console.error("[DISCORD STATUS API] Database error:", e.message);
      return res.status(500).json({
        ok: false,
        error: "DATABASE_ERROR"
      });
    }
  });
  return r;
}

export { discordOauthRoutes as default };
