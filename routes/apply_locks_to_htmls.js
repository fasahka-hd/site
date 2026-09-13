import { readFileSync, writeFileSync, readdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, "public");
const NAV_LINK = '  <a class="navItem" data-role-only="KP" href="locks.html">Блокировки</a>';
const SCRIPT_TAG = '<script src="lock_notice.js?v=1"></script>';
const SKIP = new Set(["login.html", "locks.html"]);
function patch(filePath) {
  let src = readFileSync(filePath, "utf8");
  let changed = false;
  const logoutNeedle = '<a class="navItem" href="#" id="logoutBtn">Выход</a>';
  if (src.includes(logoutNeedle) && !src.includes("locks.html")) {
    src = src.replace(logoutNeedle, NAV_LINK + "\n      " + logoutNeedle);
    changed = true;
  } else if (!src.includes("locks.html") || !src.includes('data-role-only="KP"')) {
    console.log(`  [skip-nav] ${filePath} — паттерн nav не найден`);
  }
  if (!src.includes("lock_notice.js")) {
    if (src.includes("</body>")) {
      src = src.replace("</body>", SCRIPT_TAG + "\n</body>");
      changed = true;
    } else {
      console.log(`  [skip-script] ${filePath} — </body> не найден`);
    }
  }
  if (changed) {
    writeFileSync(filePath, src, "utf8");
    console.log(`  [ok] ${filePath}`);
  } else {
    console.log(`  [no-change] ${filePath}`);
  }
}
if (!existsSync(PUBLIC)) {
  console.error(`Папка public/ не найдена: ${PUBLIC}`);
  process.exit(1);
}
const files = readdirSync(PUBLIC).filter((f) => f.endsWith(".html") && !SKIP.has(f));
console.log(`Найдено HTML-файлов: ${files.length}`);
for (const f of files) patch(join(PUBLIC, f));
console.log("Готово.");
