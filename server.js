import "dotenv/config";

import express from "express";

import session from "express-session";

import expressMySqlSession from "express-mysql-session";

import helmet from "helmet";

import compression from "compression";

import rateLimit from "express-rate-limit";

import { join, dirname } from "path";

import { existsSync } from "fs";

import { decodeIfNeeded } from "./lib/helpers.js";

import { fileURLToPath } from "url";

import { initPool, ensurePanelSchema, db } from "./lib/db.js";

import authRoutes from "./routes/auth.js";

import playersRoutes from "./routes/players.js";

import playerRoutes from "./routes/player.js";

import bansRoutes from "./routes/bans.js";

import statsRoutes from "./routes/stats.js";

import adminLogsRoutes from "./routes/admin_logs.js";

import blacklistRoutes from "./routes/blacklist.js";

import usersRoutes from "./routes/users.js";

import permissionsRoutes from "./routes/permissions.js";

import commandsRoutes from "./routes/commands.js";

import avatarRoutes from "./routes/avatar.js";

import onlineRoutes from "./routes/online.js";

import modelsRoutes from "./routes/models.js";

import playerModelsRoutes from "./routes/player_models.js";

import weaponsRoutes from "./routes/weapons.js";

import playerWeaponsRoutes from "./routes/player_weapons.js";

import jobsRoutes from "./routes/jobs.js";

import playerJobsRoutes from "./routes/player_jobs.js";

import playerQmenuRoutes from "./routes/player_qmenu.js";

import playerAccessRoutes from "./routes/player_access.js";

import serverSyncRoutes from "./routes/server_sync.js";

import zbtAccessRoutes from "./routes/zbt_access.js";

import promosRoutes from "./routes/promos.js";

import locksRoutes from "./routes/locks.js";

import moneyLogsRoutes from "./routes/money_logs.js";

import donateLogsRoutes from "./routes/donate_logs.js";

import techGangsRoutes from "./routes/tech_gangs.js";

import duelsRoutes from "./routes/duels.js";

import discordOauthRoutes from "./routes/discord_oauth.js";

import texPublicRoutes, { createTexLink, createTexInfoLink, getTexLogs, normSteam, ensureTexLinkColumns } from "./routes/tex_public.js";

import restartRoutes from "./routes/restart.js";

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, EmbedBuilder, Events, GatewayIntentBits, Partials } from "discord.js";

import proxyAddr from "proxy-addr";

import dgram from "node:dgram";

import { timingSafeEqual } from "crypto";

import { loadLocks, isPermLockedFor, resolveActionPerm, lockAppliesTo } from "./lib/locks.js";

import { authGuard } from "./lib/guard.js";

import { setDiscordClient, setWarnLogChannelId, setSteamApiKey, setServerName, sendWarnLog } from "./lib/discord_state.js";

import { runBotCommand, resolvePendingMod, discordConfirmEmbed, discordConfirmRow, discordOutcomeEmbed, telegramConfirmHtml, telegramOutcomeHtml } from "./lib/bot_mod.js";

console.log("=== SERVER JS UPDATED VERSION LOADED ===");

const __dirname = dirname(fileURLToPath(import.meta.url));

const cfg = {
  DB_HOST: process.env.DB_HOST,
  DB_PORT: parseInt(process.env.DB_PORT || "3306", 10) || 3306,
  DB_USER: process.env.DB_USER,
  DB_PASS: process.env.DB_PASS,
  DB_NAME: process.env.DB_NAME,
  STEAM_API_KEY: process.env.STEAM_API_KEY,
  WEB_SECRET: process.env.WEB_SECRET,
  SESSION_SECRET: process.env.SESSION_SECRET,
  BASE_URL: process.env.BASE_URL || "",
  PORT: parseInt(process.env.PORT || "3000", 10),
  DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_TOKEN || "",
  DISCORD_CLIENT_ID: process.env.DISCORD_CLIENT_ID || "",
  DISCORD_CLIENT_SECRET: process.env.DISCORD_CLIENT_SECRET || "",
  DISCORD_REDIRECT_URI: process.env.DISCORD_REDIRECT_URI || "",
  DISCORD_LINK_SECRET: process.env.DISCORD_LINK_SECRET || "",
  DISCORD_LINK_TOKEN_LIFETIME: parseInt(process.env.DISCORD_LINK_TOKEN_LIFETIME || "600", 10) || 600,
  DISCORD_VOICE_CHANNEL_ID: process.env.DISCORD_VOICE_CHANNEL_ID || "",
  DISCORD_LINK_LOG_CHANNEL_ID: process.env.DISCORD_LINK_LOG_CHANNEL_ID || "",
  DISCORD_WARN_LOG_CHANNEL_ID: process.env.DISCORD_WARN_LOG_CHANNEL_ID || process.env.WARN_LOG_CHANNEL_ID || "",
  WARN_SERVER_NAME: process.env.WARN_SERVER_NAME || "1",
  DISCORD_GUILD_ID: process.env.DISCORD_GUILD_ID || process.env.GUILD_ID || "",
  GMOD_SERVER_HOST: process.env.GMOD_SERVER_HOST || "",
  GMOD_SERVER_PORT: parseInt(process.env.GMOD_SERVER_PORT || "0", 10),
  VOICE_CHANNEL_PREFIX: process.env.VOICE_CHANNEL_PREFIX || "Онлайн",
  VOICE_CHANNEL_UPDATE_MS: parseInt(process.env.VOICE_CHANNEL_UPDATE_MS || "60000", 10)
};

const REQUIRED = [ "DB_HOST", "DB_USER", "DB_PASS", "DB_NAME", "WEB_SECRET", "SESSION_SECRET" ];

for (const key of REQUIRED) {
  if (!cfg[key]) {
    console.error(`Missing required env variable: ${key}`);
    process.exit(1);
  }
}

cfg.COOKIE_SECURE = process.env.COOKIE_SECURE ? /^(1|true|yes)$/i.test(String(process.env.COOKIE_SECURE)) : /^https:\/\//i.test(cfg.BASE_URL || "");

if (process.env.NODE_ENV === "production" && !cfg.COOKIE_SECURE) {
  console.warn("[SECURITY] Cookies are sent without Secure flag (BASE_URL is not HTTPS). Use HTTPS in production or set COOKIE_SECURE=1 behind a TLS proxy.");
}

const DISCORD_OAUTH_ENV = [ "DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET", "DISCORD_REDIRECT_URI", "DISCORD_LINK_SECRET" ];

const missingDiscordOauth = DISCORD_OAUTH_ENV.filter(k => !cfg[k]);

cfg.DISCORD_OAUTH_ENABLED = missingDiscordOauth.length === 0;

if (!cfg.DISCORD_OAUTH_ENABLED) {
  console.warn(`[DISCORD OAUTH] disabled, missing env: ${missingDiscordOauth.join(", ")}`);
} else if (!/^https:\/\//i.test(cfg.DISCORD_REDIRECT_URI) && process.env.NODE_ENV === "production") {
  console.warn("[DISCORD OAUTH] DISCORD_REDIRECT_URI is not HTTPS in production");
}

if (!cfg.GMOD_SERVER_HOST || !cfg.GMOD_SERVER_PORT) {
  console.warn("[GMOD] GMOD_SERVER_HOST/GMOD_SERVER_PORT not set — server query disabled");
}

const MySQLSessionStore = expressMySqlSession(session);

const app = express();

app.disable("x-powered-by");

const TRUSTED_PROXIES = [ "loopback", "linklocal", "uniquelocal" ];

const trustedProxyCheck = proxyAddr.compile(TRUSTED_PROXIES);

app.set("trust proxy", ip => trustedProxyCheck(ip));

const INLINE_SCRIPT_HASHES = [ "'sha256-RC2IOBnWepNKbUrtL82D2StoxcPtwkrHKavVx6332TI='", "'sha256-DPAPQCaKUkfaCKGVTrR9QVylBN4giySBByH5HP+IdXQ='", "'sha256-adtmaQzTosUiu5Uyi3or45Q5Ew4ee2Pip99mHBtkquk='" ];

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: [ "'self'" ],
      scriptSrc: [ "'self'", ...INLINE_SCRIPT_HASHES ],
      scriptSrcAttr: [ "'none'" ],
      styleSrc: [ "'self'", "'unsafe-inline'" ],
      fontSrc: [ "'self'" ],
      imgSrc: [ "'self'", "https:", "data:" ],
      connectSrc: [ "'self'", "https://api.steampowered.com", "ws:", "wss:" ],
      workerSrc: [ "'self'" ],
      manifestSrc: [ "'self'" ],
      upgradeInsecureRequests: null
    }
  },
  originAgentCluster: false,
  crossOriginOpenerPolicy: process.env.NODE_ENV === "production" ? false : {
    policy: "same-origin"
  },
  crossOriginResourcePolicy: {
    policy: "same-origin"
  },
  hsts: process.env.NODE_ENV === "production" ? {
    maxAge: 15552e3,
    includeSubDomains: false,
    preload: false
  } : false
}));

app.use(compression({
  threshold: 512,
  filter(req, res) {
    if (req.headers["x-no-compression"]) return false;
    return compression.filter(req, res);
  }
}));

const sessionStore = new MySQLSessionStore({
  host: cfg.DB_HOST,
  port: cfg.DB_PORT,
  user: cfg.DB_USER,
  password: cfg.DB_PASS,
  database: cfg.DB_NAME,
  charset: "utf8mb4_general_ci",
  createDatabaseTable: true,
  clearExpired: true,
  checkExpirationInterval: 15 * 60 * 1e3,
  expiration: 7 * 24 * 60 * 60 * 1e3,
  schema: {
    tableName: "web_sessions",
    columnNames: {
      session_id: "session_id",
      expires: "expires",
      data: "data"
    }
  }
});

sessionStore.on("error", e => {
  console.error("[SESSION STORE]", e?.message || e);
});

const sessionMiddleware = session({
  secret: cfg.SESSION_SECRET,
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1e3,
    httpOnly: true,
    sameSite: "lax",
    secure: cfg.COOKIE_SECURE
  }
});

app.use(sessionMiddleware);

const activeSiteUsers = new Map;

const ACTIVE_USERS_TTL_MS = 5 * 60 * 1e3;

const ACTIVE_USERS_MAX = 5e3;

function touchActiveUser(user) {
  const sid = String(user?.steamid64 || "").trim();
  if (!/^\d{17}$/.test(sid)) return;
  activeSiteUsers.set(sid, Date.now());
  if (activeSiteUsers.size > ACTIVE_USERS_MAX) {
    const now = Date.now();
    for (const [k, ts] of activeSiteUsers) {
      if (now - ts > ACTIVE_USERS_TTL_MS) activeSiteUsers.delete(k);
    }
    while (activeSiteUsers.size > ACTIVE_USERS_MAX) {
      const oldest = activeSiteUsers.keys().next().value;
      if (oldest === undefined) break;
      activeSiteUsers.delete(oldest);
    }
  }
}

function activeSiteCount() {
  const now = Date.now();
  for (const [sid, ts] of activeSiteUsers) {
    if (now - ts > ACTIVE_USERS_TTL_MS) activeSiteUsers.delete(sid);
  }
  return activeSiteUsers.size;
}

app.locals.getActiveSiteCount = activeSiteCount;

setInterval(() => {
  const now = Date.now();
  for (const [sid, ts] of activeSiteUsers) {
    if (now - ts > ACTIVE_USERS_TTL_MS) activeSiteUsers.delete(sid);
  }
}, 5 * 60 * 1e3).unref();

app.use((req, _res, next) => {
  if (req.session?.user) touchActiveUser(req.session.user);
  next();
});

app.use((req, res, next) => {
  const path = decodeURIComponent(req.path || "");
  if (path.includes("..") || path.includes("\0")) {
    return res.status(403).json({
      ok: false,
      error: "FORBIDDEN"
    });
  }
  next();
});

const BLOCKED_PATHS = [ /^\/data(\/|$)/i, /^\/\.env/i, /^\/server\.js/i, /^\/cluster\.js/i, /^\/package\.json/i, /^\/package-lock\.json/i, /^\/nodemon\.json/i, /^\/\.git(\/|$)/i, /^\/lib(\/|$)/i, /^\/routes(\/|$)/i, /\.json(\?|$)/i, /\.env(\?|$)/i, /\.sql(\?|$)/i, /\.log(\?|$)/i, /\.bak(\?|$)/i, /\.swp(\?|$)/i, /~$/i, /\/\.\w/i, /\/uploads\//i ];

app.use((req, res, next) => {
  const path = req.path || "";
  for (const pattern of BLOCKED_PATHS) {
    if (pattern.test(path)) {
      return res.status(403).json({
        ok: false,
        error: "FORBIDDEN"
      });
    }
  }
  next();
});

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), interest-cohort=()");
  res.setHeader("X-Permitted-Cross-Domain-Policies", "none");
  res.setHeader("X-Download-Options", "noopen");
  res.setHeader("X-DNS-Prefetch-Control", "off");
  next();
});

app.use((req, res, next) => {
  if (req.path === "/robots.txt") return res.type("text").send("User-agent: *\nDisallow: /\n");
  if (req.path === "/favicon.ico") return res.status(404).end();
  if (req.path === "/api/health") return res.json({ ok: true, uptime: Math.floor(process.uptime()), db: startupState.dbReady, pid: process.pid });
  next();
});

app.use((req, res, next) => {
  if (!req.session?.user) return next();
  if (!req.path || !req.path.startsWith("/api/")) return next();
  if (req.path.startsWith("/api/locks")) return next();
  const isMutating = ![ "GET", "HEAD", "OPTIONS" ].includes(String(req.method || "").toUpperCase());
  try {
    if (!lockAppliesTo(req.session.user)) return next();
    const perm = resolveActionPerm(req.method, req.path, req.body);
    if (!perm) return next();
    if (isPermLockedFor(req.session.user, perm)) {
      return res.status(423).json({
        ok: false,
        error: "LOCKED",
        perm: perm,
        message: "Находится в активном редактировании."
      });
    }
  } catch (e) {
    console.error(`[LOCKS] middleware error on ${req.method} ${req.path}:`, e?.message || e);
    if (isMutating) {
      return res.status(503).json({
        ok: false,
        error: "LOCK_CHECK_FAILED",
        message: "Не удалось проверить блокировки. Повторите позже."
      });
    }
  }
  next();
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1e3,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    ok: false,
    error: "TOO_MANY_REQUESTS"
  },
  skipSuccessfulRequests: true
});

const globalLimiter = rateLimit({
  windowMs: 60 * 1e3,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    ok: false,
    error: "RATE_LIMIT"
  }
});

app.use(globalLimiter);

const GLOBAL_REQUEST_TIMEOUT_MS = 30 * 1e3;

const startupState = { dbReady: false };

app.use((req, res, next) => {
  if (startupState.dbReady) return next();
  if (req.path.startsWith("/api/")) return res.status(503).json({ ok: false, error: "STARTING" });
  return res.status(503).type("text").send("Starting, try again in a few seconds…");
});

app.use((req, res, next) => {
  req.setTimeout(GLOBAL_REQUEST_TIMEOUT_MS, () => {
    try {
      if (res.headersSent || res.writableEnded || res.destroyed) {
        res.destroy?.();
        return;
      }
      res.status(503).json({
        ok: false,
        error: "REQUEST_TIMEOUT"
      });
    } catch (e) {
      console.error("[TIMEOUT] failed to send 503:", e?.message || e);
      try {
        res.destroy?.();
      } catch {}
    }
  });
  res.setTimeout(GLOBAL_REQUEST_TIMEOUT_MS);
  next();
});

const steamApiLimiter = rateLimit({
  windowMs: 60 * 1e3,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    ok: false,
    error: "STEAM_API_LIMIT"
  },
  skipSuccessfulRequests: false
});

const warnLogLimiter = rateLimit({
  windowMs: 60 * 1e3,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    ok: false,
    error: "TOO_MANY_REQUESTS"
  },
  skipSuccessfulRequests: false
});

const serverApiLimiter = rateLimit({
  windowMs: 60 * 1e3,
  max: 240,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    ok: false,
    error: "TOO_MANY_REQUESTS"
  },
  skipSuccessfulRequests: false
});

const steamCallbackLimiter = rateLimit({
  windowMs: 60 * 1e3,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    ok: false,
    error: "TOO_MANY_REQUESTS"
  },
  skipSuccessfulRequests: false
});

app.use(express.json({
  limit: "256kb"
}));

app.use(express.urlencoded({
  extended: true,
  limit: "256kb"
}));

const DIST_DIR = join(__dirname, "public", "dist");

function staticSetHeaders(res, path, stat) {
  if (path.endsWith(".webmanifest")) {
    res.setHeader("Cache-Control", "no-cache");
  } else if (/\.(png|jpe?g|webp|gif|svg|ico|woff2?)$/i.test(path)) {
    res.setHeader("Cache-Control", "public, max-age=2592000, immutable");
  } else if (/\.(js|css)$/i.test(path)) {
    res.setHeader("Cache-Control", "no-cache, must-revalidate, max-age=0");
  }
  if (stat && !res.getHeader("ETag")) {
    res.setHeader("ETag", `W/"${stat.size}-${Number(stat.mtimeMs).toString(36)}"`);
  }
}

const CLEAN_URL_REDIRECTS = new Map([ [ "/index.html", "/" ], [ "/login.html", "/login" ], [ "/bans.html", "/bans" ], [ "/stats.html", "/stats" ], [ "/admin_logs.html", "/admin-logs" ], [ "/blacklist.html", "/blacklist" ], [ "/promos.html", "/promos" ], [ "/zbt_access.html", "/zbt-access" ], [ "/manage.html", "/manage" ], [ "/add_user.html", "/manage/users" ], [ "/locks.html", "/manage/locks" ], [ "/permissions.html", "/manage/permissions" ], [ "/restart.html", "/manage/restart" ], [ "/emoji.html", "/emoji" ], [ "/tech_general.html", "/tech/general" ], [ "/tech_money.html", "/tech/money" ], [ "/tech_gangs.html", "/tech/gangs" ], [ "/tech_gangs_list.html", "/tech/gangs/list" ], [ "/tech_duels.html", "/tech/duels" ], [ "/tech_donate.html", "/tech/donate" ], [ "/player.html", "/player" ] ]);

app.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  const to = CLEAN_URL_REDIRECTS.get(req.path);
  if (to) {
    const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    return res.redirect(301, to + qs);
  }
  if (/\.(html?|json|env|sql|log|bak|orig|swp)$/i.test(req.path)) {
    return res.status(404).type("text").send("Not found");
  }
  next();
});

if (existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR, {
    maxAge: "1h",
    etag: true,
    lastModified: true,
    dotfiles: "deny",
    setHeaders: staticSetHeaders
  }));
  console.log("[STATIC] Serving minified assets from public/dist");
} else {
  console.log("[STATIC] public/dist not found — serving unminified sources (run: npm run build)");
}

app.use(express.static(join(__dirname, "public"), {
  maxAge: "1h",
  etag: true,
  lastModified: true,
  dotfiles: "deny",
  setHeaders: staticSetHeaders
}));

const PUBLIC_PAGES = new Set([ "/login" ]);

const PAGE_ROUTES = [ [ "/", "index.html" ], [ "/players", "index.html" ], [ "/login", "login.html" ], [ "/bans", "bans.html" ], [ "/stats", "stats.html" ], [ "/admin-logs", "admin_logs.html" ], [ "/blacklist", "blacklist.html" ], [ "/promos", "promos.html" ], [ "/zbt-access", "zbt_access.html" ], [ "/manage", "manage.html" ], [ "/manage/users", "add_user.html" ], [ "/manage/locks", "locks.html" ], [ "/manage/permissions", "permissions.html" ], [ "/manage/restart", "restart.html" ], [ "/restart", "restart.html" ], [ "/emoji", "emoji.html" ], [ "/tech/general", "tech_general.html" ], [ "/tech/money", "tech_money.html" ], [ "/tech/gangs", "tech_gangs.html" ], [ "/tech/gangs/list", "tech_gangs_list.html" ], [ "/tech/duels", "tech_duels.html" ], [ "/tech/donate", "tech_donate.html" ], [ "/player", "player.html" ] ];

for (const [route, file] of PAGE_ROUTES) {
  if (PUBLIC_PAGES.has(route)) {
    app.get(route, (req, res) => {
      const distFile = join(DIST_DIR, file);
      res.sendFile(existsSync(distFile) ? distFile : join(__dirname, "public", file));
    });
  } else {
    app.get(route, authGuard, (req, res) => {
      const distFile = join(DIST_DIR, file);
      res.sendFile(existsSync(distFile) ? distFile : join(__dirname, "public", file));
    });
  }
}

function safeCompareStr(a, b) {
  const bufA = Buffer.from(String(a || ""), "utf8");
  const bufB = Buffer.from(String(b || ""), "utf8");
  if (bufA.length !== bufB.length) {
    try {
      timingSafeEqual(bufA, bufA);
    } catch {}
    return false;
  }
  try {
    return timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

app.use(authRoutes(cfg, loginLimiter, steamCallbackLimiter));

app.use(playersRoutes());

app.use(playerRoutes(cfg, steamApiLimiter));

app.use(bansRoutes());

app.use(statsRoutes());

app.use(adminLogsRoutes());

app.use(blacklistRoutes());

app.use(usersRoutes());

app.use(permissionsRoutes());

app.use([ "/api/get", "/api/mark" ], serverApiLimiter);

app.use(commandsRoutes(cfg));

app.use(avatarRoutes(cfg, steamApiLimiter));

app.use(onlineRoutes(cfg));

app.use(modelsRoutes());

app.use(playerModelsRoutes());

app.use(weaponsRoutes());

app.use(playerWeaponsRoutes());

app.use(jobsRoutes());

app.use(playerJobsRoutes());

app.use(playerQmenuRoutes());

app.use(playerAccessRoutes());

app.use(zbtAccessRoutes());

app.use(promosRoutes());

app.use(serverSyncRoutes(cfg));

app.use(locksRoutes());

app.use(moneyLogsRoutes());

app.use(donateLogsRoutes());

app.use(techGangsRoutes());

app.use(duelsRoutes(cfg));

app.use(discordOauthRoutes(cfg));

app.use(restartRoutes(cfg));

app.use([ "/public/tex", "/texinfo" ], (req, res, next) => {
  res.setHeader("Content-Security-Policy", [ "default-src 'self'", "script-src 'self' 'unsafe-inline'", "script-src-attr 'unsafe-inline'", "style-src 'self' 'unsafe-inline'", "img-src 'self' https: data:", "connect-src 'self'", "frame-ancestors 'none'" ].join("; "));
  res.setHeader("X-Frame-Options", "DENY");
  next();
});

app.use(texPublicRoutes());

app.post("/api/warn_log", warnLogLimiter, async (req, res) => {
  const pass = String(req.body?.password || req.headers["x-api-password"] || (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim() || "").trim();
  if (!cfg.WEB_SECRET || !safeCompareStr(pass, cfg.WEB_SECRET)) {
    return res.status(403).json({
      ok: false,
      error: "BAD_PASSWORD"
    });
  }
  const ev = req.body || {};
  const type = String(ev.type || "").toLowerCase();
  if (![ "warn", "remove", "unwarn", "edit" ].includes(type)) {
    return res.status(400).json({
      ok: false,
      error: "BAD_TYPE"
    });
  }
  sendWarnLog(ev).catch(e => console.error("[WARN LOG] send error:", e?.message || e));
  return res.json({
    ok: true
  });
});

app.use((req, res) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({
      ok: false,
      error: "NOT_FOUND"
    });
  }
  res.status(404).type("text").send("Not found");
});

app.use((err, req, res, _next) => {
  console.error(err.message || err);
  if (!res.headersSent) {
    res.status(500).json({
      ok: false,
      error: "INTERNAL_ERROR"
    });
  }
});

let gracefulShutdown = null;

process.on("unhandledRejection", err => {
  console.error("Unhandled rejection:", err?.message || err);
});

process.on("uncaughtException", err => {
  console.error("Uncaught exception:", err?.message || err);
  if (typeof gracefulShutdown === "function") {
    gracefulShutdown("uncaughtException", 1);
  } else {
    setTimeout(() => process.exit(1), 1e3).unref();
  }
});

function texMoney(v) {
  v = Number(v || 0);
  return `${v > 0 ? "+" : ""}${Math.round(v).toLocaleString("ru-RU")} ₽`;
}

function parseTexPeriod(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return null;
  const m = s.match(/^(\d{1,3})\s*(д|дн|день|дня|дней|day|days)?$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.max(1, Math.min(365, n));
}

function isAdminDiscordId(id, adminId) {
  return String(id || "") === String(adminId || "");
}

async function getTexPlayerName(pool, steamid64) {
  const sid = String(steamid64 || "");
  if (!/^\d{17}$/.test(sid)) return "";
  try {
    const [r] = await pool.query("SELECT Name FROM player_data WHERE CAST(SteamID AS CHAR) = ? LIMIT 1", [ sid ]);
    if (r[0]?.Name) return decodeIfNeeded(r[0].Name);
  } catch {}
  try {
    const [r] = await pool.query("SELECT name FROM ba_users WHERE CAST(steamid AS CHAR) = ? LIMIT 1", [ sid ]);
    if (r[0]?.name) return decodeIfNeeded(r[0].name);
  } catch {}
  try {
    const [r] = await pool.query("SELECT Nick FROM GMDonate_Players WHERE CAST(SteamID64 AS CHAR) = ? LIMIT 1", [ sid ]);
    if (r[0]?.Nick) return decodeIfNeeded(r[0].Nick);
  } catch {}
  return "";
}

function texRateAllowed(map, userId) {
  const now = Date.now();
  const win = 5 * 60 * 1e3;
  const key = String(userId || "");
  const arr = (map.get(key) || []).filter(t => now - t < win);
  if (arr.length >= 5) {
    map.set(key, arr);
    return false;
  }
  arr.push(now);
  map.set(key, arr);
  return true;
}

function texPublicUrl(path) {
  return (process.env.BASE_URL || cfg.BASE_URL || "").replace(/\/$/, "") + path;
}

async function sendTexInfo(message) {
  const token = await createTexInfoLink(db(), `discord:${message.author.id}`);
  const url = texPublicUrl(`/texinfo/${token}`);
  const embed = (new EmbedBuilder).setTitle("TEX info").setDescription(`Ссылка на историю TEX запросов:\n${url}\n\nДоступ: только авторизованный KP. Активна 24 часа.`).setColor(6333946).setTimestamp(new Date);
  const row = (new ActionRowBuilder).addComponents((new ButtonBuilder).setLabel("Открыть").setStyle(ButtonStyle.Link).setURL(url));
  await message.reply({
    embeds: [ embed ],
    components: [ row ]
  });
}

async function saveDiscordTexRequest(token, message) {
  await db().query(`UPDATE tex_public_links\n     SET discord_guild_id = ?, discord_channel_id = ?, discord_message_id = ?, discord_requester_id = ?\n     WHERE token = ? LIMIT 1`, [ String(message.guildId || ""), String(message.channelId || ""), String(message.id || ""), String(message.author?.id || ""), token ]);
}

function canUseDiscordTex(message) {
  const channelId = String(process.env.TEX_CHANNEL_ID || "");
  if (!message.guild || message.author.bot) return false;
  if (!channelId || String(message.channelId) !== channelId) return false;
  return true;
}

async function startDiscordBot() {
  const botToken = cfg.DISCORD_BOT_TOKEN;
  const adminId = process.env.TEX_ADMIN_ID;
  const channelId = process.env.TEX_CHANNEL_ID;
  const baseUrl = texPublicUrl("");
  console.log("[DISCORD DEBUG] startDiscordBot called");
  console.log("[DISCORD DEBUG] token:", botToken ? "SET" : "MISSING");
  console.log("[DISCORD DEBUG] adminId:", adminId ? "SET" : "MISSING");
  console.log("[DISCORD DEBUG] channelId:", channelId ? "SET" : "MISSING");
  console.log("[DISCORD DEBUG] baseUrl:", baseUrl || "MISSING");
  console.log("[DISCORD DEBUG] voice channel:", cfg.DISCORD_VOICE_CHANNEL_ID || "MISSING");
  console.log("[DISCORD DEBUG] guild id:", cfg.DISCORD_GUILD_ID || "AUTO_FROM_LOG_CHANNEL");
  console.log("[DISCORD DEBUG] gmod:", `${cfg.GMOD_SERVER_HOST}:${cfg.GMOD_SERVER_PORT}`);
  if (!botToken) {
    console.log("[DISCORD] DISCORD_BOT_TOKEN не задан — Discord бот выключен.");
    return null;
  }
  const client = new Client({
    intents: [ GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers, GatewayIntentBits.DirectMessages ],
    partials: [ Partials.Channel ]
  });
  const texRateMap = new Map;
  const telegramToken = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
  const telegramAdminId = String(process.env.TELEGRAM_ADMIN_ID || "").trim();
  let telegramOffset = 0;
  async function tgApi(method, payload) {
    if (!telegramToken) return null;
    try {
      const r = await fetch(`https://api.telegram.org/bot${telegramToken}/${method}`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(payload || {})
      });
      return await r.json().catch(() => null);
    } catch (e) {
      console.error("[TEX TG] api error:", e.message);
      return null;
    }
  }
  function tgAllowed(id) {
    return telegramAdminId && String(id || "") === telegramAdminId;
  }
  async function handleTexDecision(token, approved, decidedByLabel) {
    const [upd] = await db().query("UPDATE tex_public_links SET status = ?, decided_by = ?, decided_at = UNIX_TIMESTAMP() WHERE token = ? AND status = 'pending' LIMIT 1", [ approved ? "approved" : "denied", String(decidedByLabel || "").slice(0, 128), token ]);
    const [[link]] = await db().query("SELECT steamid64, period_days, discord_channel_id, discord_message_id, discord_requester_id, status, decided_by FROM tex_public_links WHERE token = ? LIMIT 1", [ token ]);
    if (!link) return {
      ok: false,
      error: "NOT_FOUND"
    };
    if (!upd?.affectedRows) {
      return {
        ok: false,
        already: true,
        status: link.status || "unknown",
        decided_by: link.decided_by || "",
        link: link
      };
    }
    const url = texPublicUrl(`/public/tex/${token}`);
    const playerName = link?.steamid64 ? await getTexPlayerName(db(), link.steamid64) : "";
    if (approved && link.discord_channel_id) {
      const channel = await client.channels.fetch(String(link.discord_channel_id)).catch(() => null);
      if (channel?.isTextBased?.()) {
        const mention = link.discord_requester_id ? `<@${link.discord_requester_id}>` : "";
        const chEmbed = (new EmbedBuilder).setTitle("✅ TEX подтверждён").setDescription(`${mention}\n${playerName ? `**Ник:** ${playerName}\n` : ""}**SteamID64:** \`${link.steamid64}\`\n**Период:** ${link.period_days ? `${link.period_days} дн.` : "последние операции"}`.trim()).setColor(2278750).setTimestamp(new Date);
        const chRow = (new ActionRowBuilder).addComponents((new ButtonBuilder).setLabel("Перейти").setStyle(ButtonStyle.Link).setURL(url), (new ButtonBuilder).setLabel("Steam").setStyle(ButtonStyle.Link).setURL(`https://steamcommunity.com/profiles/${link.steamid64}`));
        const sent = await channel.send({
          embeds: [ chEmbed ],
          components: [ chRow ]
        });
        setTimeout(() => sent.delete().catch(() => {}), 60 * 1e3);
        if (link.discord_message_id) {
          setTimeout(async () => {
            const reqMsg = await channel.messages.fetch(String(link.discord_message_id)).catch(() => null);
            await (reqMsg?.delete().catch(() => {}));
          }, 60 * 1e3);
        }
      }
    }
    if (!approved && link.discord_channel_id) {
      const channel = await client.channels.fetch(String(link.discord_channel_id)).catch(() => null);
      if (channel?.isTextBased?.()) {
        const mention = link.discord_requester_id ? `<@${link.discord_requester_id}>` : "";
        const denyEmbed = (new EmbedBuilder).setTitle("❌ TEX отклонён").setDescription(`${mention}\n${playerName ? `**Ник:** ${playerName}\n` : ""}**SteamID64:** \`${link.steamid64}\``.trim()).setColor(15680580).setTimestamp(new Date);
        await channel.send({
          embeds: [ denyEmbed ]
        });
      }
    }
    return {
      ok: true,
      link: link,
      url: url,
      playerName: playerName
    };
  }
  async function sendTelegramTexRequest({token: token, ids: ids, periodDays: periodDays, playerName: playerName, logs: logs, moneyNet: moneyNet, donateNet: donateNet, suspiciousMoneyCount: suspiciousMoneyCount, suspiciousDonateCount: suspiciousDonateCount, requester: requester}) {
    if (!telegramToken || !telegramAdminId) return;
    const url = texPublicUrl(`/public/tex/${token}`);
    const text = [ "🧾 TEX запрос", "", playerName ? `Ник: ${playerName}` : "Ник: —", `SteamID64: ${ids.steamid64}`, `SteamID: ${ids.steamid}`, `Период: ${periodDays ? `${periodDays} дн.` : "последние"}`, `Запросил: ${requester}`, "", `Деньги итог: ${texMoney(moneyNet)} | ⚠ ${suspiciousMoneyCount}`, `Донат итог: ${texMoney(donateNet)} | ⚠ ${suspiciousDonateCount}`, "", url ].join("\n");
    await tgApi("sendMessage", {
      chat_id: telegramAdminId,
      text: text,
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [ [ {
          text: "✅ Выдать",
          callback_data: `tex_ok:${token}`
        }, {
          text: "❌ Отказать",
          callback_data: `tex_no:${token}`
        } ], [ {
          text: "Открыть выписку",
          url: url
        } ] ]
      }
    });
  }
  async function createTelegramTexDirect(msg, text) {
    if (!tgAllowed(msg.from?.id)) return;
    const parts = String(text || "").trim().split(/\s+/);
    const ids = normSteam(parts[1] || "");
    const periodDays = parseTexPeriod(parts[2] || "");
    if (!ids) {
      await tgApi("sendMessage", {
        chat_id: msg.chat.id,
        text: "Использование: /tex STEAMID [7дней]"
      });
      return;
    }
    const pool = db();
    const playerName = await getTexPlayerName(pool, ids.steamid64);
    const token = await createTexLink(pool, ids.steamid64, `telegram:${msg.from.id}`, periodDays);
    await pool.query("UPDATE tex_public_links SET discord_channel_id = ? WHERE token = ? LIMIT 1", [ String(channelId), token ]);
    const result = await handleTexDecision(token, true, `telegram:${msg.from.id}`);
    const url = texPublicUrl(`/public/tex/${token}`);
    await tgApi("sendMessage", {
      chat_id: msg.chat.id,
      text: result?.already ? `Этот запрос уже обработан: ${result.status}` : `✅ TEX создан и отправлен в Discord\n${playerName ? `Ник: ${playerName}\n` : ""}SteamID64: ${ids.steamid64}\nПериод: ${periodDays ? `${periodDays} дн.` : "последние"}\n${url}`,
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [ [ {
          text: "Открыть выписку",
          url: url
        }, {
          text: "Steam",
          url: `https://steamcommunity.com/profiles/${ids.steamid64}`
        } ] ]
      }
    });
  }
  async function startTelegramPolling() {
    if (!telegramToken || !telegramAdminId) {
      console.log("[TEX TG] TELEGRAM_BOT_TOKEN/TELEGRAM_ADMIN_ID не заданы — Telegram подтверждения выключены.");
      return;
    }
    console.log("[TEX TG] Telegram подтверждения включены.");
    const poll = async () => {
      const data = await tgApi("getUpdates", {
        offset: telegramOffset,
        timeout: 20,
        allowed_updates: [ "message", "callback_query" ]
      });
      if (!data?.ok || !Array.isArray(data.result)) return;
      for (const upd of data.result) {
        telegramOffset = Math.max(telegramOffset, Number(upd.update_id || 0) + 1);
        const msg = upd.message;
        if (msg?.text) {
          const text = String(msg.text || "").trim();
          const isPrivateChat = !msg.chat?.type || msg.chat.type === "private";
          const tgSend = p => {
            if (p && typeof p === "object" && p.text !== undefined) {
              return tgApi("sendMessage", {
                chat_id: msg.chat.id,
                text: p.text,
                parse_mode: "HTML",
                disable_web_page_preview: true,
                reply_markup: p.keyboard ? {
                  inline_keyboard: p.keyboard
                } : undefined
              });
            }
            return tgApi("sendMessage", {
              chat_id: msg.chat.id,
              text: String(p),
              parse_mode: "HTML",
              disable_web_page_preview: true
            });
          };
          const tgRequestConfirm = async pending => {
            await tgApi("sendMessage", {
              chat_id: msg.chat.id,
              text: telegramConfirmHtml(pending),
              parse_mode: "HTML",
              disable_web_page_preview: true,
              reply_markup: {
                inline_keyboard: [ [ {
                  text: pending.confirmYes || "✅ Подтвердить",
                  callback_data: `mod_yes:${pending.id}`
                }, {
                  text: "❌ Отмена",
                  callback_data: `mod_no:${pending.id}`
                } ] ]
              }
            });
          };
          if (/^(\/texinfo|!texinfo)\b/i.test(text)) {
            if (!tgAllowed(msg.from?.id)) continue;
            const token = await createTexInfoLink(db(), `telegram:${msg.from.id}`);
            const url = texPublicUrl(`/texinfo/${token}`);
            await tgApi("sendMessage", {
              chat_id: msg.chat.id,
              text: `🧾 <b>TEX info</b>\n${url}\n\nДоступ: только авторизованный KP. Активна 24 часа.`,
              parse_mode: "HTML",
              disable_web_page_preview: true,
              reply_markup: {
                inline_keyboard: [ [ {
                  text: "Открыть",
                  url: url
                } ] ]
              }
            });
          } else if (tgAllowed(msg.from?.id) && isPrivateChat && /^[!／\/](check|lookup|ban|warn|unban|unwarn|stats|help|start|props|ip|alts|giveprops|giveqmenu|revokeqmenu|givejob|revokejob|givemodel|revokemodel|jobs|models)\b/i.test(text)) {
            await runBotCommand({
              platform: "telegram",
              author: msg.from,
              content: text,
              send: tgSend,
              requestConfirm: tgRequestConfirm
            });
          } else if (/^\/tex\b/i.test(text)) {
            await createTelegramTexDirect(msg, text);
          }
        }
        const cb = upd.callback_query;
        const modCb = String(cb?.data || "").match(/^mod_(yes|no):([a-f0-9]{16})$/i);
        if (cb && modCb) {
          if (!tgAllowed(cb.from?.id)) {
            await tgApi("answerCallbackQuery", {
              callback_query_id: cb.id,
              text: "Нет доступа",
              show_alert: true
            });
            continue;
          }
          const out = await resolvePendingMod(modCb[2], modCb[1] === "yes");
          await tgApi("answerCallbackQuery", {
            callback_query_id: cb.id,
            text: out.status === "done" ? "✅ Выполнено" : out.status === "cancelled" ? "🚫 Отменено" : out.status === "expired" ? "⌛ Запрос устарел" : "❌ Ошибка",
            show_alert: out.status === "error"
          });
          if (cb.message?.chat?.id && cb.message?.message_id) {
            await tgApi("editMessageText", {
              chat_id: cb.message.chat.id,
              message_id: cb.message.message_id,
              text: telegramOutcomeHtml(out),
              parse_mode: "HTML",
              disable_web_page_preview: true,
              reply_markup: {
                inline_keyboard: []
              }
            });
          }
          continue;
        }
        if (cb?.data && /^tex_(ok|no):[a-f0-9]{32,64}$/i.test(cb.data)) {
          if (!tgAllowed(cb.from?.id)) {
            await tgApi("answerCallbackQuery", {
              callback_query_id: cb.id,
              text: "Нет доступа",
              show_alert: true
            });
            continue;
          }
          const [act, token] = String(cb.data).split(":");
          const approved = act === "tex_ok";
          const result = await handleTexDecision(token, approved, `telegram:${cb.from.id}`);
          if (result?.already) {
            await tgApi("answerCallbackQuery", {
              callback_query_id: cb.id,
              text: `Уже обработано: ${result.status}`,
              show_alert: true
            });
          } else {
            await tgApi("answerCallbackQuery", {
              callback_query_id: cb.id,
              text: approved ? "Подтверждено" : "Отказано"
            });
          }
          if (cb.message?.chat?.id && cb.message?.message_id) {
            await tgApi("editMessageText", {
              chat_id: cb.message.chat.id,
              message_id: cb.message.message_id,
              text: `${result?.already ? "⚠️ Уже обработано" : approved ? "✅ Подтверждено" : "❌ Отказано"}\n${result?.link?.steamid64 || ""} ${result?.status ? `(${result.status})` : ""}`,
              reply_markup: {
                inline_keyboard: []
              }
            });
          }
        }
      }
    };
    let tgPollStopped = false;
    const scheduleNextPoll = delay => {
      if (tgPollStopped) return;
      const t = setTimeout(runPoll, delay);
      t.unref?.();
    };
    async function runPoll() {
      if (tgPollStopped) return;
      let delay = 1e3;
      try {
        await poll();
      } catch (e) {
        console.error("[TEX TG] poll error:", e?.message || e);
        delay = 5e3;
      }
      scheduleNextPoll(delay);
    }
    runPoll();
  }
  client.once(Events.ClientReady, async () => {
    console.log(`[DISCORD] Logged in as ${client.user.tag}`);
    if (adminId && channelId && baseUrl) {
      console.log("[TEX BOT] TEX функции включены.");
      startTelegramPolling().catch(e => console.error("[TEX TG] start error:", e.message));
    } else {
      console.log("[TEX BOT] TEX функции пропущены: не хватает TEX env.");
    }
    startVoiceOnlineUpdater(client).catch(e => {
      console.error("[VOICE ONLINE] Startup error:", e?.message || e);
    });
  });
  client.on("messageCreate", async message => {
    try {
      const dmText = String(message.content || "").trim();
      if (!message.guild && adminId && isAdminDiscordId(message.author?.id, adminId)) {
        const handled = await runBotCommand({
          platform: "discord",
          author: message.author,
          content: dmText,
          send: async payload => {
            if (payload instanceof EmbedBuilder) return message.reply({
              embeds: [ payload ]
            });
            if (payload && typeof payload === "object" && payload.embeds) {
              return message.reply({
                embeds: payload.embeds,
                components: payload.components || []
              });
            }
            return message.reply(String(payload));
          },
          requestConfirm: async pending => {
            await message.reply({
              embeds: [ discordConfirmEmbed(pending) ],
              components: [ discordConfirmRow(pending.id) ]
            });
          }
        });
        if (handled) return;
      }
      if (!adminId || !channelId || !baseUrl) return;
      if (message.partial) {
        try {
          await message.fetch();
        } catch (e) {
          console.error("[TEX BOT] partial message fetch failed:", e?.message || e);
          return;
        }
      }
      const content = String(message.content || "").trim();
      if (/^!texinfo\b/i.test(content)) {
        if (!message.guild && isAdminDiscordId(message.author?.id, adminId)) {
          await sendTexInfo(message);
        }
        return;
      }
      if (!/^!tex\b/i.test(content)) return;
      if (!canUseDiscordTex(message)) return;
      if (!texRateAllowed(texRateMap, message.author.id)) {
        await message.reply("Лимит: 5 TEX запросов за 5 минут.").catch(() => {});
        return;
      }
      const parts = content.split(/\s+/);
      const ids = normSteam(parts[1] || "");
      const periodDays = parseTexPeriod(parts[2] || "");
      if (!ids) {
        await message.reply("Использование: `!tex STEAMID` или `!tex STEAM_0:1:12345 7дней`");
        return;
      }
      const pool = db();
      const playerName = await getTexPlayerName(pool, ids.steamid64);
      const token = await createTexLink(pool, ids.steamid64, `discord:${message.author.id}`, periodDays);
      await saveDiscordTexRequest(token, message);
      const logs = await getTexLogs(pool, ids.steamid64, 200, periodDays);
      const suspiciousMoneyCount = logs.money.filter(x => Math.abs(Number(x.money || 0)) >= 1e7 || /Передача денег|TakeMoney|AddMoney|списание|начисление/i.test(String(x.description || ""))).length;
      const suspiciousDonateCount = logs.donate.filter(x => Math.abs(Number(x.sum || 0)) >= 1e6 || /given by|reward|refund|возврат|ручн|admin/i.test(String(x.note || ""))).length;
      const moneyNet = Number(logs.totals.money_income || 0) + Number(logs.totals.money_expense || 0);
      const donateNet = Number(logs.totals.donate_income || 0) + Number(logs.totals.donate_expense || 0);
      const embed = (new EmbedBuilder).setTitle("TEX запрос").setDescription([ playerName ? `**${playerName}**` : "Ник не найден", `\`${ids.steamid64}\` / \`${ids.steamid}\``, `Период: **${periodDays ? `${periodDays} дн.` : "последние"}**`, `Запросил: ${message.author}` ].join("\n")).addFields({
        name: "Деньги",
        value: `Итог: **${texMoney(moneyNet)}**\n⚠ ${suspiciousMoneyCount}`,
        inline: true
      }, {
        name: "Донат",
        value: `Итог: **${texMoney(donateNet)}**\n⚠ ${suspiciousDonateCount}`,
        inline: true
      }).setColor(suspiciousMoneyCount + suspiciousDonateCount > 0 ? 16486972 : 2278750).setFooter({
        text: "✅ отправить · ❌ отказать"
      }).setTimestamp(new Date);
      const row = (new ActionRowBuilder).addComponents((new ButtonBuilder).setCustomId(`tex_ok:${token}`).setLabel("Выдать").setEmoji("✅").setStyle(ButtonStyle.Success), (new ButtonBuilder).setCustomId(`tex_no:${token}`).setLabel("Отказать").setEmoji("❌").setStyle(ButtonStyle.Danger));
      const admin = await client.users.fetch(adminId);
      await admin.send({
        embeds: [ embed ],
        components: [ row ]
      });
      await sendTelegramTexRequest({
        token: token,
        ids: ids,
        periodDays: periodDays,
        playerName: playerName,
        logs: logs,
        moneyNet: moneyNet,
        donateNet: donateNet,
        suspiciousMoneyCount: suspiciousMoneyCount,
        suspiciousDonateCount: suspiciousDonateCount,
        requester: `${message.author.tag} (${message.author.id})`
      });
      await message.react("📨").catch(() => {});
    } catch (e) {
      console.error("[TEX BOT] messageCreate error:", e);
      try {
        await message.reply("Ошибка при создании TEX запроса.");
      } catch {}
    }
  });
  client.on("interactionCreate", async interaction => {
    if (!interaction.isButton()) return;
    try {
      const modMatch = String(interaction.customId || "").match(/^mod_(yes|no):([a-f0-9]{16})$/);
      if (modMatch) {
        if (String(interaction.user.id) !== String(adminId)) {
          await interaction.reply({
            content: "Нет доступа.",
            ephemeral: true
          }).catch(() => {});
          return;
        }
        const out = await resolvePendingMod(modMatch[2], modMatch[1] === "yes");
        const embed = discordOutcomeEmbed(out);
        await interaction.update({
          embeds: [ embed ],
          components: []
        }).catch(async () => {
          await interaction.reply({
            embeds: [ embed ],
            ephemeral: true
          }).catch(() => {});
        });
        return;
      }
      if (!adminId || !channelId || !baseUrl) return;
      const [action, token] = String(interaction.customId || "").split(":");
      if (!/^tex_(ok|no)$/.test(action) || !/^[a-f0-9]{32,64}$/i.test(token || "")) return;
      if (String(interaction.user.id) !== String(adminId)) {
        await interaction.reply({
          content: "Нет доступа.",
          ephemeral: true
        });
        return;
      }
      const approved = action === "tex_ok";
      const decision = await handleTexDecision(token, approved, `discord:${interaction.user.id}`);
      if (decision?.already) {
        await interaction.reply({
          content: `Этот запрос уже обработан: ${decision.status}`,
          ephemeral: true
        }).catch(() => {});
        return;
      }
      const old = interaction.message;
      const embed = EmbedBuilder.from(old.embeds[0] || {}).setColor(approved ? 2278750 : 15680580).addFields({
        name: "Решение",
        value: `${approved ? "✅ Подтверждено, ссылка отправлена в канал" : "❌ Отказано"} · ${interaction.user.tag}`,
        inline: false
      });
      const disabled = (new ActionRowBuilder).addComponents(ButtonBuilder.from(old.components[0].components[0]).setDisabled(true), ButtonBuilder.from(old.components[0].components[1]).setDisabled(true));
      await interaction.update({
        embeds: [ embed ],
        components: [ disabled ]
      });
      if (approved) setTimeout(() => interaction.message.delete().catch(() => {}), 60 * 1e3);
    } catch (e) {
      console.error("[TEX BOT] interaction error:", e);
      try {
        await interaction.reply({
          content: "Ошибка обработки кнопки.",
          ephemeral: true
        });
      } catch {}
    }
  });
  client.on("error", e => {
    console.error("[DISCORD] Client error:", e);
  });
  try {
    console.log("[DISCORD DEBUG] trying client.login...");
    setDiscordClient(client);
    const LOGIN_TIMEOUT_MS = 45 * 1e3;
    const timeout = new Promise((_resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`login timeout after ${LOGIN_TIMEOUT_MS / 1e3}s`)), LOGIN_TIMEOUT_MS);
      t.unref?.();
    });
    await Promise.race([ client.login(botToken), timeout ]);
    console.log("[DISCORD DEBUG] client.login success");
    return client;
  } catch (e) {
    console.error("[DISCORD] Login error:", e.message || e);
    try {
      await client.destroy();
    } catch {}
    setDiscordClient(null);
    return null;
  }
}

async function startVoiceOnlineUpdater(client) {
  if (!client) {
    console.log("[VOICE ONLINE] Discord client unavailable.");
    return;
  }
  if (!cfg.DISCORD_VOICE_CHANNEL_ID) {
    console.log("[VOICE ONLINE] DISCORD_VOICE_CHANNEL_ID не задан.");
    return;
  }
  let lastVoiceName = null;
  async function queryGmodOnline() {
    return new Promise(resolve => {
      const socket = dgram.createSocket("udp4");
      const finish = result => {
        try {
          socket.close();
        } catch {}
        resolve(result);
      };
      const timeout = setTimeout(() => {
        finish({
          players: 0,
          maxPlayers: 100
        });
      }, 1e4);
      const payload = Buffer.concat([ Buffer.from([ 255, 255, 255, 255 ]), Buffer.from("TSource Engine Query\0", "utf8") ]);
      socket.on("message", msg => {
        try {
          clearTimeout(timeout);
          if (!msg || msg.length < 6) {
            return finish({
              players: 0,
              maxPlayers: 100
            });
          }
          let offset = 0;
          offset += 4;
          const header = msg.readUInt8(offset);
          offset += 1;
          if (header === 65) {
            const challenge = msg.subarray(offset, offset + 4);
            const retryPayload = Buffer.concat([ Buffer.from([ 255, 255, 255, 255 ]), Buffer.from("TSource Engine Query\0", "utf8"), challenge ]);
            socket.send(retryPayload, cfg.GMOD_SERVER_PORT, cfg.GMOD_SERVER_HOST);
            return;
          }
          if (header !== 73) {
            return finish({
              players: 0,
              maxPlayers: 100
            });
          }
          offset += 1;
          const readString = () => {
            let end = offset;
            while (end < msg.length && msg[end] !== 0) end++;
            const value = msg.toString("utf8", offset, end);
            offset = end + 1;
            return value;
          };
          readString();
          readString();
          readString();
          readString();
          offset += 2;
          const players = msg.readUInt8(offset);
          offset += 1;
          const maxPlayers = msg.readUInt8(offset);
          offset += 1;
          return finish({
            players: Number.isFinite(players) ? players : 0,
            maxPlayers: Number.isFinite(maxPlayers) ? maxPlayers : 100
          });
        } catch (error) {
          console.error("[VOICE ONLINE] Parse error:", error?.message || error);
          return finish({
            players: 0,
            maxPlayers: 100
          });
        }
      });
      socket.on("error", error => {
        clearTimeout(timeout);
        console.error("[VOICE ONLINE] UDP error:", error?.message || error);
        return finish({
          players: 0,
          maxPlayers: 100
        });
      });
      socket.send(payload, cfg.GMOD_SERVER_PORT, cfg.GMOD_SERVER_HOST, error => {
        if (error) {
          clearTimeout(timeout);
          console.error("[VOICE ONLINE] UDP send error:", error?.message || error);
          return finish({
            players: 0,
            maxPlayers: 100
          });
        }
      });
    });
  }
  async function updateVoiceChannelName() {
    try {
      const channel = await client.channels.fetch(cfg.DISCORD_VOICE_CHANNEL_ID).catch(() => null);
      if (!channel) {
        console.error("[VOICE ONLINE] Voice channel not found:", cfg.DISCORD_VOICE_CHANNEL_ID);
        return;
      }
      const {players: players, maxPlayers: maxPlayers} = await queryGmodOnline();
      const newName = `${cfg.VOICE_CHANNEL_PREFIX} ${players}/${maxPlayers}`;
      if (lastVoiceName === newName || channel.name === newName) return;
      await channel.setName(newName);
      lastVoiceName = newName;
      console.log(`[VOICE ONLINE] Updated: ${newName}`);
    } catch (error) {
      console.error("[VOICE ONLINE] Failed to update channel:", error?.message || error);
    }
  }
  await updateVoiceChannelName();
  setInterval(() => {
    updateVoiceChannelName().catch(error => {
      console.error("[VOICE ONLINE] Interval error:", error?.message || error);
    });
  }, cfg.VOICE_CHANNEL_UPDATE_MS).unref?.();
}

async function start() {
  console.log("[START DEBUG] start() called");
  const server = app.listen(cfg.PORT, () => {
    console.log(`VibeRP Panel running on port ${cfg.PORT}`);
  });
  server.on("error", e => {
    if (e?.code === "EADDRINUSE") {
      console.error(`[FATAL] Port ${cfg.PORT} is already in use (old process still running?).`);
      console.error(`[FATAL] Find and stop it:  lsof -i :${cfg.PORT}   or   fuser -k ${cfg.PORT}/tcp`);
    } else {
      console.error("[FATAL] HTTP server error:", e?.message || e);
    }
    process.exit(1);
  });
  let dbReady = false;
  try {
    initPool(cfg);
    app.locals.cfg = cfg;
    app.locals.db = db;
    await ensurePanelSchema();
    await ensureTexLinkColumns(db());
    await loadLocks();
    setWarnLogChannelId(cfg.DISCORD_WARN_LOG_CHANNEL_ID);
    setSteamApiKey(cfg.STEAM_API_KEY);
    setServerName(cfg.WARN_SERVER_NAME);
    dbReady = true;
    startupState.dbReady = true;
    console.log("DB connected");
  } catch (e) {
    console.error("DB init error:", e.message);
    process.exit(1);
  }
  try {
    await startDiscordBot();
  } catch (e) {
    console.error("[DISCORD] start error (site keeps running):", e?.message || e);
  }
  let shuttingDown = false;
  async function shutdown(signal, exitCode = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[WORKER] ${signal} received. Graceful shutdown…`);
    server.closeIdleConnections?.();
    const forceConnTimer = setTimeout(() => {
      server.closeAllConnections?.();
    }, 1e4);
    forceConnTimer.unref?.();
    server.close(async () => {
      clearTimeout(forceConnTimer);
      try {
        const {flushOnlineToDisk: flushOnlineToDisk} = await import("./lib/helpers.js");
        await flushOnlineToDisk();
        console.log("[WORKER] Online data flushed to disk.");
      } catch (e) {
        console.error("[WORKER] Failed to flush online:", e.message);
      }
      try {
        const pool = db();
        if (pool && typeof pool.end === "function") {
          await pool.end();
          console.log("[WORKER] DB pool closed.");
        }
      } catch (e) {
        console.error("[WORKER] Error closing pool:", e.message);
      }
      console.log("[WORKER] Exiting.");
      process.exit(exitCode);
    });
    setTimeout(() => {
      console.error("[WORKER] Forced exit after timeout.");
      process.exit(exitCode || 1);
    }, 25e3);
  }
  gracefulShutdown = shutdown;
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

start();
