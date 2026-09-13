import { build } from "esbuild";
import { readdirSync, mkdirSync, readFileSync, writeFileSync, statSync, existsSync } from "fs";
import { createHash } from "crypto";
import { join } from "path";
const SRC = "public";
const OUT = join(SRC, "dist");
mkdirSync(OUT, { recursive: true });
const jsFiles = readdirSync(SRC).filter((f) => f.endsWith(".js"));
let totalIn = 0, totalOut = 0;
for (const f of jsFiles) {
  const inPath = join(SRC, f);
  const outPath = join(OUT, f);
  const before = statSync(inPath).size;
  await build({
    entryPoints: [inPath],
    outfile: outPath,
    minify: true,
    bundle: false,
    legalComments: "none",
    target: ["es2020"]
  });
  const after = statSync(outPath).size;
  totalIn += before;
  totalOut += after;
  console.log(`JS  ${f}: ${(before / 1024).toFixed(1)}KB → ${(after / 1024).toFixed(1)}KB`);
}
function minifyHtml(src) {
  const stash = [];
  let out = src.replace(/<(script|pre|textarea)\b[\s\S]*?<\/\1>/gi, (m) => {
    stash.push(m);
    return `\u0000STASH${stash.length - 1}\u0000`;
  });
  out = out.replace(/<!--(?!\[if)[\s\S]*?-->/g, "");
  out = out.replace(/\n\s*\n/g, "\n");
  out = out.replace(/^[ \t]+/gm, "");
  out = out.replace(/>\s+</g, "><");
  out = out.trim();
  out = out.replace(/\u0000STASH(\d+)\u0000/g, (_, i) => stash[Number(i)]);
  return out;
}
const htmlFiles = readdirSync(SRC).filter((f) => f.endsWith(".html"));
for (const f of htmlFiles) {
  const inPath = join(SRC, f);
  const raw = readFileSync(inPath, "utf8");
  const min = minifyHtml(raw);
  writeFileSync(join(OUT, f), min, "utf8");
  totalIn += raw.length;
  totalOut += min.length;
  console.log(`HTML ${f}: ${(raw.length / 1024).toFixed(1)}KB → ${(min.length / 1024).toFixed(1)}KB`);
}
const swPath = join(SRC, "sw.js");
if (existsSync(swPath)) {
  const swSrc = readFileSync(swPath, "utf8");
  const assetSig = createHash("sha256");
  for (const f of [...jsFiles, "styles.css"].sort()) {
    const p = join(SRC, f);
    if (existsSync(p)) assetSig.update(f).update(readFileSync(p));
  }
  const swVersion = assetSig.digest("hex").slice(0, 12);
  const swOut = swSrc.replace(/const CACHE = "[^"]*";/, `const CACHE = "arizona-static-${swVersion}";`);
  writeFileSync(join(OUT, "sw.js"), swOut, "utf8");
  console.log(`SW  cache version: arizona-static-${swVersion}`);
}
const serverSrc = readFileSync("server.js", "utf8");
const expectedHashes = new Set();
for (const f of htmlFiles) {
  const src = readFileSync(join(OUT, f), "utf8");
  for (const m of src.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
    expectedHashes.add(createHash("sha256").update(m[1]).digest("base64"));
  }
}
for (const h of expectedHashes) {
  if (!serverSrc.includes(`sha256-${h}`)) {
    console.error(`\nCSP MISMATCH: inline script hash sha256-${h} is not allowed in server.js`);
    console.error("Add it to INLINE_SCRIPT_HASH or the page will be blocked by CSP.\n");
    process.exitCode = 1;
  }
}
if (!process.exitCode) console.log(`CSP: ${expectedHashes.size} inline script hash(es) verified`);
const CSS_FILE = "styles.css";
const css = readFileSync(join(SRC, CSS_FILE), "utf8");
const cssRes = await build({
  stdin: { contents: css, loader: "css" },
  minify: true,
  write: false
});
const cssMin = cssRes.outputFiles[0].text;
writeFileSync(join(OUT, CSS_FILE), cssMin);
console.log(`CSS ${CSS_FILE}: ${(css.length / 1024).toFixed(1)}KB → ${(cssMin.length / 1024).toFixed(1)}KB`);
totalIn += css.length;
totalOut += cssMin.length;
console.log(`
Итого: ${(totalIn / 1024).toFixed(0)}KB → ${(totalOut / 1024).toFixed(0)}KB (−${Math.round((1 - totalOut / totalIn) * 100)}%)`);
