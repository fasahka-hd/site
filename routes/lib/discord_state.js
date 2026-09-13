import { EmbedBuilder } from "discord.js";

import { steamGetPersonaname } from "./helpers.js";

import { db } from "./db.js";

let _client = null;

let _warnChannelId = "";

let _steamApiKey = "";

let _serverName = "1";

export function setDiscordClient(client) {
  _client = client || null;
}

export function getDiscordClient() {
  return _client;
}

export function setWarnLogChannelId(id) {
  _warnChannelId = String(id || "").trim();
}

export function getWarnLogChannelId() {
  return _warnChannelId;
}

export function setSteamApiKey(key) {
  _steamApiKey = String(key || "").trim();
}

export function setServerName(name) {
  const s = String(name || "").trim();
  if (s) _serverName = s;
}

const DEFAULT_AVATAR = "https://avatars.cloudflare.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_full.jpg";

const ZW = "​";

const SPACER = {
  name: ZW,
  value: ZW,
  inline: true
};

function str(v, fallback = "") {
  if (v === null || v === undefined) return fallback;
  const s = String(v);
  return s.length ? s : fallback;
}

function profileUrl(sid64) {
  const s = str(sid64, "");
  return /^\d{17}$/.test(s) ? `https://steamcommunity.com/profiles/${s}` : "";
}

function meaningfulSid(sid) {
  const s = str(sid, "").trim();
  if (!s || s.toLowerCase() === "console") return "";
  return s;
}

function toFullAvatar(url) {
  let u = str(url, "");
  if (!/^https?:\/\//i.test(u)) return u;
  u = u.replace(/_medium\.jpg$/, "_full.jpg");
  return u;
}

function formatUser(name, sid, fallback = "—") {
  const n = str(name, "");
  const s = meaningfulSid(sid);
  if (!n && !s) return fallback;
  if (n && s) return `${n}\n\`${s}\``;
  if (n) return n;
  return `\`${s}\``;
}

export function buildWarnEmbed(event) {
  const type = str(event?.type, "warn").toLowerCase();
  const playerName = str(event?.player_name, "");
  const playerSid64 = str(event?.player_steamid64, "");
  const playerSid = meaningfulSid(str(event?.player_steamid || playerSid64, ""));
  const playerLink = profileUrl(playerSid64);
  const adminName = str(event?.admin_name, "") || "Console";
  const adminSid = meaningfulSid(str(event?.admin_steamid || event?.admin_steamid64 || ""));
  const reason = str(event?.reason, "");
  const avatar = toFullAvatar(event?.player_avatar);
  const warnMax = Number.isFinite(Number(event?.warn_max)) ? Number(event.warn_max) : 5;
  const count = Number(event?.warn_count);
  let title, color;
  if (type === "warn") {
    title = "⚠️ Варн выдан";
    color = 16718362;
  } else if (type === "unwarn" || type === "remove") {
    title = "✅ Варн снят";
    color = 52275;
  } else {
    title = "✏️ Редактирование варна";
    color = 3900150;
  }
  const embed = (new EmbedBuilder).setColor(color).setTitle(title).setThumbnail(avatar).setTimestamp(new Date);
  if (playerLink) embed.setURL(playerLink);
  if (type === "edit") {
    const issuer = formatUser(adminName, adminSid);
    const target = formatUser(playerName, playerSid);
    embed.addFields({
      name: "Кто выдал",
      value: issuer,
      inline: true
    }, {
      name: "Кому выдан",
      value: target,
      inline: true
    }, SPACER);
    if (reason) {
      embed.setDescription(`**Причина:**\n\`${reason}\``);
    }
    if (event?.warn_id) {
      embed.addFields({
        name: "ID варна",
        value: String(event.warn_id),
        inline: true
      });
    }
    return embed;
  }
  const issuer = formatUser(adminName, adminSid);
  const target = formatUser(playerName, playerSid);
  embed.addFields({
    name: "Кто выдал",
    value: issuer,
    inline: true
  }, {
    name: "Кому выдан",
    value: target,
    inline: true
  }, SPACER);
  if (reason) {
    embed.setDescription(`**Причина:**\n\`${reason}\``);
  }
  if (type === "remove" && event?.warn_id) {
    embed.addFields({
      name: "ID варна",
      value: String(event.warn_id),
      inline: false
    });
  }
  if (Number.isFinite(count)) {
    const was = type === "warn" ? Math.max(0, count - 1) : count + 1;
    embed.addFields({
      name: ZW,
      value: ZW,
      inline: false
    }, {
      name: "Было",
      value: `${was}/${warnMax}`,
      inline: true
    }, SPACER, {
      name: "Стало",
      value: `${count}/${warnMax}`,
      inline: true
    });
  }
  return embed;
}

async function resolvePlayerName(playerName, playerSid64) {
  if (str(playerName, "")) return playerName;
  if (_steamApiKey && /^\d{17}$/.test(playerSid64)) {
    try {
      const name = await steamGetPersonaname(_steamApiKey, playerSid64);
      if (str(name, "")) return name;
    } catch {}
  }
  return "";
}

async function resolvePlayerAvatar(playerSid64) {
  if (_steamApiKey && /^\d{17}$/.test(playerSid64)) {
    try {
      const r = await fetch(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${encodeURIComponent(_steamApiKey)}&steamids=${encodeURIComponent(playerSid64)}`, {
        signal: AbortSignal.timeout(8e3),
        headers: {
          "User-Agent": "VibeRP-WebPanel"
        }
      });
      if (r.ok) {
        const j = await r.json();
        const a = str(j?.response?.players?.[0]?.avatarfull, "");
        if (/^https?:\/\//i.test(a)) return a;
      }
    } catch {}
  }
  return "";
}

async function resolveDiscordId(playerSid64) {
  if (!/^\d{17}$/.test(playerSid64)) return "";
  try {
    const pool = db();
    if (!pool) return "";
    const [rows] = await pool.query("SELECT discord_id FROM donate_discord_users WHERE CAST(steamid64 AS CHAR) = ? AND discord_id IS NOT NULL AND discord_id != '' LIMIT 1", [ String(playerSid64) ]);
    const did = str(rows[0]?.discord_id, "");
    return /^\d{5,32}$/.test(did) ? did : "";
  } catch (e) {
    console.warn("[WARN LOG] Не удалось получить привязку Discord:", e?.message || e);
    return "";
  }
}

export async function sendWarnLog(event) {
  if (!_client) {
    console.warn("[WARN LOG] Discord-клиент не готов — сообщение не отправлено.");
    return false;
  }
  if (!_warnChannelId) {
    console.warn("[WARN LOG] WARN_LOG_CHANNEL_ID не задан — сообщение не отправлено.");
    return false;
  }
  try {
    const channel = await _client.channels.fetch(_warnChannelId).catch(() => null);
    if (!channel?.isTextBased?.()) {
      console.error("[WARN LOG] Канал не найден или не является текстовым:", _warnChannelId);
      return false;
    }
    const playerSid64 = str(event?.player_steamid64, "");
    if (!str(event?.player_name, "")) {
      event.player_name = await resolvePlayerName(event?.player_name, playerSid64);
    }
    const avatar = await resolvePlayerAvatar(playerSid64);
    if (avatar) event.player_avatar = avatar;
    const discordId = await resolveDiscordId(playerSid64);
    const embed = buildWarnEmbed(event);
    const payload = {
      embeds: [ embed ],
      allowedMentions: discordId ? {
        users: [ discordId ]
      } : {
        parse: []
      }
    };
    if (discordId) {
      payload.content = `<@${discordId}>`;
    }
    await channel.send(payload);
    console.log(`[WARN LOG] Отправлено: ${event?.type || "?"} (канал ${_warnChannelId}${discordId ? `, пинг ${discordId}` : ""})`);
    return true;
  } catch (e) {
    console.error("[WARN LOG] Ошибка отправки:", e?.message || e);
    return false;
  }
}
