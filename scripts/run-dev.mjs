/**
 * Starts the Vite dev server (API proxies + LAN bind).
 * Suitable for manual runs, scheduled tasks, or NSSM / Windows services.
 *
 * Binds 0.0.0.0:5273 via vite.config.js (host: true, port: 5273).
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const node = process.execPath;
const viteCli = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');

let child;

function prefixLines(chunk) {
  const s = chunk.toString();
  for (const line of s.split(/\r?\n/)) {
    if (line.length) console.log(`[vite] ${line}`);
  }
}

function shutdown(code = 0) {
  if (child && !child.killed && child.exitCode === null) {
    child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 1500).unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

try {
  child = spawn(node, [viteCli], {
    cwd: root,
    env: { ...process.env, FORCE_COLOR: process.env.FORCE_COLOR || '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: process.env.TCG_TOOLS_SERVICE === '1',
  });
  child.stdout.on('data', prefixLines);
  child.stderr.on('data', prefixLines);
  child.on('exit', (code, signal) => {
    console.log(`[launcher] vite exited (code=${code}, signal=${signal})`);
    shutdown(code === 0 || code === null ? 0 : code);
  });
} catch (e) {
  console.error('[launcher]', e);
  process.exit(1);
}

console.log('[launcher] Vite dev server starting…');
console.log('[launcher] Open from this PC: http://localhost:5273');
console.log('[launcher] From another device: http://<this-pc-ip>:5273');
