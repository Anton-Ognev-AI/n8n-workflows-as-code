// Deterministic n8n deployer for the daily weather workflow.
// Reads .env (gitignored) — this is the privileged deploy step, run manually/locally.
// Idempotent: reuses workflowId + telegram credId from .deploy-state.json.
// Usage: node deploy-weather.mjs [--verify|--webhook]   (default = daily 07:00 prod)
import fs from 'node:fs';
import { formatForecast, WMO } from './weather-format.mjs';

const here = (p) => new URL(p, import.meta.url);
const env = Object.fromEntries(
  fs.readFileSync(here('./.env'), 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const state = JSON.parse(fs.readFileSync(here('./.deploy-state.json'), 'utf8') || '{}');
const saveState = () => fs.writeFileSync(here('./.deploy-state.json'), JSON.stringify(state, null, 2) + '\n');

const API = new URL(env.N8N_URL).origin + '/api/v1';
const MODE = process.argv.includes('--webhook') ? 'webhook' : process.argv.includes('--verify') ? 'verify' : 'prod';
const WEBHOOK_PATH = 'weather-test';
const CITY = 'Познань', LAT = 52.41, LON = 16.93, TZ = 'Europe/Warsaw';
const SEND_HOUR = 9; // hour of the daily forecast — the single config a "change time" task edits.

// node fetch sends UTF-8 cleanly (the ASCII-escape workaround was PowerShell-5.1-specific) → plain JSON body.
async function api(method, path, body) {
  const r = await fetch(API + path, {
    method, headers: { 'X-N8N-API-KEY': env.N8N_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await r.text();
  let j; try { j = t ? JSON.parse(t) : {}; } catch { j = { _raw: t.slice(0, 200) }; }
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}: ${JSON.stringify(j).slice(0, 240)}`);
  return j;
}

async function ensureCred() {
  if (state.credId) { console.log('reuse telegram cred:', state.credId); return state.credId; }
  const c = await api('POST', '/credentials', { name: 'Telegram Bot', type: 'telegramApi', data: { accessToken: env.TELEGRAM_BOT_TOKEN } });
  state.credId = c.id; saveState();
  console.log('created telegram cred:', c.id);
  return c.id;
}

// Code-node body: DERIVED from weather-format.mjs (single source of truth — the deployed node and the
// proof scripts can never drift). Adds a missing-data fallback so a bad open-meteo morning still
// delivers a message instead of throwing + silently sending nothing.
const FORMAT_CODE = [
  `const WMO=${JSON.stringify(WMO)};`,
  formatForecast.toString(),
  `const j=$input.first().json, daily=j&&j.daily;`,
  `if(!daily||!daily.time||daily.time[0]==null){return [{json:{text:'⚠️ Погода ${CITY}: не вдалось отримати прогноз сьогодні (open-meteo недоступний)'}}];}`,
  `return [{json:{text:formatForecast(j, ${JSON.stringify(CITY)})}}];`,
].join('\n');

function buildWorkflow(credId) {
  const trigger = MODE === 'webhook'
    ? { id: 'trigger', name: 'Trigger', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0],
        parameters: { path: WEBHOOK_PATH, httpMethod: 'GET', responseMode: 'onReceived' } }
    : { id: 'trigger', name: 'Trigger', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [0, 0],
        parameters: { rule: { interval: [{ triggerAtHour: SEND_HOUR }] } } };
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max&hourly=weather_code,precipitation_probability&timezone=${TZ}&forecast_days=1`;
  return {
    name: 'Daily Poznań Weather',
    nodes: [
      trigger,
      // retry + continue-on-error: a flaky open-meteo morning still reaches Format, which sends the fallback.
      { id: 'openmeteo', name: 'OpenMeteo', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.4, position: [220, 0],
        parameters: { url, options: { timeout: 15000 } }, retryOnFail: true, maxTries: 3, waitBetweenTries: 3000, onError: 'continueRegularOutput' },
      { id: 'format', name: 'Format', type: 'n8n-nodes-base.code', typeVersion: 2, position: [440, 0], parameters: { jsCode: FORMAT_CODE } },
      { id: 'send', name: 'Send', type: 'n8n-nodes-base.telegram', typeVersion: 1.2, position: [660, 0],
        parameters: { chatId: env.TELEGRAM_CHAT_ID, text: '={{ $json.text }}', additionalFields: { appendAttribution: false } },
        credentials: { telegramApi: { id: credId, name: 'Telegram Bot' } } },
    ],
    connections: {
      Trigger: { main: [[{ node: 'OpenMeteo', type: 'main', index: 0 }]] },
      OpenMeteo: { main: [[{ node: 'Format', type: 'main', index: 0 }]] },
      Format: { main: [[{ node: 'Send', type: 'main', index: 0 }]] },
    },
    settings: {
      executionOrder: 'v1', timezone: TZ,
      saveDataSuccessExecution: 'all', saveDataErrorExecution: 'all', saveManualExecutions: true,
    },
  };
}

const credId = await ensureCred();
const wf = buildWorkflow(credId);
let id = state.workflowId;
if (id) { await api('PUT', '/workflows/' + id, wf); console.log('updated workflow:', id); }
else { const created = await api('POST', '/workflows', wf); id = created.id; state.workflowId = id; saveState(); console.log('created workflow:', id); }
// PUT resets active=false → always activate; activate needs JSON content-type even on empty body.
await api('POST', `/workflows/${id}/activate`, {});
const back = await api('GET', '/workflows/' + id);
const origin = new URL(env.N8N_URL).origin;
console.log('ACTIVE:', back.active, '| nodes:', (back.nodes || []).length, '| mode:', MODE);
if (MODE === 'webhook') console.log('WEBHOOK: ' + origin + '/webhook/' + WEBHOOK_PATH);
else console.log('SCHEDULE: daily ' + String(SEND_HOUR).padStart(2, '0') + ':00 ' + TZ);
console.log('UI: ' + origin + '/workflow/' + id);
