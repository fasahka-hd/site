# VibeRP / Arizona Web Panel

Панель управления + Discord/Telegram боты (Node.js >= 18, Express, MySQL/MariaDB).

## Быстрый старт

```bash
npm install
cp .env.example .env   # заполнить DB_*, WEB_SECRET, SESSION_SECRET, BASE_URL, токены ботов
npm run build          # минификация в public/dist + проверка CSP-хешей
npm start              # запуск (или: pm2 start server.js --name panel)
```

---

## ЧТО БЫЛО ИСПРАВЛЕНО (эта версия)

### 1. Сайт не открывался, ERR_FAILED — порядок запуска
Раньше HTTP-сервер запускался **только после** успешного логина Discord-бота
(`await startDiscordBot()` стоял перед `app.listen`). Пока бот коннектится/висит —
порт закрыт, сайт «мёртв», при этом боты работают. Теперь:

* `app.listen()` вызывается **первым** — сайт поднимается сразу;
* ошибка `EADDRINUSE` (порт занят старым процессом) раньше молча роняла воркер
  в бесконечный цикл перезапуска (боты при этом жили!) — теперь печатается
  понятная ошибка и подсказка `lsof -i :3000`;
* пока идёт инициализация БД, все запросы получают 503 `STARTING`
  вместо падения;
* любой сбой ботов больше не роняет сайт (лог + работа дальше);
* `client.login()` обёрнут в таймаут 45 сек (зависший шлюз Discord больше
  не блокирует ничего).

### 2. net::ERR_FAILED у пользователей — Service Worker
`public/sw.js` перехватывал **навигацию** (открытие страниц `/`, `/login`,
`/public/tex/...`) и при недоступном сервере отвечал `respondWith(undefined)`
→ Chrome показывал `net::ERR_FAILED` вместо обычной страницы ошибки. Это и есть
ошибка из консоли (`chrome-error://chromewebdata/...`). Теперь:

* навигация никогда не перехватывается SW — страницы всегда идут в сеть;
* из кэша отдаются только css/js/шрифты/картинки (stale-while-revalidate);
* динамический HTML больше не кэшируется навсегда (раньше пользователи
  застревали на старой версии сайта даже после деплоя);
* при установке новой версии SW старые кэши удаляются автоматически.

### 3. Безопасность: `express.static` отдавал все файлы
Опция `filter` у `express.static` **не существует** (serve-static её
игнорирует) — фильтр в коде был мёртвым. Любой `.html` открывался напрямую,
в обход авторизации (`/emoji.html`, `/manage.html` и т.д.). Теперь до статики
стоит middleware:

* все `*.html` → 301 на «чистые» адреса (`/login.html` → `/login`,
  `/emoji.html` → `/emoji`, ...);
* неизвестные `.html/.json/.env/.sql/.log/...` → 404;
* страницы отдаются только через маршруты с `authGuard`.

### 4. Страницы без маршрутов
`emoji.html` («Выдача эмодзи») и `tech_general.html` существовали, но не имели
маршрутов. Добавлены `/emoji` и `/tech/general` (с авторизацией) + редиректы
со старых адресов.

### 5. cluster.js поднимал 2 воркеров = 2 бота
Каждый воркер запускал своего Discord-бота и Telegram-поллер: Telegram ловил
`409 Conflict` (двойной `getUpdates`), бот отвечал дважды. Теперь по умолчанию
1 воркер (можно изменить через `WEB_CONCURRENCY`).

### 6. HSTS preload
Шапка helmet отправляла `Strict-Transport-Security: ... preload` — если
HTTPS когда-нибудь отваливался, браузеры намертво отказывались открывать сайт
по HTTP. Теперь HSTS только в production, без `preload`/`includeSubDomains`.

### 7. Мелочи
* `/api/health` — публичный health-check (`{ok, db, uptime, pid}`) для
  мониторинга/uptime-роботов;
* `apply_locks_to_htmls.js` больше не вставляет ссылку `locks.html`
  (она стала бы 404) и не дублирует вставку при повторном запуске;
* ссылка «Выдача эмодзи» в `emoji.html` ведёт на `/emoji`;
* `.env.example` с перечнем всех переменных.

---

## ЕСЛИ САЙТ ВСЁ ЕЩЁ НЕ ОТКРЫВАЕТСЯ — ЧЕК-ЛИСТ VPS

Код из этого репозитория проверен: сайт поднимается и отвечает. Если на
сервере по-прежнему ошибка — проблема в окружении VPS. Проверь по порядку:

```bash
# 1. Жив ли процесс и что в логах
pm2 logs panel --lines 100        # или: journalctl -u panel -n 100
# Ищем [FATAL] Port ... already in use — тогда:
lsof -i :3000                     # кто занял порт
fuser -k 3000/tcp                 # убить zombie-процесс
pm2 restart panel

# 2. Отвечает ли приложение локально на VPS
curl -i http://127.0.0.1:3000/api/health
# Должно быть {"ok":true,...} — если да, приложение исправно.

# 3. Проверить nginx (домен → 127.0.0.1:3000)
nginx -t && systemctl status nginx
curl -ik https://arzmanager.site/api/health
# Ошибка сертификата? certbot renew / проверить DNS.

# 4. После обновления кода
npm install && npm run build && pm2 restart panel --update-env
```

Если браузер всё равно показывает ERR_FAILED на старых вкладках — это старый
сервис-воркер: **Ctrl+Shift+R** (жёсткое обновление) или DevTools →
Application → Service Workers → Unregister. После обновления на эту версию
проблема исчезнет сама: новый SW не перехватывает навигацию и вычищает старые
кэши.

## Пример конфига nginx

```nginx
server {
    listen 443 ssl http2;
    server_name arzmanager.site;
    # ssl_certificate ...; ssl_certificate_key ...;

    client_max_body_size 12m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }
}
```

## Переменные окружения

См. `.env.example`. Обязательные: `DB_HOST`, `DB_USER`, `DB_PASS`, `DB_NAME`,
`WEB_SECRET`, `SESSION_SECRET`. `BASE_URL` обязателен, если пользуетесь
TEX-выписками (из него строятся публичные ссылки для ботов).
