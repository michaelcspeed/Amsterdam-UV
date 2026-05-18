/// <reference types="@cloudflare/workers-types" />

interface Env {
  TELEGRAM_BOT_TOKEN: string;
  CHAT_ID: string;
  OPENUV_API_KEY: string;
  GOOGLE_WEATHER_API_KEY: string;
  LATITUDE: string;
  LONGITUDE: string;
  RAIN_STATE: KVNamespace;
  WIND_STATE: KVNamespace;
  ALERT_STATE: KVNamespace;
}

interface DailyUV {
  uv_max: number;
  uv_max_time: string;
  sun_info: {
    sun_times: {
      sunrise: string;
      sunset: string;
      goldenHourEnd: string;
      goldenHour: string;
    };
  };
  safe_exposure_time: {
    st1: number;
    st2: number;
    st3: number;
    st4: number;
    st5: number;
    st6: number;
  };
}

interface OpenUVDailyResponse {
  result: DailyUV;
}

interface UVForecastEntry {
  uv: number;
  uv_time: string;
}

interface OpenUVForecastResponse {
  result: UVForecastEntry[];
}

interface OpenMeteoResponse {
  hourly: {
    time: string[];
    precipitation_probability: number[];
    precipitation: number[];
  };
}

interface GoogleHourEntry {
  displayDateTime: { hours: number; minutes: number };
  temperature: { degrees: number };
  feelsLikeTemperature: { degrees: number };
  precipitation: { probability: { percent: number }; qpf: { quantity: number; precipitationType: string } };
  weatherCondition: { description: { text: string }; type: string };
  wind: {
    speed: { value: number; unit: string };
    gust: { value: number; unit: string };
    direction: { cardinal: string };
  };
  relativeHumidity: number;
}

interface GoogleHourlyResponse {
  forecastHours: GoogleHourEntry[];
}

interface GoogleDayEntry {
  sunEvents: {
    sunriseTime: string;
    sunsetTime: string;
  };
  daytimeForecast: {
    weatherCondition: { description: { text: string } };
    wind: {
      speed: { value: number; unit: string };
      gust: { value: number; unit: string };
      direction: { cardinal: string };
    };
    relativeHumidity: number;
  };
  maxTemperature: { degrees: number };
  minTemperature: { degrees: number };
  feelsLikeMaxTemperature: { degrees: number };
  feelsLikeMinTemperature: { degrees: number };
}

interface GoogleDaysResponse {
  forecastDays: GoogleDayEntry[];
}

interface WeatherAlert {
  alertId: string;
  alertTitle: { text: string; languageCode: string };
  eventType: string;
  areaName: string;
  description: string;
  instruction: string[];
  severity: string;
  certainty: string;
  urgency: string;
  startTime: string;
  expirationTime: string;
}

interface WeatherAlertsResponse {
  weatherAlerts?: WeatherAlert[];
}

// ─── Helpers ────────────────────────────────────────────────────────────────


function formatTime(timeStr: string): string {
  const date = new Date(timeStr);
  return date.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Amsterdam',
  });
}

function formatTimeDelta(minutesDelta: number): string {
  const sign = minutesDelta >= 0 ? '+' : '-';
  const abs = Math.abs(minutesDelta);
  if (abs < 60) return `${sign}${abs} min`;
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return m === 0 ? `${sign}${h} hr` : `${sign}${h} hr ${m} min`;
}

// ─── API calls ──────────────────────────────────────────────────────────────


async function getDailyUV(env: Env): Promise<DailyUV> {
  const url = 'https://api.openuv.io/api/v1/uv';
  const params = new URLSearchParams({ lat: env.LATITUDE, lng: env.LONGITUDE, alt: '0' });
  const response = await fetch(`${url}?${params}`, {
    headers: { 'x-access-token': env.OPENUV_API_KEY },
  });
  const data = await response.json() as OpenUVDailyResponse;
  return data.result;
}

async function getUVForecast(env: Env): Promise<UVForecastEntry[]> {
  const url = 'https://api.openuv.io/api/v1/forecast';
  const params = new URLSearchParams({ lat: env.LATITUDE, lng: env.LONGITUDE, alt: '0' });
  const response = await fetch(`${url}?${params}`, {
    headers: { 'x-access-token': env.OPENUV_API_KEY },
  });
  const data = await response.json() as OpenUVForecastResponse;
  return data.result;
}

function uvAtHour(forecast: UVForecastEntry[], hour: number): number | null {
  let best: UVForecastEntry | null = null;
  let bestDiff = Infinity;
  for (const entry of forecast) {
    const localHour = parseInt(
      new Date(entry.uv_time).toLocaleString('en-GB', {
        hour: '2-digit', hour12: false, timeZone: 'Europe/Amsterdam',
      }),
      10,
    );
    const diff = Math.abs(localHour - hour);
    if (diff < bestDiff) { bestDiff = diff; best = entry; }
  }
  return best && bestDiff <= 1 ? best.uv : null;
}

class GoogleQuotaError extends Error {}

class GoogleAPIError extends Error {}

async function googleFetch(url: string, params: URLSearchParams, env: Env): Promise<unknown> {
  const response = await fetch(`${url}?${params}`);
  if (response.status === 429) {
    await sendTelegramMessage(`⚠️ *Google Weather API quota reached*\n\nDaily limit hit — weather data unavailable until tomorrow.`, env);
    throw new GoogleQuotaError('Google Weather API quota exceeded');
  }
  if (!response.ok) {
    await sendTelegramMessage(`⚠️ *Google Weather API error*\n\nRequest returned HTTP ${response.status} — some weather data may be unavailable.`, env);
    throw new GoogleAPIError(`Google Weather API returned ${response.status}`);
  }
  return response.json();
}

async function getHourlyWeather(env: Env): Promise<GoogleHourlyResponse> {
  const url = 'https://weather.googleapis.com/v1/forecast/hours:lookup';
  const params = new URLSearchParams({
    key: env.GOOGLE_WEATHER_API_KEY,
    'location.latitude': env.LATITUDE,
    'location.longitude': env.LONGITUDE,
    hours: '24',
  });
  return googleFetch(url, params, env) as Promise<GoogleHourlyResponse>;
}

async function getDaysWeather(env: Env, days = 2): Promise<GoogleDaysResponse> {
  const url = 'https://weather.googleapis.com/v1/forecast/days:lookup';
  const params = new URLSearchParams({
    key: env.GOOGLE_WEATHER_API_KEY,
    'location.latitude': env.LATITUDE,
    'location.longitude': env.LONGITUDE,
    days: String(days),
  });
  return googleFetch(url, params, env) as Promise<GoogleDaysResponse>;
}

async function getWeatherAlerts(env: Env): Promise<WeatherAlert[]> {
  const url = 'https://weather.googleapis.com/v1/publicAlerts:lookup';
  const params = new URLSearchParams({
    key: env.GOOGLE_WEATHER_API_KEY,
    'location.latitude': env.LATITUDE,
    'location.longitude': env.LONGITUDE,
    languageCode: 'en',
  });
  const data = await googleFetch(url, params, env) as WeatherAlertsResponse;
  return data.weatherAlerts ?? [];
}

async function sendTelegramMessage(message: string, env: Env): Promise<Response> {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: env.CHAT_ID,
      text: message,
      parse_mode: 'Markdown',
    }),
  });
  return res;
}

// ─── Condition type helpers ──────────────────────────────────────────────────

const CONDITION_META: Record<string, { label: string; emoji: string; severity: number }> = {
  TYPE_UNSPECIFIED:        { label: 'mixed conditions',              emoji: '🌡️', severity: 0 },
  CLEAR:                   { label: 'clear skies',                   emoji: '☀️',  severity: 0 },
  MOSTLY_CLEAR:            { label: 'mostly clear',                  emoji: '🌤️', severity: 0 },
  PARTLY_CLOUDY:           { label: 'partly cloudy',                 emoji: '⛅',  severity: 1 },
  MOSTLY_CLOUDY:           { label: 'mostly cloudy',                 emoji: '☁️',  severity: 2 },
  CLOUDY:                  { label: 'cloudy',                        emoji: '☁️',  severity: 2 },
  WINDY:                   { label: 'windy',                         emoji: '💨',  severity: 3 },
  WIND_AND_RAIN:           { label: 'wind and rain',                 emoji: '🌧️', severity: 5 },
  LIGHT_RAIN_SHOWERS:      { label: 'light rain showers',            emoji: '🌦️', severity: 4 },
  CHANCE_OF_SHOWERS:       { label: 'chance of showers',             emoji: '🌦️', severity: 4 },
  SCATTERED_SHOWERS:       { label: 'scattered showers',             emoji: '🌦️', severity: 4 },
  RAIN_SHOWERS:            { label: 'rain showers',                  emoji: '🌦️', severity: 5 },
  HEAVY_RAIN_SHOWERS:      { label: 'heavy rain showers',            emoji: '🌧️', severity: 6 },
  LIGHT_TO_MODERATE_RAIN:  { label: 'light to moderate rain',        emoji: '🌦️', severity: 4 },
  MODERATE_TO_HEAVY_RAIN:  { label: 'moderate to heavy rain',        emoji: '🌧️', severity: 6 },
  RAIN:                    { label: 'rain',                          emoji: '🌧️', severity: 5 },
  LIGHT_RAIN:              { label: 'light rain',                    emoji: '🌦️', severity: 4 },
  HEAVY_RAIN:              { label: 'heavy rain',                    emoji: '🌧️', severity: 6 },
  RAIN_PERIODICALLY_HEAVY: { label: 'rain, periodically heavy',      emoji: '🌧️', severity: 6 },
  LIGHT_SNOW_SHOWERS:      { label: 'light snow showers',            emoji: '🌨️', severity: 4 },
  CHANCE_OF_SNOW_SHOWERS:  { label: 'chance of snow showers',        emoji: '🌨️', severity: 4 },
  SCATTERED_SNOW_SHOWERS:  { label: 'scattered snow showers',        emoji: '🌨️', severity: 4 },
  SNOW_SHOWERS:            { label: 'snow showers',                  emoji: '🌨️', severity: 5 },
  HEAVY_SNOW_SHOWERS:      { label: 'heavy snow showers',            emoji: '🌨️', severity: 6 },
  LIGHT_TO_MODERATE_SNOW:  { label: 'light to moderate snow',        emoji: '🌨️', severity: 4 },
  MODERATE_TO_HEAVY_SNOW:  { label: 'moderate to heavy snow',        emoji: '❄️',  severity: 6 },
  SNOW:                    { label: 'snow',                          emoji: '🌨️', severity: 5 },
  LIGHT_SNOW:              { label: 'light snow',                    emoji: '🌨️', severity: 4 },
  HEAVY_SNOW:              { label: 'heavy snow',                    emoji: '❄️',  severity: 6 },
  SNOWSTORM:               { label: 'snowstorm',                     emoji: '❄️',  severity: 7 },
  SNOW_PERIODICALLY_HEAVY: { label: 'snow, at times heavy',          emoji: '❄️',  severity: 6 },
  HEAVY_SNOW_STORM:        { label: 'heavy snowstorm',               emoji: '❄️',  severity: 8 },
  BLOWING_SNOW:            { label: 'blowing snow',                  emoji: '🌨️', severity: 5 },
  RAIN_AND_SNOW:           { label: 'rain and snow mix',             emoji: '🌨️', severity: 5 },
  HAIL:                    { label: 'hail',                          emoji: '🌩️', severity: 6 },
  HAIL_SHOWERS:            { label: 'hail showers',                  emoji: '🌩️', severity: 5 },
  THUNDERSTORM:            { label: 'thunderstorm',                  emoji: '⛈️',  severity: 8 },
  THUNDERSHOWER:           { label: 'thundershower',                 emoji: '🌩️', severity: 7 },
  LIGHT_THUNDERSTORM_RAIN: { label: 'light thunderstorm rain',       emoji: '🌩️', severity: 6 },
  SCATTERED_THUNDERSTORMS: { label: 'scattered thunderstorms',       emoji: '⛈️',  severity: 7 },
  HEAVY_THUNDERSTORM:      { label: 'heavy thunderstorm',            emoji: '⛈️',  severity: 9 },
};

function conditionMeta(type: string): { label: string; emoji: string; severity: number } {
  return CONDITION_META[type] ?? { label: 'mixed conditions', emoji: '🌡️', severity: 0 };
}

// Map Google precipitationType to a human-readable alert label and emoji
function precipTypeLabel(type: string): { label: string; emoji: string } {
  switch (type) {
    case 'SNOW':          return { label: 'Snow',          emoji: '🌨️' };
    case 'RAIN':          return { label: 'Rain',          emoji: '🌧️' };
    case 'LIGHT_RAIN':    return { label: 'Light rain',    emoji: '🌦️' };
    case 'HEAVY_RAIN':    return { label: 'Heavy rain',    emoji: '🌧️' };
    case 'RAIN_AND_SNOW': return { label: 'Rain and snow', emoji: '🌨️' };
    case 'SLEET':         return { label: 'Sleet',         emoji: '🌨️' };
    case 'FREEZING_RAIN': return { label: 'Freezing rain', emoji: '🧊' };
    default:              return { label: 'Precipitation', emoji: '🌧️' };
  }
}

function windDescriptor(speedKmh: number): string {
  if (speedKmh < 12) return 'light winds';
  if (speedKmh < 29) return 'moderate winds';
  if (speedKmh < 50) return 'strong winds';
  if (speedKmh < 75) return 'very strong winds';
  return 'storm-force winds';
}

// ─── Clothing recommendation ─────────────────────────────────────────────────

const RAIN_PROB_THRESHOLD = 40;
const WINDY_GUST_THRESHOLD = 40;
const VERY_WINDY_GUST_THRESHOLD = 60;

function clothingHeadline(
  feelsLikeMinDaylight: number,
  rainProb: number,
  gustKmh: number,
  tempMin: number,
  tempMax: number,
): string {
  const wet = rainProb >= RAIN_PROB_THRESHOLD;
  const windy = gustKmh >= WINDY_GUST_THRESHOLD;
  const veryWindy = gustKmh >= VERY_WINDY_GUST_THRESHOLD;

  let garment: string;
  if (feelsLikeMinDaylight >= 18) {
    garment = wet ? '👕 *T-shirt* + 🧥 rain jacket' : '👕 *T-shirt*';
  } else if (feelsLikeMinDaylight >= 12) {
    garment = wet ? '🧶 *Jumper* + 🧥 rain jacket' : '🧶 *Jumper*';
  } else if (feelsLikeMinDaylight >= 5) {
    garment = wet ? '🧥 *Warm jacket* + 🧥 rain jacket' : '🧥 *Warm jacket*';
  } else {
    garment = '🧥 *Warm jacket* + 🧣 scarf';
  }

  const suffix = wet && windy ? ' (windproof recommended)' : '';
  const windyTag = veryWindy ? ' · 💨 windy' : '';

  return `${garment} · ${Math.round(tempMin)}–${Math.round(tempMax)}°${suffix}${windyTag}`;
}

// ─── Weather block builder ───────────────────────────────────────────────────

function buildWeatherBlock(
  hourly: GoogleHourlyResponse,
  today: GoogleDayEntry,
  sunDeltas: { sunrise: number; sunset: number },
  dailyUV: DailyUV,
  uvForecast: UVForecastEntry[],
): string {
  // Rain: peak probability across daylight hours
  let maxRainProb = 0;
  let maxRainHour = -1;
  for (const entry of hourly.forecastHours) {
    const h = entry.displayDateTime.hours;
    if (h < 6 || h > 22) continue;
    const prob = entry.precipitation.probability.percent;
    if (prob > maxRainProb) { maxRainProb = prob; maxRainHour = h; }
  }
  const rainLine = maxRainProb >= 20
    ? `🌧️ Rain: up to ${maxRainProb}% chance (peaks around ${String(maxRainHour).padStart(2, '0')}:00)`
    : `🌂 no rain expected`;

  // UV: 9am · peak · 5pm
  const maxUV = dailyUV.uv_max;
  const maxUVTime = formatTime(dailyUV.uv_max_time);
  const uv9 = uvAtHour(uvForecast, 9);
  const uv17 = uvAtHour(uvForecast, 17);
  const uvParts: string[] = [];
  if (uv9 !== null) uvParts.push(`${uv9.toFixed(1)} (09:00)`);
  uvParts.push(`${maxUV.toFixed(1)} peak @ ${maxUVTime}`);
  if (uv17 !== null) uvParts.push(`${uv17.toFixed(1)} (17:00)`);
  const uvLine = `☀️ UV: ${uvParts.join(' · ')}`;

  // Temp — actual min/max from hourly + daylight feels-like min for clothing
  let minTemp = Infinity, maxTemp = -Infinity, minHour = 0, maxHour = 0;
  let feelsLikeMinDaylight = Infinity;
  for (const entry of hourly.forecastHours) {
    const h = entry.displayDateTime.hours;
    const t = entry.temperature.degrees;
    if (t < minTemp) { minTemp = t; minHour = h; }
    if (t > maxTemp) { maxTemp = t; maxHour = h; }
    if (h >= 7 && h <= 22) {
      const f = entry.feelsLikeTemperature.degrees;
      if (f < feelsLikeMinDaylight) feelsLikeMinDaylight = f;
    }
  }
  const feelsHigh = Math.round(today.feelsLikeMaxTemperature.degrees);
  const feelsLow = Math.round(today.feelsLikeMinTemperature.degrees);
  const tempLine = `🌡️ ${Math.round(minTemp)}° (${String(minHour).padStart(2, '0')}:00) → ${Math.round(maxTemp)}° (${String(maxHour).padStart(2, '0')}:00), feels ${feelsLow}–${feelsHigh}°`;

  // Wind
  const wind = today.daytimeForecast.wind;
  const gustKmh = Math.round(wind.gust.value);
  const windLine = `💨 ${windDescriptor(Math.round(wind.speed.value))}${gustKmh >= 40 ? `, gusts ${gustKmh} km/h` : ''}`;

  // Sun (deltas hidden when |Δ| < 2)
  const sunriseStr = formatTime(today.sunEvents.sunriseTime);
  const sunsetStr = formatTime(today.sunEvents.sunsetTime);
  const sunriseDelta = Math.abs(sunDeltas.sunrise) >= 2 ? ` (${formatTimeDelta(sunDeltas.sunrise)})` : '';
  const sunsetDelta = Math.abs(sunDeltas.sunset) >= 2 ? ` (${formatTimeDelta(sunDeltas.sunset)})` : '';
  const sunLine = `🌅 ${sunriseStr}${sunriseDelta}  🌇 ${sunsetStr}${sunsetDelta}`;

  const headline = clothingHeadline(feelsLikeMinDaylight, maxRainProb, gustKmh, minTemp, maxTemp);

  return [
    headline,
    '',
    tempLine,
    uvLine,
    windLine,
    rainLine,
    '',
    sunLine,
  ].join('\n');
}

// ─── Rain check ──────────────────────────────────────────────────────────────

async function checkRainForecast(env: Env, forceTest = false, hourly?: GoogleHourlyResponse): Promise<void> {
  const url = 'https://api.open-meteo.com/v1/forecast';
  const params = new URLSearchParams({
    latitude: env.LATITUDE,
    longitude: env.LONGITUDE,
    hourly: 'precipitation_probability,precipitation',
    timezone: 'Europe/Amsterdam',
    forecast_days: '1',
  });

  const response = await fetch(`${url}?${params}`);
  const data = await response.json() as OpenMeteoResponse;

  if (!data.hourly || !data.hourly.time) {
    if (forceTest) {
      await sendTelegramMessage(`🌧️ *Rain Check Test*\n\nOpen-Meteo API returned unexpected response:\n\`\`\`\n${JSON.stringify(data, null, 2).slice(0, 500)}\n\`\`\``, env);
    }
    return;
  }

  const now = new Date();
  const amsterdamNow = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Amsterdam' }));
  const currentHour = amsterdamNow.getHours();

  // Look at the next 1 hour only
  const upcomingRain: { time: string; probability: number; mm: number }[] = [];

  for (let i = 0; i < data.hourly.time.length; i++) {
    const forecastDate = new Date(data.hourly.time[i]);
    const forecastHour = forecastDate.getHours();

    if (forecastHour >= currentHour && forecastHour < currentHour + 1) {
      const probability = data.hourly.precipitation_probability[i];
      const mm = data.hourly.precipitation[i];

      if (forceTest || probability >= 50 || mm > 0) {
        upcomingRain.push({
          time: forecastDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' }),
          probability,
          mm,
        });
      }
    }
  }

  const rainDetected = upcomingRain.length > 0;
  const [alertActive, googleHourly] = await Promise.all([
    env.RAIN_STATE.get('rain_alert_active').then(v => v === 'true'),
    hourly ?? getHourlyWeather(env),
  ]);

  const currentEntry = googleHourly.forecastHours.find(e => e.displayDateTime.hours === currentHour);

  if (rainDetected && !alertActive) {
    const maxProbability = Math.max(...upcomingRain.map(r => r.probability));

    // Use Google precipitationType for the alert label if available
    const rawPrecipType = currentEntry?.precipitation.qpf.precipitationType ?? 'NONE';
    const { label: precipLabel, emoji: precipEmoji } = rawPrecipType !== 'NONE'
      ? precipTypeLabel(rawPrecipType)
      : precipTypeLabel('RAIN');

    // Fall back to conditionMeta for the weather condition emoji/label
    const condType = currentEntry?.weatherCondition.type ?? '';
    const { emoji: condEmoji } = conditionMeta(condType);

    const caption = [
      `${condEmoji} *Precipitation Alert for Amsterdam*\n`,
      `${precipEmoji} ${precipLabel} expected in the next hour (up to ${maxProbability}% probability)\n`,
      `\n☂️ Don't forget your umbrella!`,
      `\n[🗺️ View live radar map](https://www.rainviewer.com/map.html?loc=52.3676,4.9041,7)`,
    ].join('\n');

    await sendTelegramMessage(caption, env);
    await env.RAIN_STATE.put('rain_alert_active', 'true');
  } else if (!rainDetected && alertActive) {
    let conditionsText = '';
    if (currentEntry) {
      const temp = Math.round(currentEntry.temperature.degrees);
      const { label, emoji } = conditionMeta(currentEntry.weatherCondition.type);
      conditionsText = `\nCurrent conditions: ${emoji} ${label}, ${temp}°C`;
    }

    const clearedMsg = `☀️ Looks like the rain has passed. No precipitation expected in the next hour.${conditionsText}`;
    await sendTelegramMessage(clearedMsg, env);
    await env.RAIN_STATE.put('rain_alert_active', 'false');
  } else if (forceTest) {
    await sendTelegramMessage(`🧪 *Rain Check Test*\n\nNo rain currently detected (or already alerted).\nKV state: rain_alert_active = ${alertActive}`, env);
  }
}

// ─── Official weather alerts ─────────────────────────────────────────────────

const ALERT_SEVERITY_ORDER = ['EXTREME', 'SEVERE', 'MODERATE', 'MINOR'];

function alertEmoji(eventType: string, severity: string): string {
  const t = eventType.toUpperCase();
  if (t.includes('TORNADO') || t.includes('HURRICANE') || t.includes('TYPHOON')) return '🌪️';
  if (t.includes('THUNDER') || t.includes('LIGHTNING')) return '⛈️';
  if (t.includes('SNOW') || t.includes('BLIZZARD') || t.includes('ICE')) return '❄️';
  if (t.includes('FROST') || t.includes('FREEZE') || t.includes('COLD')) return '🥶';
  if (t.includes('HEAT')) return '🌡️';
  if (t.includes('WIND')) return '💨';
  if (t.includes('FOG')) return '🌫️';
  if (t.includes('FLOOD')) return '🌊';
  if (t.includes('RAIN') || t.includes('PRECIP')) return '🌧️';
  if (t.includes('FIRE')) return '🔥';
  if (severity === 'EXTREME') return '🚨';
  if (severity === 'SEVERE') return '⚠️';
  return '⚠️';
}

async function checkWeatherAlerts(env: Env): Promise<void> {
  const alerts = await getWeatherAlerts(env);

  // Only care about Minor and above, filter out expired and future-only
  const active = alerts.filter(a => {
    if (!ALERT_SEVERITY_ORDER.includes(a.severity)) return false;
    const now = Date.now();
    const start = a.startTime ? new Date(a.startTime).getTime() : 0;
    const expiry = a.expirationTime ? new Date(a.expirationTime).getTime() : Infinity;
    return now >= start && now < expiry;
  });

  // Build id → title map for active alerts
  const activeMap: Record<string, string> = {};
  for (const a of active) activeMap[a.alertId] = a.alertTitle.text;

  // Load previously stored id → title map from KV
  const storedRaw = await env.ALERT_STATE.get('active_alerts');
  const storedMap: Record<string, string> = storedRaw ? JSON.parse(storedRaw) : {};

  // Send messages for new alerts
  for (const alert of active) {
    if (alert.alertId in storedMap) continue;

    const emoji = alertEmoji(alert.eventType, alert.severity);
    const severityLabel = alert.severity.charAt(0) + alert.severity.slice(1).toLowerCase();
    const expiry = alert.expirationTime
      ? `Until ${formatTime(alert.expirationTime)}`
      : '';

    const lines = [
      `${emoji} *${alert.alertTitle.text}*`,
      `${severityLabel} warning · ${alert.areaName}${expiry ? ` · ${expiry}` : ''}`,
    ];
    if (alert.description) lines.push(`\n${alert.description}`);
    if (alert.instruction?.length) lines.push(`\n📋 ${alert.instruction[0]}`);

    await sendTelegramMessage(lines.join('\n'), env);
  }

  // Send cleared messages for alerts that have dropped off
  for (const [id, title] of Object.entries(storedMap)) {
    if (id in activeMap) continue;
    await sendTelegramMessage(`✅ *${title}* has expired or been lifted.`, env);
  }

  // Persist current active id → title map
  await env.ALERT_STATE.put('active_alerts', JSON.stringify(activeMap));
}

// ─── Wind alert ──────────────────────────────────────────────────────────────

const WIND_ALERT_THRESHOLD_KMH = 50;

async function checkWindAlert(env: Env, preloadedHourly?: GoogleHourlyResponse): Promise<void> {
  const hourly = preloadedHourly ?? await getHourlyWeather(env);
  const now = new Date();
  const currentHour = parseInt(now.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'Europe/Amsterdam' }), 10);

  // Look at the next hour
  const upcoming = hourly.forecastHours.filter(e =>
    e.displayDateTime.hours >= currentHour && e.displayDateTime.hours < currentHour + 1
  );

  const gusty = upcoming.filter(e => e.wind.gust.value >= WIND_ALERT_THRESHOLD_KMH);
  const windDetected = gusty.length > 0;
  const alertActive = (await env.WIND_STATE.get('wind_alert_active')) === 'true';

  if (windDetected && !alertActive) {
    const maxGust = Math.max(...gusty.map(e => e.wind.gust.value));
    const msg = [
      `💨 *Wind Alert for Amsterdam*\n`,
      `Gusts up to ${Math.round(maxGust)} km/h expected in the next hour.`,
      `\n⚠️ Secure loose items and be cautious outdoors.`,
    ].join('\n');
    await sendTelegramMessage(msg, env);
    await env.WIND_STATE.put('wind_alert_active', 'true');
  } else if (!windDetected && alertActive) {
    await sendTelegramMessage(`🌬️ Wind has calmed down. Gusts no longer expected above ${WIND_ALERT_THRESHOLD_KMH} km/h.`, env);
    await env.WIND_STATE.put('wind_alert_active', 'false');
  }
}

// ─── Worker ──────────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/test-rain') {
      await checkRainForecast(env, true);
      return new Response('Rain alert test sent to Telegram!');
    }
    if (url.pathname === '/test-wind') {
      await checkWindAlert(env);
      return new Response('Wind alert check triggered — check Telegram!');
    }
    if (url.pathname === '/test-morning') {
      ctx.waitUntil(this.scheduled({ cron: '0 5 * * *' } as ScheduledEvent, env, ctx));
      return new Response('Morning report triggered — check Telegram!');
    }
    if (url.pathname === '/test-alerts') {
      await checkWeatherAlerts(env);
      return new Response('Weather alerts check triggered — check Telegram!');
    }
    return new Response('Use /test-rain, /test-wind, /test-alerts, or /test-morning.');
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    if (event.cron === '*/15 * * * *') {
      const hourly = await getHourlyWeather(env);
      await Promise.all([checkRainForecast(env, false, hourly), checkWindAlert(env, hourly), checkWeatherAlerts(env)]);
      return;
    }

    // Morning report — fetch all data in parallel
    const [dailyData, hourlyWeather, daysWeather, uvForecast] = await Promise.all([
      getDailyUV(env),
      getHourlyWeather(env),
      getDaysWeather(env, 2),
      getUVForecast(env),
    ]);

    const sunDeltas = computeSunDeltas();

    const weatherBlock = buildWeatherBlock(
      hourlyWeather,
      daysWeather.forecastDays[0],
      sunDeltas,
      dailyData,
      uvForecast,
    );

    const message = weatherBlock;

    await sendTelegramMessage(message, env);
  },
};

// Approximate how many minutes earlier sunrise is today vs yesterday, and how many
// minutes later sunset is. Uses the seasonal rate of change (peaks ~2.5 min/day at
// equinoxes, near zero at solstices).
function computeSunDeltas(): { sunrise: number; sunset: number } {
  const today = new Date();
  const dayOfYear = Math.floor((today.getTime() - new Date(today.getFullYear(), 0, 0).getTime()) / 86400000);
  const delta = Math.round(2.5 * Math.sin((2 * Math.PI * (dayOfYear - 80)) / 365));
  return { sunrise: delta, sunset: delta };
}
