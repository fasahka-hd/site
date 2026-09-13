import mysql from "mysql2/promise";

let pool = null;

function initPool(cfg) {
  pool = mysql.createPool({
    host: cfg.DB_HOST,
    port: cfg.DB_PORT || 3306,
    user: cfg.DB_USER,
    password: cfg.DB_PASS,
    database: cfg.DB_NAME,
    charset: "utf8mb4",
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 100,
    connectTimeout: 2e4,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
    maxIdle: 10,
    idleTimeout: 6e4,
    supportBigNumbers: true,
    bigNumberStrings: true
  });
  return pool;
}

function db() {
  if (!pool) throw new Error("DB pool not initialized");
  return pool;
}

const _colCache = new Map;

function invalidateColumnCache() {
  _colCache.clear();
}

async function hasColumnCached(table, col) {
  const key = table + "." + col;
  if (_colCache.has(key)) return _colCache.get(key);
  let result = false;
  try {
    const [rows] = await db().query("SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1", [ table, col ]);
    result = rows.length > 0;
    _colCache.set(key, result);
  } catch (e) {
    console.error("[DB] column cache check error:", e && e.message ? e.message : e);
  }
  return result;
}

async function hasColumn(table, col) {
  const [rows] = await db().query("SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1", [ table, col ]);
  return rows.length > 0;
}

const VALID_TABLE_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,64}$/;

const VALID_COL_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,64}$/;

function validateId(name, regex) {
  if (!regex.test(name)) throw new Error(`Invalid SQL identifier: ${name}`);
  return name;
}

const IDENT = "[a-zA-Z_][a-zA-Z0-9_]{0,63}";

const STR_LIT = "'[^'\\\\]{0,255}'";

const COLUMN_DEF_RE = new RegExp("^" + "(?:" + "(?:TINYINT|SMALLINT|MEDIUMINT|INT|INTEGER|BIGINT)(?:\\(\\d{1,3}\\))?(?:\\s+UNSIGNED)?" + "|(?:DECIMAL|NUMERIC|FLOAT|DOUBLE)(?:\\(\\d{1,3}(?:,\\d{1,3})?\\))?(?:\\s+UNSIGNED)?" + "|(?:VARCHAR|CHAR|VARBINARY|BINARY)\\(\\d{1,5}\\)" + "|(?:TINYTEXT|TEXT|MEDIUMTEXT|LONGTEXT|TINYBLOB|BLOB|MEDIUMBLOB|LONGBLOB|JSON|DATE|TIME|YEAR)" + "|(?:TIMESTAMP|DATETIME)(?:\\(\\d\\))?" + `|ENUM\\(${STR_LIT}(?:\\s*,\\s*${STR_LIT})*\\)` + ")" + "(?:\\s+(?:NOT\\s+NULL|NULL))?" + `(?:\\s+DEFAULT\\s+(?:NULL|CURRENT_TIMESTAMP(?:\\(\\d\\))?|-?\\d{1,20}(?:\\.\\d{1,10})?|${STR_LIT}))?` + "(?:\\s+ON\\s+UPDATE\\s+CURRENT_TIMESTAMP(?:\\(\\d\\))?)?" + `(?:\\s+(?:FIRST|AFTER\\s+${IDENT}))?` + "$", "i");

function validateColumnDef(def) {
  const s = String(def == null ? "" : def).trim().replace(/\s+/g, " ");
  if (!s || s.length > 200) throw new Error(`Invalid column definition: ${def}`);
  if (/[;`\\]|--|\/\*|\*\/|\x00/.test(s)) {
    throw new Error(`Invalid column definition: ${def}`);
  }
  if (!COLUMN_DEF_RE.test(s)) throw new Error(`Invalid column definition: ${def}`);
  return s;
}

const IGNORABLE_DDL_CODES = new Set([ "ER_TABLE_EXISTS_ERROR", "ER_DUP_FIELDNAME", "ER_DUP_KEYNAME", "ER_MULTIPLE_PRI_KEY" ]);

const FATAL_DDL_CODES = new Set([ "ER_ACCESS_DENIED_ERROR", "ER_DBACCESS_DENIED_ERROR", "ER_TABLEACCESS_DENIED_ERROR", "ER_COLUMNACCESS_DENIED_ERROR", "ER_BAD_DB_ERROR", "ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "PROTOCOL_CONNECTION_LOST" ]);

async function runDDL(conn, sql, label) {
  try {
    await conn.query(sql);
  } catch (e) {
    const code = e?.code || "";
    if (IGNORABLE_DDL_CODES.has(code)) return;
    if (FATAL_DDL_CODES.has(code)) {
      console.error(`[DB] FATAL during schema init (${label}): ${e.message}`);
      throw e;
    }
    console.error(`[DB] Schema step failed (${label}): ${e.message}`);
  }
}

async function ensureIndexes() {
  const conn = db();
  const indexes = [ [ "ba_bans", "idx_ban_time", [ "ban_time" ] ], [ "ba_bans", "idx_steamid", [ "steamid" ] ], [ "ba_iplog", "idx_iplog_steamid", [ "steamid" ] ], [ "ba_iplog", "idx_iplog_lastseen", [ "lastseen" ] ], [ "web_users", "idx_web_users_role", [ "role" ] ], [ "ba_users", "idx_ba_users_lastseen", [ "lastseen" ] ], [ "ba_ranks", "idx_ba_ranks_steamid", [ "steamid" ] ], [ "chsp_list", "idx_chsp_sid_active", [ "steamid64", "active" ] ] ];
  for (const [table, indexName, cols] of indexes) {
    try {
      const t = validateId(table, VALID_TABLE_RE);
      const idx = validateId(indexName, VALID_COL_RE);
      const colList = cols.map(c => validateId(c, VALID_COL_RE)).join(", ");
      const [rows] = await conn.query("SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1", [ table, indexName ]);
      if (!rows.length) {
        await conn.query(`ALTER TABLE ${t} ADD INDEX ${idx} (${colList})`);
        console.log(`[DB] Added index ${idx} on ${t}`);
      }
    } catch (e) {
      if (e?.code !== "ER_DUP_KEYNAME") {
        console.error(`[DB] Failed to add index ${indexName} on ${table}:`, e.message);
      }
    }
  }
}

async function safeAddColumn(table, col, def) {
  const t = validateId(table, VALID_TABLE_RE);
  const c = validateId(col, VALID_COL_RE);
  const d = validateColumnDef(def);
  if (!await hasColumnCached(t, c)) {
    try {
      await db().query(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`);
      _colCache.delete(`${t}.${c}`);
    } catch (e) {
      if (e?.code !== "ER_DUP_FIELDNAME") {
        console.error(`[DB] Failed to add column ${t}.${c}:`, e.message);
      }
    }
  }
}

async function ensurePanelSchema() {
  const conn = db();
  await runDDL(conn, `CREATE TABLE IF NOT EXISTS web_users (\n    id INT UNSIGNED NOT NULL AUTO_INCREMENT,\n    steamid64 VARCHAR(20) NOT NULL,\n    nickname VARCHAR(32) NULL DEFAULT '',\n    role VARCHAR(64) NOT NULL DEFAULT 'Главный Администратор',\n    password_hash VARCHAR(255) NOT NULL,\n    added_at INT NOT NULL DEFAULT 0,\n    PRIMARY KEY (id),\n    UNIQUE KEY uq_web_users_steamid64 (steamid64)\n  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`, "CREATE TABLE web_users");
  await runDDL(conn, `CREATE TABLE IF NOT EXISTS chsp_list (\n    id INT UNSIGNED NOT NULL AUTO_INCREMENT,\n    steamid64 VARCHAR(20) NOT NULL,\n    steamid VARCHAR(32) DEFAULT NULL,\n    nickname VARCHAR(64) DEFAULT NULL,\n    ip VARCHAR(45) DEFAULT NULL,\n    reason VARCHAR(255) DEFAULT NULL,\n    added_by VARCHAR(64) DEFAULT NULL,\n    active TINYINT(1) NOT NULL DEFAULT 1,\n    added_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,\n    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,\n    PRIMARY KEY (id),\n    UNIQUE KEY uq_chsp_steamid64 (steamid64),\n    KEY idx_chsp_active (active),\n    KEY idx_chsp_ip (ip)\n  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`, "CREATE TABLE chsp_list");
  if (!await hasColumnCached("web_users", "nickname")) {
    await runDDL(conn, "ALTER TABLE web_users ADD COLUMN nickname VARCHAR(32) NULL DEFAULT '' AFTER steamid64", "ALTER TABLE web_users ADD nickname");
  }
  await runDDL(conn, `CREATE TABLE IF NOT EXISTS panel_models (\n    id INT UNSIGNED NOT NULL AUTO_INCREMENT,\n    name VARCHAR(255) NOT NULL DEFAULT '',\n    model_path VARCHAR(255) NOT NULL,\n    workshop_id BIGINT UNSIGNED DEFAULT NULL,\n    icon_url VARCHAR(512) DEFAULT NULL,\n    size_bytes BIGINT DEFAULT NULL,\n    is_active TINYINT(1) NOT NULL DEFAULT 1,\n    created_by VARCHAR(64) DEFAULT NULL,\n    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,\n    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,\n    hidden_by VARCHAR(64) DEFAULT NULL,\n    hidden_at TIMESTAMP NULL DEFAULT NULL,\n    PRIMARY KEY (id),\n    UNIQUE KEY uq_model_path (model_path)\n  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`, "CREATE TABLE panel_models");
  const modelCols = [ [ "panel_models", "name", "VARCHAR(255) NOT NULL DEFAULT '' AFTER id" ], [ "panel_models", "title", "VARCHAR(255) NOT NULL DEFAULT '' AFTER model_path" ], [ "panel_models", "workshop_id", "BIGINT UNSIGNED DEFAULT NULL AFTER title" ], [ "panel_models", "icon_url", "VARCHAR(512) DEFAULT NULL AFTER workshop_id" ], [ "panel_models", "size_bytes", "BIGINT DEFAULT NULL AFTER icon_url" ], [ "panel_models", "is_active", "TINYINT(1) NOT NULL DEFAULT 1 AFTER size_bytes" ], [ "panel_models", "created_by", "VARCHAR(64) DEFAULT NULL AFTER is_active" ], [ "panel_models", "hidden_by", "VARCHAR(64) DEFAULT NULL AFTER updated_at" ], [ "panel_models", "hidden_at", "TIMESTAMP NULL DEFAULT NULL AFTER hidden_by" ] ];
  for (const [tbl, col, def] of modelCols) {
    await safeAddColumn(tbl, col, def);
  }
  await runDDL(conn, `CREATE TABLE IF NOT EXISTS panel_player_models (\n    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,\n    steamid32 VARCHAR(32) NOT NULL,\n    model_id INT UNSIGNED NOT NULL,\n    issued_by VARCHAR(64) NOT NULL DEFAULT '',\n    issued_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,\n    given_by VARCHAR(64) DEFAULT NULL,\n    given_at TIMESTAMP NULL DEFAULT NULL,\n    PRIMARY KEY (id),\n    UNIQUE KEY uq_player_model (steamid32, model_id),\n    KEY idx_player (steamid32),\n    KEY idx_model (model_id)\n  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`, "CREATE TABLE panel_player_models");
  const pmCols = [ [ "panel_player_models", "steamid32", "VARCHAR(32) NOT NULL" ], [ "panel_player_models", "model_id", "INT UNSIGNED NOT NULL" ], [ "panel_player_models", "issued_by", "VARCHAR(64) NOT NULL DEFAULT ''" ], [ "panel_player_models", "issued_at", "TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP" ], [ "panel_player_models", "given_by", "VARCHAR(64) DEFAULT NULL" ], [ "panel_player_models", "given_at", "TIMESTAMP NULL DEFAULT NULL" ] ];
  for (const [tbl, col, def] of pmCols) {
    await safeAddColumn(tbl, col, def);
  }
  await runDDL(conn, `CREATE TABLE IF NOT EXISTS admin_logs (\n    id INT UNSIGNED NOT NULL AUTO_INCREMENT,\n    admin_steamid64 VARCHAR(20) NOT NULL,\n    action VARCHAR(64) NOT NULL,\n    target VARCHAR(255) DEFAULT NULL,\n    details TEXT DEFAULT NULL,\n    timestamp INT NOT NULL,\n    PRIMARY KEY (id),\n    KEY idx_admin (admin_steamid64),\n    KEY idx_ts (timestamp)\n  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`, "CREATE TABLE admin_logs");
  await runDDL(conn, `CREATE TABLE IF NOT EXISTS tex_info_links (\n    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,\n    token VARCHAR(64) NOT NULL,\n    requested_by VARCHAR(128) DEFAULT NULL,\n    created_at INT NOT NULL DEFAULT 0,\n    expires_at INT NOT NULL DEFAULT 0,\n    PRIMARY KEY (id),\n    UNIQUE KEY uq_tex_info_token (token),\n    KEY idx_tex_info_expires_at (expires_at)\n  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`, "CREATE TABLE tex_info_links");
  await runDDL(conn, `CREATE TABLE IF NOT EXISTS tex_public_links (\n    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,\n    token VARCHAR(64) NOT NULL,\n    steamid64 VARCHAR(20) NOT NULL,\n    requested_by VARCHAR(128) DEFAULT NULL,\n    discord_guild_id VARCHAR(32) DEFAULT NULL,\n    discord_channel_id VARCHAR(32) DEFAULT NULL,\n    discord_message_id VARCHAR(32) DEFAULT NULL,\n    discord_requester_id VARCHAR(32) DEFAULT NULL,\n    period_days INT UNSIGNED DEFAULT NULL,\n    expires_at INT NOT NULL DEFAULT 0,\n    created_at INT NOT NULL DEFAULT 0,\n    status ENUM('pending','approved','denied') NOT NULL DEFAULT 'pending',\n    decided_by VARCHAR(128) DEFAULT NULL,\n    decided_at INT DEFAULT NULL,\n    PRIMARY KEY (id),\n    UNIQUE KEY uq_tex_token (token),\n    KEY idx_tex_steamid64 (steamid64),\n    KEY idx_tex_created_at (created_at),\n    KEY idx_tex_expires_at (expires_at),\n    KEY idx_tex_discord_channel (discord_channel_id)\n  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`, "CREATE TABLE tex_public_links");
  const texCols = [ [ "tex_public_links", "discord_guild_id", "VARCHAR(32) DEFAULT NULL" ], [ "tex_public_links", "discord_channel_id", "VARCHAR(32) DEFAULT NULL" ], [ "tex_public_links", "discord_message_id", "VARCHAR(32) DEFAULT NULL" ], [ "tex_public_links", "discord_requester_id", "VARCHAR(32) DEFAULT NULL" ], [ "tex_public_links", "period_days", "INT UNSIGNED DEFAULT NULL" ], [ "tex_public_links", "expires_at", "INT NOT NULL DEFAULT 0" ] ];
  for (const [tbl, col, def] of texCols) {
    await safeAddColumn(tbl, col, def);
  }
  await runDDL(conn, `CREATE TABLE IF NOT EXISTS panel_weapons (\n    id INT UNSIGNED NOT NULL AUTO_INCREMENT,\n    name VARCHAR(255) NOT NULL DEFAULT '',\n    weapon_class VARCHAR(255) NOT NULL,\n    workshop_id BIGINT UNSIGNED DEFAULT NULL,\n    icon_url VARCHAR(512) DEFAULT NULL,\n    is_active TINYINT(1) NOT NULL DEFAULT 1,\n    created_by VARCHAR(64) DEFAULT NULL,\n    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,\n    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,\n    PRIMARY KEY (id),\n    UNIQUE KEY uq_weapon_class (weapon_class)\n  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`, "CREATE TABLE panel_weapons");
  await runDDL(conn, `CREATE TABLE IF NOT EXISTS panel_player_weapons (\n    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,\n    steamid32 VARCHAR(32) NOT NULL,\n    weapon_id INT UNSIGNED NOT NULL,\n    issued_by VARCHAR(64) NOT NULL DEFAULT '',\n    issued_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,\n    PRIMARY KEY (id),\n    UNIQUE KEY uq_player_weapon (steamid32, weapon_id),\n    KEY idx_player (steamid32),\n    KEY idx_weapon (weapon_id)\n  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`, "CREATE TABLE panel_player_weapons");
  await runDDL(conn, `CREATE TABLE IF NOT EXISTS chsp_ip_list (\n    id INT NOT NULL AUTO_INCREMENT,\n    ip VARCHAR(45) NOT NULL,\n    reason VARCHAR(255) DEFAULT NULL,\n    added_by VARCHAR(32) DEFAULT NULL,\n    added_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,\n    active TINYINT(1) NOT NULL DEFAULT 1,\n    PRIMARY KEY (id),\n    UNIQUE KEY ip (ip)\n  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`, "CREATE TABLE chsp_ip_list");
  await runDDL(conn, `CREATE TABLE IF NOT EXISTS panel_jobs (\n    id INT UNSIGNED NOT NULL AUTO_INCREMENT,\n    name VARCHAR(255) NOT NULL DEFAULT '',\n    job_command VARCHAR(255) NOT NULL,\n    is_active TINYINT(1) NOT NULL DEFAULT 1,\n    created_by VARCHAR(64) DEFAULT NULL,\n    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,\n    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,\n    PRIMARY KEY (id),\n    UNIQUE KEY uq_job_command (job_command)\n  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`, "CREATE TABLE panel_jobs");
  await runDDL(conn, `CREATE TABLE IF NOT EXISTS panel_player_jobs (\n    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,\n    steamid32 VARCHAR(32) NOT NULL,\n    job_id INT UNSIGNED NOT NULL,\n    given_by VARCHAR(64) NOT NULL DEFAULT '',\n    given_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,\n    PRIMARY KEY (id),\n    UNIQUE KEY uq_player_job (steamid32, job_id),\n    KEY idx_player (steamid32),\n    KEY idx_job (job_id)\n  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`, "CREATE TABLE panel_player_jobs");
  await runDDL(conn, `CREATE TABLE IF NOT EXISTS panel_player_qmenu (\n    steamid32 VARCHAR(32) NOT NULL,\n    access_type VARCHAR(32) NOT NULL,\n    issued_by VARCHAR(64) NOT NULL DEFAULT '',\n    issued_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,\n    PRIMARY KEY (steamid32, access_type),\n    KEY idx_player (steamid32)\n  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`, "CREATE TABLE panel_player_qmenu");
  await runDDL(conn, `CREATE TABLE IF NOT EXISTS panel_player_access (\n    steamid32 VARCHAR(32) NOT NULL,\n    props_extra INT UNSIGNED NOT NULL DEFAULT 0,\n    setmodel TINYINT(1) NOT NULL DEFAULT 0,\n    issued_by VARCHAR(64) NOT NULL DEFAULT '',\n    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,\n    PRIMARY KEY (steamid32)\n  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`, "CREATE TABLE panel_player_access");
  await runDDL(conn, `CREATE TABLE IF NOT EXISTS donate_discord_users (\n    steamid64 VARCHAR(64) NOT NULL,\n    discord_id VARCHAR(64) DEFAULT NULL,\n    discord_username VARCHAR(128) DEFAULT NULL,\n    role_synced TINYINT(1) DEFAULT 0,\n    linked_time INT DEFAULT 0,\n    PRIMARY KEY (steamid64)\n  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`, "CREATE TABLE donate_discord_users");
  await runDDL(conn, `ALTER TABLE donate_discord_users ADD COLUMN IF NOT EXISTS discord_username VARCHAR(128) DEFAULT NULL`, "ALTER TABLE donate_discord_users ADD discord_username");
  await runDDL(conn, `ALTER TABLE donate_discord_users ADD COLUMN IF NOT EXISTS last_rank VARCHAR(64) DEFAULT NULL`, "ALTER TABLE donate_discord_users ADD last_rank");
  await runDDL(conn, `ALTER TABLE donate_discord_users ADD COLUMN IF NOT EXISTS last_sync_time INT DEFAULT 0`, "ALTER TABLE donate_discord_users ADD last_sync_time");
  await runDDL(conn, `CREATE TABLE IF NOT EXISTS donate_discord_pending (\n    hash VARCHAR(64) NOT NULL,\n    steamid64 VARCHAR(64) DEFAULT NULL,\n    created INT DEFAULT 0,\n    expires INT DEFAULT 0,\n    PRIMARY KEY (hash)\n  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`, "CREATE TABLE donate_discord_pending");
  await runDDL(conn, `CREATE TABLE IF NOT EXISTS web_login_attempts (\n    ip VARCHAR(64) NOT NULL,\n    attempts INT UNSIGNED NOT NULL DEFAULT 0,\n    window_start BIGINT UNSIGNED NOT NULL DEFAULT 0,\n    PRIMARY KEY (ip)\n  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`, "CREATE TABLE web_login_attempts");
  await runDDL(conn, `CREATE TABLE IF NOT EXISTS command_queue (\n    id VARCHAR(64) NOT NULL PRIMARY KEY,\n    type VARCHAR(16) NOT NULL DEFAULT 'console',\n    text VARCHAR(512) NOT NULL DEFAULT '',\n    admin_steamid64 VARCHAR(20) DEFAULT NULL,\n    done TINYINT(1) NOT NULL DEFAULT 0,\n    processing TINYINT(1) NOT NULL DEFAULT 0,\n    processing_time INT DEFAULT 0,\n    time INT DEFAULT 0,\n    tries INT DEFAULT 0,\n    done_time INT DEFAULT 0,\n    error VARCHAR(64) DEFAULT NULL\n  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`, "CREATE TABLE command_queue");
  await ensureIndexes();
  invalidateColumnCache();
}

export { db, ensurePanelSchema, hasColumnCached, initPool, invalidateColumnCache };
