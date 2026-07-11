// Standalone delivery proof: open-meteo (Poznań) -> formatForecast -> Telegram send via the .env bot.
// Used to validate the content+credentials BEFORE deploying the n8n schedule. Reads .env (gitignored).
import fs from 'node:fs';
import { formatForecast } from './weather-format.mjs';

const env = Object.fromEntries(
  fs.readFileSync(new URL('./.env', import.meta.url), 'utf8')
    .split(/\r?\n/).filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);

const LAT = 52.41, LON = 16.93, CITY = 'Познань', TZ = 'Europe/Warsaw';
const url = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max&hourly=weather_code,precipitation_probability&timezone=${TZ}&forecast_days=1`;

const wx = await (await fetch(url)).json();
const text = formatForecast(wx, CITY);
console.log('--- forecast ---\n' + text + '\n----------------');

const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
});
const j = await r.json();
console.log('telegram send:', r.status, j.ok ? ('message_id=' + j.result.message_id) : JSON.stringify(j).slice(0, 120));
