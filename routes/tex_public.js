import { Router } from "express";

import rateLimit from "express-rate-limit";

import { randomBytes } from "crypto";

import { db } from "../lib/db.js";

import { authGuard } from "../lib/guard.js";

import { getUserRole, hasPerm } from "../lib/roles.js";

import { decodeIfNeeded, steamidToSteamid64, steamid64ToSteamid } from "../lib/helpers.js";

const TOKEN_RE = /^[a-f0-9]{32,64}$/i;

const LINK_TTL_SEC = Math.max(60, parseInt(process.env.TEX_LINK_TTL_SEC || String(24 * 60 * 60), 10));

function nowSec() {
  return Math.floor(Date.now() / 1e3);
}

function normalizePeriodDays(v) {
  const n = parseInt(v || 0, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.max(1, Math.min(365, n));
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));
}

function normSteam(raw) {
  const s = String(raw || "").trim().toUpperCase();
  if (/^\d{17}$/.test(s)) return {
    steamid64: s,
    steamid: steamid64ToSteamid(s)
  };
  const sid64 = steamidToSteamid64(s);
  if (!sid64) return null;
  return {
    steamid64: sid64,
    steamid: steamid64ToSteamid(sid64)
  };
}

async function tableExists(pool, table) {
  try {
    const [rows] = await pool.query("SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1", [ table ]);
    return rows.length > 0;
  } catch {
    return false;
  }
}

async function ensureTexLinkColumns(pool) {
  const cols = [ [ "discord_guild_id", "VARCHAR(32) DEFAULT NULL" ], [ "discord_channel_id", "VARCHAR(32) DEFAULT NULL" ], [ "discord_message_id", "VARCHAR(32) DEFAULT NULL" ], [ "discord_requester_id", "VARCHAR(32) DEFAULT NULL" ], [ "period_days", "INT UNSIGNED DEFAULT NULL" ], [ "expires_at", "INT NOT NULL DEFAULT 0" ] ];
  try {
    if (!await tableExists(pool, "tex_public_links")) return;
    for (const [col, def] of cols) {
      const [rows] = await pool.query("SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tex_public_links' AND COLUMN_NAME = ? LIMIT 1", [ col ]);
      if (!rows.length) {
        await pool.query(`ALTER TABLE tex_public_links ADD COLUMN ${col} ${def}`);
      }
    }
  } catch (e) {
    console.error("ensureTexLinkColumns error:", e.message);
  }
}

async function createTexLink(pool, steamid64, requestedBy = "", periodDays = null) {
  await ensureTexLinkColumns(pool);
  const token = randomBytes(24).toString("hex");
  const days = normalizePeriodDays(periodDays);
  const createdAt = nowSec();
  const expiresAt = createdAt + LINK_TTL_SEC;
  await pool.query(`INSERT INTO tex_public_links (token, steamid64, requested_by, period_days, expires_at, created_at, status)\n     VALUES (?, ?, ?, ?, ?, ?, 'pending')`, [ token, steamid64, String(requestedBy || "").slice(0, 128), days, expiresAt, createdAt ]);
  return token;
}

async function getTexLogs(pool, steamid64, limit = 100, periodDays = null) {
  limit = Math.max(1, Math.min(500, parseInt(limit || 100, 10)));
  const days = normalizePeriodDays(periodDays);
  const fromUnix = days ? nowSec() - days * 24 * 60 * 60 : 0;
  const out = {
    money: [],
    donate: [],
    totals: {
      money_income: 0,
      money_expense: 0,
      donate_income: 0,
      donate_expense: 0
    }
  };
  try {
    if (await tableExists(pool, "player_moneylog")) {
      const [rows] = await pool.query(`SELECT id, Name, SteamID64, Money, Description, NormalDate, Time\n         FROM player_moneylog\n         WHERE SteamID64 = ? ${days ? "AND Time >= FROM_UNIXTIME(?)" : ""}\n         ORDER BY Time DESC, id DESC LIMIT ?`, days ? [ steamid64, fromUnix, limit ] : [ steamid64, limit ]);
      out.money = rows.map(r => {
        const money = Number(r.Money || 0);
        if (money >= 0) out.totals.money_income += money; else out.totals.money_expense += money;
        return {
          id: Number(r.id || 0),
          name: decodeIfNeeded(r.Name || ""),
          steamid64: String(r.SteamID64 || ""),
          money: money,
          description: decodeIfNeeded(r.Description || ""),
          normal_date: String(r.NormalDate || ""),
          time: r.Time ? new Date(r.Time).toISOString() : null
        };
      });
    }
  } catch (e) {
    out.money_error = e.message || "DB_ERROR";
  }
  try {
    if (await tableExists(pool, "GMDonate_Transactions")) {
      const playersExists = await tableExists(pool, "GMDonate_Players");
      const joinSql = playersExists ? "LEFT JOIN GMDonate_Players p ON p.SteamID64 = t.SteamID64" : "";
      const nickSql = playersExists ? "p.Nick AS donate_nick, p.Balance AS current_balance" : "NULL AS donate_nick, NULL AS current_balance";
      const [rows] = await pool.query(`SELECT t.TxHash, t.SteamID64, t.Sum, t.Note, t.TxTime, ${nickSql}\n         FROM GMDonate_Transactions t ${joinSql}\n         WHERE t.SteamID64 = ? ${days ? "AND t.TxTime >= ?" : ""}\n         ORDER BY t.TxTime DESC, t.TxHash DESC LIMIT ?`, days ? [ steamid64, fromUnix, limit ] : [ steamid64, limit ]);
      out.donate = rows.map(r => {
        const sum = Number(r.Sum || 0);
        if (sum >= 0) out.totals.donate_income += sum; else out.totals.donate_expense += sum;
        return {
          id: String(r.TxHash || ""),
          steamid64: String(r.SteamID64 || ""),
          name: decodeIfNeeded(r.donate_nick || ""),
          sum: sum,
          note: decodeIfNeeded(r.Note || ""),
          tx_time: r.TxTime ? new Date(Number(r.TxTime) * 1e3).toISOString() : null,
          current_balance: Math.round(Number(r.current_balance || 0))
        };
      });
    }
  } catch (e) {
    out.donate_error = e.message || "DB_ERROR";
  }
  return out;
}

async function createTexInfoLink(pool, requestedBy = "") {
  const token = randomBytes(24).toString("hex");
  const createdAt = nowSec();
  const expiresAt = createdAt + LINK_TTL_SEC;
  await pool.query(`CREATE TABLE IF NOT EXISTS tex_info_links (\n    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,\n    token VARCHAR(64) NOT NULL,\n    requested_by VARCHAR(128) DEFAULT NULL,\n    created_at INT NOT NULL DEFAULT 0,\n    expires_at INT NOT NULL DEFAULT 0,\n    PRIMARY KEY (id),\n    UNIQUE KEY uq_tex_info_token (token),\n    KEY idx_tex_info_expires_at (expires_at)\n  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`).catch(() => {});
  await pool.query("INSERT INTO tex_info_links (token, requested_by, created_at, expires_at) VALUES (?, ?, ?, ?)", [ token, String(requestedBy || "").slice(0, 128), createdAt, expiresAt ]);
  return token;
}

function requireKpPage(req, res, next) {
  if (!req.session?.user) return res.redirect("/login");
  if (String(req.session.user.role || "") !== "KP") return res.status(403).send("FORBIDDEN");
  next();
}

function requireKpApi(req, res, next) {
  if (!req.session?.user) return res.status(401).json({
    ok: false,
    error: "UNAUTHORIZED"
  });
  if (String(req.session.user.role || "") !== "KP") return res.status(403).json({
    ok: false,
    error: "FORBIDDEN"
  });
  next();
}

function requireTexLogPerm(req, res, next) {
  const role = getUserRole(req.session);
  if (!role) return res.status(401).json({
    ok: false,
    error: "UNAUTHORIZED"
  });
  if (!hasPerm(role, "view_money_logs") || !hasPerm(role, "view_donate_logs")) {
    return res.status(403).json({
      ok: false,
      error: "FORBIDDEN",
      perm: "view_money_logs+view_donate_logs"
    });
  }
  next();
}

function renderPage(token) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Выписка</title><link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='16' fill='%23facc15'/%3E%3Ctext x='32' y='43' font-size='34' font-family='Arial,sans-serif' font-weight='900' text-anchor='middle' fill='%23111827'%3ET%3C/text%3E%3C/svg%3E"><link rel="stylesheet" href="/styles.css?v=1"></head><body class="tex-page"><div class="tex-wrap"><div class="tex-top"><div class="tex-topline"><div class="tex-title"><div class="tex-logo">T</div><div><h1>Выписка игрока</h1><div class="tex-sub" id="sub">Загрузка...</div></div></div><div class="tex-actions"><button class="tex-btn" onclick="copyLink()">Скопировать</button><a class="tex-btn" id="goProfile" target="_blank" rel="noopener" href="#">Перейти</a><a class="tex-btn" id="steamBtn" target="_blank" rel="noopener" style="display:none">Steam</a><button class="tex-btn" onclick="load()">↻ Обновить</button></div></div><div class="tex-tabs"><button class="tex-tab active" data-tab="all">Все</button><button class="tex-tab" data-tab="money">Деньги</button><button class="tex-tab" data-tab="donate">Донат</button></div></div><div class="tex-root" id="root"></div></div><script>\n  const token=${JSON.stringify(token)}; const root=document.getElementById('root'), sub=document.getElementById('sub'); let state=null, tab='all', expireTimer=null;\n  function esc(s){const d=document.createElement('div');d.textContent=s==null?'':String(s);return d.innerHTML}\n  function money(v){v=Number(v||0);return (v>0?'+':'')+Math.round(v).toLocaleString('ru-RU')+' ₽'}\n  function time(v){if(!v)return '—';try{return new Date(v).toLocaleString('ru-RU')}catch{return '—'}}\n  function copyLink(){navigator.clipboard?.writeText(location.href).then(()=>alert('Ссылка скопирована')).catch(()=>prompt('Скопируй ссылку:',location.href))}\n  function expired(){document.body.innerHTML='<div class="expired-screen"><div class="expired-box"><h1>Логи истекли</h1><div class="tex-sub">Ссылка больше не активна</div></div></div>'}\n  function leftText(iso){if(!iso)return '';let ms=new Date(iso).getTime()-Date.now();if(ms<=0)return 'истекла';let m=Math.floor(ms/60000),h=Math.floor(m/60),d=Math.floor(h/24);h%=24;m%=60;return (d?d+'д ':'')+(h?h+'ч ':'')+m+'м'}\n  function startExpire(iso){clearInterval(expireTimer);const tick=()=>{const el=document.getElementById('expireLine');if(el)el.textContent=' · активно: '+leftText(iso);if(iso&&new Date(iso).getTime()<=Date.now())expired()};tick();expireTimer=setInterval(tick,30000)}\n  function sum(arr,key){return arr.reduce((n,x)=>n+Number(x[key]||0),0)}\n  function countPos(arr,key){return arr.filter(x=>Number(x[key]||0)>0).length} function countNeg(arr,key){return arr.filter(x=>Number(x[key]||0)<0).length}\n  function suspiciousMoney(x){const v=Math.abs(Number(x.money||0));const d=String(x.description||'').toLowerCase();return v>=10000000||/передача денег|takemoney|addmoney|списание|начисление/.test(d)}\n  function suspiciousDonate(x){const v=Math.abs(Number(x.sum||0));const d=String(x.note||'').toLowerCase();return v>=1000000||/given by|reward|refund|возврат|ручн|admin/.test(d)}\n  function reasonMoney(x){const v=Math.abs(Number(x.money||0));const d=String(x.description||'');let r=[];if(v>=10000000)r.push('крупно');if(/Передача денег/i.test(d))r.push('перевод');if(/TakeMoney|AddMoney|списание|начисление/i.test(d))r.push('ручное');return r.join(', ')||'проверь'}\n  function reasonDonate(x){const v=Math.abs(Number(x.sum||0));const d=String(x.note||'');let r=[];if(v>=1000000)r.push('крупно');if(/given by|reward|refund|возврат|ручн|admin/i.test(d))r.push('нестандартно');return r.join(', ')||'проверь'}\n  async function load(){root.innerHTML='<div class="tex-card tex-sub">Загрузка...</div>';try{const r=await fetch('/api/public/tex/'+token,{cache:'no-store'});const j=await r.json().catch(()=>null);if(r.status===410||j?.error==='LINK_EXPIRED'){expired();return}if(r.status===403&&j?.error==='NOT_APPROVED'){throw new Error('Выписка ещё не одобрена или отклонена')}if(!r.ok||!j||!j.ok)throw new Error(j?.error||'Ошибка');state=j;render()}catch(e){root.innerHTML='<div class="err">'+esc(e.message)+'</div>'}}\n  function fmtPeriod(a,b){try{const f=t=>new Date(t).toLocaleDateString('ru-RU',{day:'2-digit',month:'2-digit'});return f(a)+' — '+f(b)}catch(e){return ''}}\n  function render(){const j=state;if(!j)return;const gp=document.getElementById('goProfile');if(gp)gp.href='/player?sid='+encodeURIComponent(j.steamid64);const moneyRows=j.logs.money||[], donateRows=j.logs.donate||[];sub.innerHTML='Игрок: <code>'+esc(j.steamid64)+'</code> / <code>'+esc(j.steamid)+'</code>'+(j.period_days?' · '+esc(j.period_days)+'д':'')+'<span id="expireLine" class="expire-line"></span>'; const sb=document.getElementById('steamBtn'); if(sb){sb.href='https://steamcommunity.com/profiles/'+encodeURIComponent(j.steamid64); sb.style.display='inline-flex'} startExpire(j.expires_at); const mi=sum(moneyRows.filter(x=>Number(x.money)>0),'money'), me=sum(moneyRows.filter(x=>Number(x.money)<0),'money'), di=sum(donateRows.filter(x=>Number(x.sum)>0),'sum'), de=sum(donateRows.filter(x=>Number(x.sum)<0),'sum'); const badM=moneyRows.filter(suspiciousMoney).length, badD=donateRows.filter(suspiciousDonate).length; const netMoney=mi+me, netDonate=di+de; root.className='tex-root '+(tab==='money'?'only-money':tab==='donate'?'only-donate':''); const showMoney=tab!=='donate', showDonate=tab!=='money'; const opsCount=tab==='donate'?donateRows.length:(tab==='money'?moneyRows.length:moneyRows.length+donateRows.length); const opsSub=tab==='donate'?esc(donateRows.length)+' дон':(tab==='money'?esc(moneyRows.length)+' ден':esc(moneyRows.length)+' ден · '+esc(donateRows.length)+' дон'); const badCount=tab==='donate'?badD:(tab==='money'?badM:badM+badD); const badSub=tab==='donate'?esc(badD)+' дон':(tab==='money'?esc(badM)+' ден':esc(badM)+' ден · '+esc(badD)+' дон'); let html='<div class="tex-summary">'; if(showMoney){html+='<div class="tex-mini money-box"><div class="tex-mini-ico">💸</div><div class="tex-mini-body"><div class="tex-mini-label">Деньги · итог</div><div class="tex-mini-val '+(netMoney>=0?'pos':'neg')+'">'+esc(money(netMoney))+'</div><div class="tex-mini-sub">приход '+esc(money(mi))+' · расход '+esc(money(me))+'</div></div></div>'} if(showDonate){html+='<div class="tex-mini donate-box"><div class="tex-mini-ico">⭐</div><div class="tex-mini-body"><div class="tex-mini-label">Донат · итог</div><div class="tex-mini-val '+(netDonate>=0?'pos':'neg')+'">'+esc(money(netDonate))+'</div><div class="tex-mini-sub">приход '+esc(money(di))+' · расход '+esc(money(de))+'</div></div></div>'} html+='<div class="tex-mini"><div class="tex-mini-ico">📊</div><div class="tex-mini-body"><div class="tex-mini-label">Операций</div><div class="tex-mini-val">'+esc(opsCount)+'</div><div class="tex-mini-sub">'+opsSub+'</div></div></div>'; if(badCount>0){html+='<div class="tex-mini tex-mini-warn"><div class="tex-mini-ico">⚠</div><div class="tex-mini-body"><div class="tex-mini-label">Подозрительных</div><div class="tex-mini-val neg">'+esc(badCount)+'</div><div class="tex-mini-sub">'+badSub+'</div></div></div>'} html+='</div>'; if(tab==='money'||tab==='donate'){const chartTitle=tab==='money'?'📈 Динамика денег':'📈 Динамика доната'; html+='<div class="tex-chart"><div class="tex-chart-head"><div class="tex-chart-titles"><div class="tex-chart-title">'+chartTitle+'</div><div class="tex-chart-sub" id="texChartSub"></div></div><div class="tex-chart-big" id="texChartBig"></div></div><div class="tex-chart-plot" id="texChartPlot"><div class="tex-svg-holder" id="texChartSvg"></div><div class="tex-dot" id="texDot"></div><div class="tex-cross" id="texCross"></div><div class="tex-tip" id="texTip"></div></div></div>'} html+='<div class="tex-layout"><div class="tex-card money-box"><div class="tex-section-head"><h2>💸 Логи денег</h2><input class="tex-search" id="moneySearch" placeholder="Поиск по деньгам"></div><div id="moneyTable" class="tex-table-holder">'+tableMoney(moneyRows)+'</div></div><div class="tex-card donate-box"><div class="tex-section-head"><h2>⭐ Логи доната</h2><input class="tex-search" id="donateSearch" placeholder="Поиск по донату"></div><div id="donateTable" class="tex-table-holder">'+tableDonate(donateRows)+'</div></div></div>'; root.innerHTML=html; buildChart(); bindSearch(moneyRows,donateRows)}\n  function buildChart(){const plot=document.getElementById('texChartPlot'); if(!plot)return; const svgHolder=document.getElementById('texChartSvg'); const subEl=document.getElementById('texChartSub'); const bigEl=document.getElementById('texChartBig'); const j=state; if(!j)return; const moneyRows=j.logs.money||[], donateRows=j.logs.donate||[]; const evs=[]; if(tab!=='donate'){moneyRows.forEach(x=>{ if(x.time) evs.push({t:new Date(x.time).getTime(), v:Number(x.money||0)}) })} if(tab!=='money'){donateRows.forEach(x=>{ if(x.tx_time) evs.push({t:new Date(x.tx_time).getTime(), v:Number(x.sum||0)}) })} evs.sort((a,b)=>a.t-b.t); let cum=0; const series=evs.map(e=>{cum+=e.v; return {t:e.t, v:cum}}); if(!series.length){ plot.classList.add('tex-chart-empty'); svgHolder.innerHTML='<div class="tex-chart-nodata">Нет данных для графика</div>'; if(subEl)subEl.textContent=''; if(bigEl){bigEl.textContent='—'; bigEl.className='tex-chart-big'} return } plot.classList.remove('tex-chart-empty'); const W=1000,H=240,padT=16,padB=14,padL=8,padR=8; const n=series.length; const vals=series.map(p=>p.v); let minV=Math.min.apply(null,vals), maxV=Math.max.apply(null,vals); if(minV===maxV){minV-=1; maxV+=1} const X=i=> n===1? (padL+(W-padL-padR)/2) : padL+(W-padL-padR)*(i/(n-1)); const Y=v=> padT+(H-padT-padB)*(1-(v-minV)/(maxV-minV)); let line=''; series.forEach((p,i)=>{ line+=(i?'L':'M')+X(i).toFixed(1)+' '+Y(p.v).toFixed(1)+' ' }); const x0=X(0), xN=X(n-1), yB=padT+(H-padT-padB); const area='M'+x0.toFixed(1)+' '+yB.toFixed(1)+' '+line.replace(/^M/,'L')+'L'+xN.toFixed(1)+' '+yB.toFixed(1)+' Z'; let grid=''; const steps=4; for(let g=0;g<=steps;g++){ const gy=padT+(H-padT-padB)*(g/steps); grid+='<line x1="0" y1="'+gy.toFixed(1)+'" x2="'+W+'" y2="'+gy.toFixed(1)+'" class="tex-grid"/>' } const lastP=series[n-1]; const svg='<svg viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none" class="tex-svg"><defs><linearGradient id="texFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#facc15" stop-opacity="0.40"/><stop offset="100%" stop-color="#facc15" stop-opacity="0.02"/></linearGradient></defs>'+grid+'<path d="'+area+'" fill="url(#texFill)"/><path d="'+line+'" fill="none" stroke="#facc15" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" class="tex-line"/></svg>'; svgHolder.innerHTML=svg; const dotEl=document.getElementById('texDot'); if(dotEl){dotEl.style.left=(X(n-1)/W*100)+'%'; dotEl.style.top=(Y(lastP.v)/H*100)+'%'; dotEl.style.display='block'} if(subEl)subEl.textContent='точек: '+n+' · '+fmtPeriod(series[0].t, series[n-1].t); if(bigEl){bigEl.textContent=money(lastP.v); bigEl.className='tex-chart-big '+(lastP.v>=0?'pos':'neg')} attachChart(plot, series, {W:W,H:H,padT:padT,padB:padB,padL:padL,padR:padR,X:X,Y:Y})}\n  function attachChart(plot, series, geo){const cross=document.getElementById('texCross'); const tip=document.getElementById('texTip'); function move(e){const rect=plot.getBoundingClientRect(); const clientX=(e.touches&&e.touches[0]?e.touches[0].clientX:e.clientX); const px=clientX-rect.left; let vbX=(px/rect.width)*geo.W; let i=Math.round((vbX-geo.padL)/(geo.W-geo.padL-geo.padR)*(series.length-1)); i=Math.max(0,Math.min(series.length-1,i)); const p=series[i]; const cx=geo.X(i), cy=geo.Y(p.v); const pxX=(cx/geo.W)*rect.width; const pxY=(cy/geo.H)*rect.height; if(cross){cross.style.left=pxX+'px'; cross.style.top='0px'; cross.style.height=rect.height+'px'; cross.style.display='block'} if(tip){tip.style.display='block'; tip.innerHTML='<div class="tex-tip-time">'+esc(time(new Date(p.t).toISOString()))+'</div><div class="tex-tip-val '+(p.v>=0?'pos':'neg')+'">'+esc(money(p.v))+'</div>'; tip.style.left=Math.min(Math.max(pxX+12,4), rect.width-120)+'px'; tip.style.top=Math.min(pxY+12, rect.height-46)+'px'}} function leave(){if(cross)cross.style.display='none'; if(tip)tip.style.display='none'} plot.onmousemove=move; plot.onmouseleave=leave; plot.ontouchmove=move; plot.ontouchstart=move; plot.ontouchend=leave}\n  function bindSearch(m,d){const ms=document.getElementById('moneySearch'),ds=document.getElementById('donateSearch');if(ms)ms.oninput=()=>{const q=ms.value.toLowerCase();document.getElementById('moneyTable').innerHTML=tableMoney(m.filter(x=>(x.name+' '+x.description+' '+x.money+' '+x.time).toLowerCase().includes(q)))};if(ds)ds.oninput=()=>{const q=ds.value.toLowerCase();document.getElementById('donateTable').innerHTML=tableDonate(d.filter(x=>(x.name+' '+x.note+' '+x.sum+' '+x.tx_time).toLowerCase().includes(q)))}}\n  function tableMoney(a){if(!a.length)return '<div class="empty">Нет</div>';return '<div class="tex-table-wrap"><table class="tex-table"><thead><tr><th>Время</th><th>Ник</th><th>Сумма</th><th>Тип</th><th>Описание</th><th>Проверка</th></tr></thead><tbody>'+a.map(x=>{const bad=suspiciousMoney(x),v=Number(x.money||0);return '<tr class="'+(bad?'bad-row':'')+'"><td data-label="Время">'+esc(time(x.time))+'</td><td data-label="Ник">'+esc(x.name||'—')+'</td><td data-label="Сумма" class="amount '+(v>=0?'pos':'neg')+'">'+esc(money(v))+'</td><td data-label="Тип">'+(v>=0?'<span class="badge">приход</span>':'<span class="badge">расход</span>')+'</td><td data-label="Описание" class="desc">'+esc(x.description||'—')+'</td><td data-label="Проверка">'+(bad?'<span class="badge bad">⚠ '+esc(reasonMoney(x))+'</span>':'<span class="badge">норма</span>')+'</td></tr>'}).join('')+'</tbody></table></div>'}\n  function tableDonate(a){if(!a.length)return '<div class="empty">Нет</div>';return '<div class="tex-table-wrap"><table class="tex-table"><thead><tr><th>Время</th><th>Ник</th><th>Сумма</th><th>Баланс</th><th>Описание</th><th>Проверка</th></tr></thead><tbody>'+a.map(x=>{const bad=suspiciousDonate(x),v=Number(x.sum||0);return '<tr class="'+(bad?'bad-row':'')+'"><td data-label="Время">'+esc(time(x.tx_time))+'</td><td data-label="Ник">'+esc(x.name||'—')+'</td><td data-label="Сумма" class="amount '+(v>=0?'pos':'neg')+'">'+esc(money(v))+'</td><td data-label="Баланс">'+esc(money(x.current_balance))+'</td><td data-label="Описание" class="desc">'+esc(x.note||'—')+'</td><td data-label="Проверка">'+(bad?'<span class="badge bad">⚠ '+esc(reasonDonate(x))+'</span>':'<span class="badge">норма</span>')+'</td></tr>'}).join('')+'</tbody></table></div>'}\n  document.querySelectorAll('.tex-tab').forEach(b=>b.onclick=()=>{document.querySelectorAll('.tex-tab').forEach(x=>x.classList.remove('active'));b.classList.add('active');tab=b.dataset.tab;render()});load();<\/script></body></html>`;
}

function renderTexInfoPage(token) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TEX info</title><link rel="stylesheet" href="/styles.css?v=1"></head><body class="tex-info-page"><div class="tex-info-wrap"><div class="tex-top"><div class="tex-topline"><div class="tex-title"><div class="tex-logo">T</div><div><h1>TEX запросы</h1><div class="tex-sub" id="sub">Загрузка...</div></div></div><div class="tex-actions"><button class="tex-btn" onclick="copyLink()">Скопировать</button><button class="tex-btn" onclick="load()">↻ Обновить</button></div></div></div><div id="root"></div></div><script>\n  const token=${JSON.stringify(token)}, root=document.getElementById('root'), sub=document.getElementById('sub'); let expireTimer=null;\n  function esc(s){const d=document.createElement('div');d.textContent=s==null?'':String(s);return d.innerHTML} function time(v){if(!v)return '—';try{return new Date(v).toLocaleString('ru-RU')}catch{return '—'}} function copyLink(){navigator.clipboard?.writeText(location.href).then(()=>alert('Ссылка скопирована')).catch(()=>prompt('Скопируй ссылку:',location.href))}\n  function expired(){document.body.innerHTML='<div class="expired-screen"><div class="expired-box"><h1>Ссылка истекла</h1><div class="tex-sub">Создай новую через !texinfo</div></div></div>'}\n  function leftText(iso){if(!iso)return '';let ms=new Date(iso).getTime()-Date.now();if(ms<=0)return 'истекла';let m=Math.floor(ms/60000),h=Math.floor(m/60),d=Math.floor(h/24);h%=24;m%=60;return (d?d+'д ':'')+(h?h+'ч ':'')+m+'м'}\n  function startExpire(iso){clearInterval(expireTimer);const tick=()=>{sub.textContent='Активно: '+leftText(iso);if(iso&&new Date(iso).getTime()<=Date.now())expired()};tick();expireTimer=setInterval(tick,30000)}\n  async function load(){root.innerHTML='<div class="info-card tex-sub">Загрузка...</div>';try{const r=await fetch('/api/texinfo/'+token,{cache:'no-store',credentials:'include'});const j=await r.json().catch(()=>null);if(r.status===410||j?.error==='LINK_EXPIRED'){expired();return}if(r.status===401){location.href='/login';return}if(!r.ok||!j||!j.ok)throw new Error(j?.error||'Ошибка');render(j)}catch(e){root.innerHTML='<div class="err">'+esc(e.message)+'</div>'}}\n  function render(j){startExpire(j.expires_at);const s=j.stats||{};root.innerHTML='<div class="info-grid"><div class="info-card"><div class="k">Всего</div><div class="v">'+esc(s.total||0)+'</div></div><div class="info-card"><div class="k">Ожидают</div><div class="v status-pending">'+esc(s.pending||0)+'</div></div><div class="info-card"><div class="k">Одобрено</div><div class="v status-approved">'+esc(s.approved||0)+'</div></div><div class="info-card"><div class="k">Отказано</div><div class="v status-denied">'+esc(s.denied||0)+'</div></div></div><div class="request-list">'+(j.items||[]).map(row).join('')+'</div>'}\n  function row(x){const st=x.status||'pending';return '<div class="request-card '+esc(st)+'"><div class="request-main"><h3><code>'+esc(x.steamid64)+'</code> '+(x.period_days?'· '+esc(x.period_days)+'д':'')+'</h3><div class="request-meta">Создано: '+esc(time(x.created_at))+'<br>Истекает: '+esc(time(x.expires_at))+'<br>Запросил: '+esc(x.requested_by||'—')+'<br>Решил: '+esc(x.decided_by||'—')+'</div></div><div><div class="request-status status-'+esc(st)+'">'+esc(st)+'</div><br><a class="tex-btn" target="_blank" href="/public/tex/'+esc(x.token)+'">Открыть</a></div></div>'}\n  load();<\/script></body></html>`;
}

function texPublicRoutes() {
  const r = Router();
  const publicLimiter = rateLimit({
    windowMs: 60 * 1e3,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false
  });
  r.post("/api/tex_link", authGuard, requireTexLogPerm, async (req, res) => {
    const ids = normSteam(req.body?.steamid || req.body?.steamid64 || req.body?.sid || "");
    if (!ids) return res.status(400).json({
      ok: false,
      error: "BAD_STEAMID"
    });
    try {
      const token = await createTexLink(db(), ids.steamid64, req.session?.user?.steamid64 || "site", req.body?.days || req.body?.period_days);
      res.json({
        ok: true,
        token: token,
        steamid64: ids.steamid64,
        steamid: ids.steamid,
        url: `/public/tex/${token}`
      });
    } catch (e) {
      console.error("tex_link error:", e.message);
      res.status(500).json({
        ok: false,
        error: "DB_ERROR"
      });
    }
  });
  r.get("/public/tex/:token", publicLimiter, (req, res) => {
    const token = String(req.params.token || "").trim();
    if (!TOKEN_RE.test(token)) return res.status(404).send("Not found");
    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(renderPage(token));
  });
  r.get("/api/public/tex/:token", publicLimiter, async (req, res) => {
    const token = String(req.params.token || "").trim();
    if (!TOKEN_RE.test(token)) return res.status(404).json({
      ok: false,
      error: "NOT_FOUND"
    });
    try {
      const pool = db();
      await ensureTexLinkColumns(pool);
      const [rows] = await pool.query("SELECT token, steamid64, requested_by, period_days, expires_at, created_at, status FROM tex_public_links WHERE token = ? LIMIT 1", [ token ]);
      if (!rows.length) return res.status(404).json({
        ok: false,
        error: "NOT_FOUND"
      });
      const row = rows[0];
      const exp = parseInt(row.expires_at || 0, 10);
      if (exp && exp < nowSec()) return res.status(410).json({
        ok: false,
        error: "LINK_EXPIRED"
      });
      if (String(row.status || "pending") !== "approved") return res.status(403).json({
        ok: false,
        error: "NOT_APPROVED"
      });
      const steamid64 = String(row.steamid64 || "");
      const logs = await getTexLogs(pool, steamid64, req.query.limit || 200, row.period_days);
      res.setHeader("Cache-Control", "no-store");
      res.json({
        ok: true,
        token: token,
        steamid64: steamid64,
        steamid: steamid64ToSteamid(steamid64),
        requested_by: row.requested_by || "",
        status: row.status || "pending",
        period_days: row.period_days || null,
        expires_at: row.expires_at ? new Date(Number(row.expires_at) * 1e3).toISOString() : null,
        created_at: row.created_at ? new Date(Number(row.created_at) * 1e3).toISOString() : null,
        logs: logs
      });
    } catch (e) {
      console.error("tex_public error:", e.message);
      res.status(500).json({
        ok: false,
        error: "DB_ERROR"
      });
    }
  });
  r.get("/texinfo/:token", requireKpPage, async (req, res) => {
    const token = String(req.params.token || "").trim();
    if (!TOKEN_RE.test(token)) return res.status(404).send("Not found");
    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(renderTexInfoPage(token));
  });
  r.get("/api/texinfo/:token", requireKpApi, async (req, res) => {
    const token = String(req.params.token || "").trim();
    if (!TOKEN_RE.test(token)) return res.status(404).json({
      ok: false,
      error: "NOT_FOUND"
    });
    try {
      const pool = db();
      await ensureTexLinkColumns(pool);
      const [links] = await pool.query("SELECT token, created_at, expires_at FROM tex_info_links WHERE token = ? LIMIT 1", [ token ]);
      if (!links.length) return res.status(404).json({
        ok: false,
        error: "NOT_FOUND"
      });
      const link = links[0];
      const exp = parseInt(link.expires_at || 0, 10);
      if (exp && exp < nowSec()) return res.status(410).json({
        ok: false,
        error: "LINK_EXPIRED"
      });
      const [rows] = await pool.query(`SELECT token, steamid64, requested_by, period_days, status, created_at, expires_at, decided_by, decided_at\n         FROM tex_public_links ORDER BY created_at DESC LIMIT 100`);
      const items = rows.map(r => ({
        token: r.token,
        steamid64: String(r.steamid64 || ""),
        requested_by: r.requested_by || "",
        period_days: r.period_days || null,
        status: r.status || "pending",
        created_at: r.created_at ? new Date(Number(r.created_at) * 1e3).toISOString() : null,
        expires_at: r.expires_at ? new Date(Number(r.expires_at) * 1e3).toISOString() : null,
        decided_by: r.decided_by || "",
        decided_at: r.decided_at ? new Date(Number(r.decided_at) * 1e3).toISOString() : null
      }));
      const stats = {
        total: items.length,
        pending: 0,
        approved: 0,
        denied: 0
      };
      for (const it of items) {
        if (it.status === "approved") stats.approved++; else if (it.status === "denied") stats.denied++; else stats.pending++;
      }
      res.setHeader("Cache-Control", "no-store");
      res.json({
        ok: true,
        expires_at: link.expires_at ? new Date(Number(link.expires_at) * 1e3).toISOString() : null,
        created_at: link.created_at ? new Date(Number(link.created_at) * 1e3).toISOString() : null,
        stats: stats,
        items: items
      });
    } catch (e) {
      console.error("texinfo error:", e.message);
      res.status(500).json({
        ok: false,
        error: "DB_ERROR"
      });
    }
  });
  return r;
}

export { texPublicRoutes as default, createTexLink, createTexInfoLink, getTexLogs, normSteam, ensureTexLinkColumns };
