// Pure forecast formatter — THE single source of truth. deploy-weather.mjs injects this exact
// function (via .toString()) into the n8n Code node, so the deployed workflow and the proof scripts
// never drift. Takes the FULL open-meteo response (data.daily + data.hourly).
//
// WHY hourly: open-meteo's daily.weather_code is the MOST-SEVERE code over the whole 24h — a brief
// overnight drizzle (0.3mm at 00:00) mislabels an otherwise-clear DAY as "🌧 дощ". So we derive the
// headline from DAYTIME hours (07:00–21:00): rain only if a daytime hour actually has rain + a real
// probability; otherwise the most-common daytime cloud code. Matches what a person sees during the day.
export const WMO = {
  0: '☀️ ясно', 1: '🌤 переважно ясно', 2: '⛅ мінлива хмарність', 3: '☁️ хмарно',
  45: '🌫 туман', 48: '🌫 паморозь',
  51: '🌦 мряка', 53: '🌦 мряка', 55: '🌦 сильна мряка',
  61: '🌧 дощ', 63: '🌧 дощ', 65: '🌧 сильний дощ', 66: '🌧 крижаний дощ', 67: '🌧 крижаний дощ',
  71: '🌨 сніг', 73: '🌨 сніг', 75: '🌨 сильний сніг', 77: '🌨 сніжна крупа',
  80: '🌦 зливи', 81: '🌦 зливи', 82: '⛈ сильні зливи', 85: '🌨 снігопад', 86: '🌨 снігопад',
  95: '⛈ гроза', 96: '⛈ гроза з градом', 99: '⛈ гроза з градом',
};
export function formatForecast(data, city) {
  const daily = (data && data.daily) || {};
  const hourly = (data && data.hourly) || {};
  const at = (o, k) => (o && o[k] && o[k][0] != null ? o[k][0] : null);
  const date = at(daily, 'time');
  const tmax = at(daily, 'temperature_2m_max');
  const tmin = at(daily, 'temperature_2m_min');
  const dsum = at(daily, 'precipitation_sum');
  // Daytime headline (07:00–21:00) from hourly; fall back to daily code if no hourly.
  let code = at(daily, 'weather_code');
  let pop = at(daily, 'precipitation_probability_max');
  const hc = hourly.weather_code, ht = hourly.time, hp = hourly.precipitation_probability;
  if (Array.isArray(hc) && Array.isArray(ht)) {
    const day = ht.map((t, i) => ({ h: Number(String(t).slice(11, 13)), c: hc[i], p: hp ? hp[i] : null }))
      .filter((x) => x.h >= 7 && x.h <= 21 && x.c != null);
    if (day.length) {
      const rain = day.filter((x) => x.c >= 51 && (x.p == null || x.p >= 30));
      if (rain.length) { code = Math.max(...rain.map((x) => x.c)); pop = Math.max(...rain.map((x) => x.p || 0)); }
      else {
        const freq = {}; let best = day[0].c, bestN = 0;
        for (const x of day) { const c = x.c < 51 ? x.c : 0; freq[c] = (freq[c] || 0) + 1; if (freq[c] > bestN) { bestN = freq[c]; best = c; } }
        code = best; pop = Math.max(0, ...day.map((x) => x.p || 0));
      }
    }
  }
  const lines = [
    '🌍 Погода — ' + (city || 'Познань') + (date ? ', ' + date : ''),
    code != null && WMO[code] ? WMO[code] : 'погода',
    '🌡 ' + (tmax != null ? Math.round(tmax) : '?') + '° / ' + (tmin != null ? Math.round(tmin) : '?') + '°C',
  ];
  if (pop != null && pop > 0) lines.push('☔ опади: до ' + pop + '%' + (dsum != null && dsum > 0 ? ' (' + dsum + ' мм)' : ''));
  const wind = at(daily, 'wind_speed_10m_max');
  if (wind != null) lines.push('💨 вітер: до ' + Math.round(wind) + ' км/год');
  return lines.join('\n');
}
