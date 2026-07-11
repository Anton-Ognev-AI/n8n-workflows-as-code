// Privileged promote+deploy gate — run manually/locally. Given a feature branch:
//   ff-only merge → syntax check ALL .mjs → content smoke (weather, if present) → run EVERY deploy-*.mjs.
// Generic: any new deploy-<name>.mjs added to the repo is picked up automatically (no hardcoding).
// Fails LOUDLY with a non-zero exit + a [deploy] reason on stderr so the caller surfaces it (never silent).
// Usage: node promote-and-deploy.mjs <feature-branch>
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.dirname(fileURLToPath(import.meta.url));
const branch = process.argv[2];
if (!branch || branch === 'master' || branch === 'main') { console.error('[deploy] usage: node promote-and-deploy.mjs <feature-branch>'); process.exit(2); }
const git = (...a) => execFileSync('git', ['-c', 'safe.directory=*', '-c', 'user.email=deploy@local', '-c', 'user.name=Deploy Bot', '-C', REPO, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const die = (code, msg) => { console.error('[deploy] ' + msg); process.exit(code); };

// 1) ff-only promote: stale/diverged master must FAIL, not open an editor or deploy stale code.
try { git('checkout', 'master'); git('merge', '--ff-only', branch); console.log('[deploy] merged --ff-only', branch); }
catch (e) { die(3, 'merge --ff-only failed (master diverged or branch missing): ' + String(e.stderr || e).slice(0, 200)); }

const mjs = fs.readdirSync(REPO).filter((f) => f.endsWith('.mjs') && f !== 'promote-and-deploy.mjs');
const deployers = mjs.filter((f) => /^deploy-.+\.mjs$/.test(f)).sort();

// 2) syntax check EVERY .mjs that may have been edited before any live PUT.
try { for (const f of mjs) execFileSync('node', ['--check', path.join(REPO, f)], { stdio: ['ignore', 'pipe', 'pipe'] }); console.log('[deploy] node --check OK (' + mjs.length + ' files)'); }
catch (e) { die(4, 'syntax check failed: ' + String(e.stderr || e).slice(0, 200)); }

// 3) content smoke (weather formatter, if present) — catches logic breaks before prod for the known lib.
if (fs.existsSync(path.join(REPO, 'weather-format.mjs'))) {
  try {
    const { formatForecast } = await import(pathToFileURL(path.join(REPO, 'weather-format.mjs')).href + '?t=' + Date.now());
    const out = formatForecast({ daily: { time: ['2026-06-22'], weather_code: [1], temperature_2m_max: [20], temperature_2m_min: [12], precipitation_probability_max: [30], wind_speed_10m_max: [10] } }, 'X');
    if (!out || typeof out !== 'string' || /undefined|NaN/.test(out)) throw new Error('formatter returned: ' + out);
    console.log('[deploy] content smoke OK');
  } catch (e) { die(5, 'content smoke failed: ' + String(e).slice(0, 200)); }
}

// 4) deploy: run EVERY deploy-*.mjs (each is a self-contained PUT+activate deployer). Idempotent.
if (!deployers.length) die(6, 'no deploy-*.mjs found to run');
for (const d of deployers) {
  try { const out = execFileSync('node', [path.join(REPO, d)], { encoding: 'utf8' }); console.log('[deploy] ' + d + ':\n' + out.trim().split('\n').slice(-3).join('\n')); }
  catch (e) { die(6, d + ' failed: ' + String(e.stdout || e.stderr || e).slice(0, 200)); }
}

console.log('[deploy] PROMOTE+DEPLOY OK for ' + branch + ' (' + deployers.join(', ') + ')');
