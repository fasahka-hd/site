import { execSync } from 'child_process';
console.log('========================================');
console.log('[Bootstrap] Wispbyte auto-installer');
console.log('========================================');
const requiredModules = [
  'express', 'express-mysql-session', 'express-session', 'mysql2',
  'bcryptjs', 'discord.js', 'helmet', 'multer', 'dotenv',
  'compression', 'express-rate-limit', 'gamedig'
];
async function checkDeps() {
  const missing = [];
  for (const mod of requiredModules) {
    try {
      await import(mod);
    } catch {
      missing.push(mod);
    }
  }
  return missing;
}
const missing = await checkDeps();
if (missing.length > 0) {
  console.log(`[Bootstrap] Missing packages: ${missing.length} шт.`);
  console.log(missing.map(m => '  - ' + m).join('\n'));
  console.log('[Bootstrap] Installing (light, no cache)...');
  try {
    try { execSync('rm -rf /home/container/.npm /tmp/npm-* /tmp/.npm 2>/dev/null', { stdio: 'pipe' }); } catch {}
    try { execSync('npm cache clean --force 2>/dev/null', { stdio: 'pipe' }); } catch {}
    const installCmd = 'npm install ' +
      requiredModules.join(' ') +
      ' --no-save --omit=dev --no-audit --no-fund --no-package-lock --cache /tmp/.npm';
    execSync(installCmd, {
      stdio: 'inherit',
      cwd: '/home/container',
      env: { ...process.env, NODE_ENV: 'production' }
    });
    console.log('[Bootstrap] Installation complete! Cleaning up temp files...');
    try { execSync('npm cache clean --force 2>/dev/null', { stdio: 'pipe' }); } catch {}
    try { execSync('rm -rf /home/container/.npm /tmp/.npm /tmp/npm-* /root/.npm 2>/dev/null', { stdio: 'pipe' }); } catch {}
    console.log('[Bootstrap] Cleanup done! Free space saved.');
  } catch (err) {
    console.error('\n[Bootstrap] ❌ ERROR during installation!');
    console.error('This is almost certainly because the disk is FULL on your hosting.');
    console.error('You need to free up at least 70-80 MB of space in /home/container');
    console.error('Try deleting old logs, backups, or unused files via File Manager.');
    console.error('\nError details:', err.message);
    process.exit(1);
  }
} else {
  console.log('[Bootstrap] ✅ All dependencies are already installed!');
}
console.log('[Bootstrap] 🚀 Starting server...');
console.log('========================================\n');
await import('./server.js');
