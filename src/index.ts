/// <reference types="@cloudflare/workers-types" />

interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
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
    st1: number | null;
    st2: number | null;
    st3: number | null;
    st4: number | null;
    st5: number | null;
    st6: number | null;
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
    weathercode: number[];
    windspeed_10m: number[];
    windgusts_10m: number[];
    temperature_2m: number[];
    apparent_temperature: number[];
  };
}

interface WeatherSnapshot {
  probability: number;
  mm: number;
  weatherCode: number;
  windSpeedKmh: number;
  windGustKmh: number;
  tempC: number;
  feelsLikeC: number;
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

// Escape user/API-provided text for Telegram HTML parse mode.
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── API calls ──────────────────────────────────────────────────────────────


interface Coords {
  lat: string;
  lng: string;
  custom: boolean;
}

const CUSTOM_LOCATION_KEY = 'custom_location';

async function getActiveCoords(env: Env): Promise<Coords> {
  const stored = await env.ALERT_STATE.get(CUSTOM_LOCATION_KEY);
  if (stored) {
    const { lat, lng } = JSON.parse(stored) as { lat: number; lng: number };
    return { lat: String(lat), lng: String(lng), custom: true };
  }
  return { lat: env.LATITUDE, lng: env.LONGITUDE, custom: false };
}

// "📍 Custom location (…)" banner for messages sent while a custom location is set.
function locationTag(coords: Coords): string {
  return coords.custom
    ? `📍 <i>Custom location (${Number(coords.lat).toFixed(3)}, ${Number(coords.lng).toFixed(3)})</i>\n\n`
    : '';
}

// "Amsterdam" or "custom location" for use inside sentences/titles.
function placeName(coords: Coords): string {
  return coords.custom ? 'custom location' : 'Amsterdam';
}

async function getDailyUV(env: Env, coords: Coords): Promise<DailyUV> {
  const url = 'https://api.openuv.io/api/v1/uv';
  const params = new URLSearchParams({ lat: coords.lat, lng: coords.lng, alt: '0' });
  const response = await fetch(`${url}?${params}`, {
    headers: { 'x-access-token': env.OPENUV_API_KEY },
  });
  const data = await response.json() as OpenUVDailyResponse;
  return data.result;
}

async function getUVForecast(env: Env, coords: Coords): Promise<UVForecastEntry[]> {
  const url = 'https://api.openuv.io/api/v1/forecast';
  const params = new URLSearchParams({ lat: coords.lat, lng: coords.lng, alt: '0' });
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
    await sendTelegramMessage(`⚠️ <b>Google Weather API quota reached</b>\n\nDaily limit hit — weather data unavailable until tomorrow.`, env);
    throw new GoogleQuotaError('Google Weather API quota exceeded');
  }
  if (!response.ok) {
    await sendTelegramMessage(`⚠️ <b>Google Weather API error</b>\n\nRequest returned HTTP ${response.status} — some weather data may be unavailable.`, env);
    throw new GoogleAPIError(`Google Weather API returned ${response.status}`);
  }
  return response.json();
}

async function getHourlyWeather(env: Env, coords: Coords): Promise<GoogleHourlyResponse> {
  const url = 'https://weather.googleapis.com/v1/forecast/hours:lookup';
  const params = new URLSearchParams({
    key: env.GOOGLE_WEATHER_API_KEY,
    'location.latitude': coords.lat,
    'location.longitude': coords.lng,
    hours: '24',
  });
  return googleFetch(url, params, env) as Promise<GoogleHourlyResponse>;
}

async function getDaysWeather(env: Env, coords: Coords, days = 2): Promise<GoogleDaysResponse> {
  const url = 'https://weather.googleapis.com/v1/forecast/days:lookup';
  const params = new URLSearchParams({
    key: env.GOOGLE_WEATHER_API_KEY,
    'location.latitude': coords.lat,
    'location.longitude': coords.lng,
    days: String(days),
  });
  return googleFetch(url, params, env) as Promise<GoogleDaysResponse>;
}

async function getWeatherAlerts(env: Env, coords: Coords): Promise<WeatherAlert[]> {
  const url = 'https://weather.googleapis.com/v1/publicAlerts:lookup';
  const params = new URLSearchParams({
    key: env.GOOGLE_WEATHER_API_KEY,
    'location.latitude': coords.lat,
    'location.longitude': coords.lng,
    languageCode: 'en',
  });
  const data = await googleFetch(url, params, env) as WeatherAlertsResponse;
  return data.weatherAlerts ?? [];
}

// Persistent reply keyboard: location-request button + reset button.
const LOCATION_KEYBOARD = {
  keyboard: [[
    { text: '📍 Set current location', request_location: true },
    { text: '🏠 Reset to Amsterdam' },
  ]],
  resize_keyboard: true,
  is_persistent: true,
};

async function sendTelegramMessage(message: string, env: Env, withKeyboard = false): Promise<Response> {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const post = (text: string) => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: env.CHAT_ID,
      text,
      parse_mode: 'HTML',
      ...(withKeyboard ? { reply_markup: LOCATION_KEYBOARD } : {}),
    }),
  });

  const res = await post(message);
  // Telegram documents that `pre` "cannot be combined with any other format", and
  // it's unspecified whether a <pre> chart nested in <blockquote expandable> parses.
  // If it doesn't, lose the collapse rather than the whole briefing.
  if (!res.ok && message.includes('<blockquote')) {
    return post(message.replace(/<\/?blockquote(?: expandable)?>/g, ''));
  }
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

// WMO weather interpretation codes (Open-Meteo) → display + precip labels.
const WMO_META: Record<number, { condLabel: string; condEmoji: string; precipLabel: string; precipEmoji: string }> = {
  0:  { condLabel: 'clear skies',            condEmoji: '☀️',  precipLabel: 'Precipitation',    precipEmoji: '🌧️' },
  1:  { condLabel: 'mainly clear',           condEmoji: '🌤️', precipLabel: 'Precipitation',    precipEmoji: '🌧️' },
  2:  { condLabel: 'partly cloudy',          condEmoji: '⛅',  precipLabel: 'Precipitation',    precipEmoji: '🌧️' },
  3:  { condLabel: 'overcast',               condEmoji: '☁️',  precipLabel: 'Precipitation',    precipEmoji: '🌧️' },
  45: { condLabel: 'fog',                    condEmoji: '🌫️', precipLabel: 'Precipitation',    precipEmoji: '🌧️' },
  48: { condLabel: 'freezing fog',           condEmoji: '🌫️', precipLabel: 'Precipitation',    precipEmoji: '🌧️' },
  51: { condLabel: 'light drizzle',          condEmoji: '🌦️', precipLabel: 'Light drizzle',    precipEmoji: '🌦️' },
  53: { condLabel: 'drizzle',                condEmoji: '🌦️', precipLabel: 'Drizzle',          precipEmoji: '🌦️' },
  55: { condLabel: 'dense drizzle',          condEmoji: '🌧️', precipLabel: 'Dense drizzle',    precipEmoji: '🌧️' },
  56: { condLabel: 'freezing drizzle',       condEmoji: '🧊',  precipLabel: 'Freezing drizzle', precipEmoji: '🧊'  },
  57: { condLabel: 'dense freezing drizzle', condEmoji: '🧊',  precipLabel: 'Freezing drizzle', precipEmoji: '🧊'  },
  61: { condLabel: 'light rain',             condEmoji: '🌦️', precipLabel: 'Light rain',       precipEmoji: '🌦️' },
  63: { condLabel: 'rain',                   condEmoji: '🌧️', precipLabel: 'Rain',             precipEmoji: '🌧️' },
  65: { condLabel: 'heavy rain',             condEmoji: '🌧️', precipLabel: 'Heavy rain',       precipEmoji: '🌧️' },
  66: { condLabel: 'freezing rain',          condEmoji: '🧊',  precipLabel: 'Freezing rain',    precipEmoji: '🧊'  },
  67: { condLabel: 'heavy freezing rain',    condEmoji: '🧊',  precipLabel: 'Freezing rain',    precipEmoji: '🧊'  },
  71: { condLabel: 'light snow',             condEmoji: '🌨️', precipLabel: 'Light snow',       precipEmoji: '🌨️' },
  73: { condLabel: 'snow',                   condEmoji: '🌨️', precipLabel: 'Snow',             precipEmoji: '🌨️' },
  75: { condLabel: 'heavy snow',             condEmoji: '❄️',  precipLabel: 'Heavy snow',       precipEmoji: '❄️'  },
  77: { condLabel: 'snow grains',            condEmoji: '🌨️', precipLabel: 'Snow grains',      precipEmoji: '🌨️' },
  80: { condLabel: 'light rain showers',     condEmoji: '🌦️', precipLabel: 'Light showers',    precipEmoji: '🌦️' },
  81: { condLabel: 'rain showers',           condEmoji: '🌦️', precipLabel: 'Showers',          precipEmoji: '🌦️' },
  82: { condLabel: 'violent rain showers',   condEmoji: '🌧️', precipLabel: 'Heavy showers',    precipEmoji: '🌧️' },
  85: { condLabel: 'light snow showers',     condEmoji: '🌨️', precipLabel: 'Snow showers',     precipEmoji: '🌨️' },
  86: { condLabel: 'heavy snow showers',     condEmoji: '❄️',  precipLabel: 'Heavy snow',       precipEmoji: '❄️'  },
  95: { condLabel: 'thunderstorm',           condEmoji: '⛈️',  precipLabel: 'Thunderstorm',     precipEmoji: '⛈️'  },
  96: { condLabel: 'thunderstorm with hail', condEmoji: '⛈️',  precipLabel: 'Thunderstorm',     precipEmoji: '⛈️'  },
  99: { condLabel: 'severe thunderstorm',    condEmoji: '⛈️',  precipLabel: 'Thunderstorm',     precipEmoji: '⛈️'  },
};

function wmoMeta(code: number) {
  return WMO_META[code] ?? { condLabel: 'mixed conditions', condEmoji: '🌡️', precipLabel: 'Precipitation', precipEmoji: '🌧️' };
}

function windDescriptor(speedKmh: number): string {
  if (speedKmh < 12) return 'light';
  if (speedKmh < 29) return 'moderate';
  if (speedKmh < 50) return 'strong';
  if (speedKmh < 75) return 'very strong';
  return 'storm-force';
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
    garment = wet ? '👕 T-shirt + 🧥 rain jacket' : '👕 T-shirt';
  } else if (feelsLikeMinDaylight >= 12) {
    garment = wet ? '🧶 Jumper + 🧥 rain jacket' : '🧶 Jumper';
  } else if (feelsLikeMinDaylight >= 5) {
    garment = wet ? '🧥 Warm jacket + 🧥 rain jacket' : '🧥 Warm jacket';
  } else {
    garment = '🧥 Warm jacket + 🧣 scarf';
  }

  const suffix = wet && windy ? ' (windproof recommended)' : '';
  const windyTag = veryWindy ? ' · 💨 windy' : '';

  return `${garment} · ${Math.round(tempMin)}–${Math.round(tempMax)}°${suffix}${windyTag}`;
}

// ─── Rain chart ──────────────────────────────────────────────────────────────

const RAIN_BAR_WIDTH = 12;
// A full bar means 1 mm/hr (light-to-moderate rain) unless the day is wetter than
// that, so Dutch drizzle reads as drizzle instead of filling the chart every time.
const RAIN_BAR_MIN_SCALE_MM = 1;
// Google's qpf granularity is 0.1mm; below this an hour is dry for display purposes.
const RAIN_DRY_MM = 0.05;

interface RainHour {
  hour: number;
  mm: number;
  prob: number;
}

// The hourly endpoint returns a rolling 24h, so cut at the midnight wrap to get
// "the rest of today". Late-evening on-demand reports would be left with a one-
// or two-row chart, so fall back to a flat next-6-hours window.
function todaysRainHours(hourly: GoogleHourlyResponse): RainHour[] {
  const all: RainHour[] = hourly.forecastHours.map(entry => ({
    hour: entry.displayDateTime.hours,
    mm: entry.precipitation.qpf.quantity,
    prob: entry.precipitation.probability.percent,
  }));
  const wrap = all.findIndex((row, i) => i > 0 && row.hour < all[i - 1].hour);
  const today = wrap === -1 ? all : all.slice(0, wrap);
  return today.length >= 6 ? today : all.slice(0, 6);
}

// brolly.sh-style hourly rainfall chart, collapsed behind an expandable blockquote.
// Null when nothing is forecast to fall — the summary line already covers that.
function buildRainChart(rows: RainHour[]): string | null {
  const peakMm = Math.max(...rows.map(r => r.mm));
  if (peakMm < RAIN_DRY_MM) return null;

  const scale = Math.max(peakMm, RAIN_BAR_MIN_SCALE_MM);
  const lines = [`hr ${'rainfall'.padEnd(RAIN_BAR_WIDTH)} ${'mm'.padStart(4)} prob`];
  for (const r of rows) {
    const wet = r.mm >= RAIN_DRY_MM;
    // Any measurable rain gets at least one block, so a wet hour never looks dry.
    const bar = wet ? '█'.repeat(Math.max(1, Math.round((r.mm / scale) * RAIN_BAR_WIDTH))) : '';
    const mm = !wet ? '·' : r.mm >= 10 ? String(Math.round(r.mm)) : r.mm.toFixed(1);
    lines.push(
      `${String(r.hour).padStart(2, '0')} ${bar.padEnd(RAIN_BAR_WIDTH)} ${mm.padStart(4)} ${String(r.prob).padStart(3)}%`,
    );
  }
  return `<blockquote expandable><pre>${lines.join('\n')}</pre></blockquote>`;
}

// ─── Weather block builder ───────────────────────────────────────────────────

function buildWeatherBlock(
  hourly: GoogleHourlyResponse,
  today: GoogleDayEntry,
  sunDeltas: { sunrise: number; sunset: number } | null,
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
  const rainRows = todaysRainHours(hourly);
  const rainChart = buildRainChart(rainRows);

  let rainLine: string;
  if (rainChart) {
    const totalMm = rainRows.reduce((sum, r) => sum + r.mm, 0);
    const heaviest = rainRows.reduce((a, b) => (b.mm > a.mm ? b : a));
    rainLine = `🌧️ up to <b>${maxRainProb}%</b> chance · <b>${totalMm.toFixed(1)}mm</b> <i>(heaviest ${String(heaviest.hour).padStart(2, '0')}:00)</i>`;
  } else if (maxRainProb >= 20) {
    rainLine = `🌧️ up to <b>${maxRainProb}%</b> chance <i>(peaks around ${String(maxRainHour).padStart(2, '0')}:00)</i>`;
  } else {
    rainLine = `🌂 <i>no rain expected</i>`;
  }

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
  const tempLine = `🌡️ <b>${Math.round(minTemp)}°</b> (${String(minHour).padStart(2, '0')}:00) → <b>${Math.round(maxTemp)}°</b> (${String(maxHour).padStart(2, '0')}:00), <i>feels ${feelsLow}–${feelsHigh}°</i>`;

  // Wind
  const wind = today.daytimeForecast.wind;
  const gustKmh = Math.round(wind.gust.value);
  const windLine = `💨 <b>${windDescriptor(Math.round(wind.speed.value))}</b>${gustKmh >= 40 ? ` <i>· gusts ${gustKmh} km/h</i>` : ''}`;

  const headline = clothingHeadline(feelsLikeMinDaylight, maxRainProb, gustKmh, minTemp, maxTemp);

  const lines = [
    `<b>${headline}</b>`,
    '',
    tempLine,
    windLine,
    rainLine,
  ];

  if (rainChart) lines.push(rainChart);

  // Sun line skipped for custom locations (times would be in Amsterdam TZ).
  if (sunDeltas) {
    const sunriseStr = formatTime(today.sunEvents.sunriseTime);
    const sunsetStr = formatTime(today.sunEvents.sunsetTime);
    const sunriseDelta = Math.abs(sunDeltas.sunrise) >= 2 ? ` <i>(${formatTimeDelta(sunDeltas.sunrise)})</i>` : '';
    const sunsetDelta = Math.abs(sunDeltas.sunset) >= 2 ? ` <i>(${formatTimeDelta(sunDeltas.sunset)})</i>` : '';
    lines.push('', `🌅 ${sunriseStr}${sunriseDelta}  🌇 ${sunsetStr}${sunsetDelta}`);
  }

  return lines.join('\n');
}

// ─── UV block builder ────────────────────────────────────────────────────────

function uvCategory(uv: number): { label: string; emoji: string } {
  if (uv < 3) return { label: 'Low', emoji: '🟩' };
  if (uv < 6) return { label: 'Moderate', emoji: '🟨' };
  if (uv < 8) return { label: 'High', emoji: '🟧' };
  if (uv < 11) return { label: 'Very High', emoji: '🟥' };
  return { label: 'Extreme', emoji: '🟪' };
}

function formatExposure(minutes: number | null): string {
  if (minutes == null) return 'unlimited';
  if (minutes >= 16 * 60) return 'all day';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
}

function buildUVBlock(dailyUV: DailyUV, uvForecast: UVForecastEntry[]): string {
  const maxUV = dailyUV.uv_max;
  const maxUVTime = formatTime(dailyUV.uv_max_time);
  const { label, emoji } = uvCategory(maxUV);
  const header = `☀️ <b>Max Today: ${maxUV.toFixed(1)}</b> @ ${maxUVTime} (${label} ${emoji})`;

  const chartLines = uvForecast.map(entry => {
    const time = formatTime(entry.uv_time);
    const bar = '█'.repeat(Math.round(entry.uv * 1.5));
    return `${time}: ${bar ? `${bar} ` : ''}${entry.uv.toFixed(1)}`;
  });
  const chart = `Hourly UV Index Forecast:\n<pre>${chartLines.join('\n')}</pre>`;

  // OpenUV's safe_exposure_time is computed at the UV level at request time
  // (~07:00, near zero), not at the daily peak — so compute at uv_max ourselves.
  // Same formula OpenUV uses: minutes = 200 × skinFactor / (3 × UV).
  const skinFactors = [1, 1.2, 1.6, 2, 3.2, 6];
  const atPeak = maxUV > 0
    ? skinFactors.map(f => Math.round((200 * f) / (3 * maxUV)))
    : skinFactors.map(() => null);
  const exposureLines = [
    `⏱️ <b>Max Sun Exposure (daily budget at peak UV):</b>`,
    `  • Very fair skin: ${formatExposure(atPeak[0])}`,
    `  • Fair skin: ${formatExposure(atPeak[1])}`,
    `  • Light skin: ${formatExposure(atPeak[2])}`,
    `  • Light brown skin: ${formatExposure(atPeak[3])}`,
    `  • Brown skin: ${formatExposure(atPeak[4])}`,
    `  • Dark brown/Black skin: ${formatExposure(atPeak[5])}`,
  ];
  if (atPeak[0] != null) {
    exposureLines.push(
      `\n🧴 Very fair skin with sunscreen <i>(reapply every 2 hr)</i>:`,
      `  • SPF 30: ${formatExposure(atPeak[0] * 30)}`,
      `  • SPF 50: ${formatExposure(atPeak[0] * 50)}`,
    );
  }

  return [header, '', chart, '', exposureLines.join('\n')].join('\n');
}

// ─── Open-Meteo snapshot ────────────────────────────────────────────────────

async function getOpenMeteoSnapshot(env: Env, coords: Coords): Promise<WeatherSnapshot | null> {
  const url = 'https://api.open-meteo.com/v1/forecast';
  const params = new URLSearchParams({
    latitude: coords.lat,
    longitude: coords.lng,
    hourly: 'precipitation_probability,precipitation,weathercode,windspeed_10m,windgusts_10m,temperature_2m,apparent_temperature',
    timezone: 'Europe/Amsterdam',
    forecast_days: '1',
  });

  const response = await fetch(`${url}?${params}`);
  const data = await response.json() as OpenMeteoResponse;

  if (!data.hourly?.time) return null;

  const amsterdamNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Amsterdam' }));
  const currentHour = amsterdamNow.getHours();

  for (let i = 0; i < data.hourly.time.length; i++) {
    if (new Date(data.hourly.time[i]).getHours() === currentHour) {
      return {
        probability: data.hourly.precipitation_probability[i],
        mm: data.hourly.precipitation[i],
        weatherCode: data.hourly.weathercode[i],
        windSpeedKmh: data.hourly.windspeed_10m[i],
        windGustKmh: data.hourly.windgusts_10m[i],
        tempC: data.hourly.temperature_2m[i],
        feelsLikeC: data.hourly.apparent_temperature[i],
      };
    }
  }
  return null;
}

// ─── Rain check ──────────────────────────────────────────────────────────────

async function checkRainForecast(env: Env, coords: Coords, forceTest = false, snapshot?: WeatherSnapshot): Promise<void> {
  const s = snapshot ?? await getOpenMeteoSnapshot(env, coords);

  if (!s) {
    if (forceTest) {
      await sendTelegramMessage(`🌧️ <b>Rain Check Test</b>\n\nOpen-Meteo API returned no usable data for the current hour.`, env);
    }
    return;
  }

  const rainDetected = forceTest || s.probability >= 50 || s.mm > 0;
  const alertActive = (await env.RAIN_STATE.get('rain_alert_active')) === 'true';

  if (rainDetected && !alertActive) {
    const { precipLabel, precipEmoji, condEmoji } = wmoMeta(s.weatherCode);
    const caption = [
      `${locationTag(coords)}${condEmoji} <b>Precipitation Alert for ${placeName(coords)}</b>\n`,
      `${precipEmoji} ${precipLabel} expected in the next hour (up to <b>${s.probability}%</b> probability)\n`,
      `\n☂️ Don't forget your umbrella!`,
      `\n<a href="https://www.rainviewer.com/map.html?loc=${coords.lat},${coords.lng},7">🗺️ View live radar map</a>`,
    ].join('\n');

    await sendTelegramMessage(caption, env);
    await env.RAIN_STATE.put('rain_alert_active', 'true');
  } else if (!rainDetected && alertActive) {
    const { condLabel, condEmoji } = wmoMeta(s.weatherCode);
    const clearedMsg = `☀️ Looks like the rain has passed. No precipitation expected in the next hour.\nCurrent conditions: ${condEmoji} ${condLabel}, <b>${Math.round(s.tempC)}°C</b>`;
    await sendTelegramMessage(clearedMsg, env);
    await env.RAIN_STATE.put('rain_alert_active', 'false');
  } else if (forceTest) {
    await sendTelegramMessage(`🧪 <b>Rain Check Test</b>\n\nNo rain currently detected (or already alerted).\nKV state: rain_alert_active = ${alertActive}`, env);
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

async function checkWeatherAlerts(env: Env, coords: Coords): Promise<void> {
  const alerts = await getWeatherAlerts(env, coords);

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
      `${locationTag(coords)}${emoji} <b>${escapeHtml(alert.alertTitle.text)}</b>`,
      `${severityLabel} warning · ${escapeHtml(alert.areaName)}${expiry ? ` · ${expiry}` : ''}`,
    ];
    if (alert.description) lines.push(`\n${escapeHtml(alert.description)}`);
    if (alert.instruction?.length) lines.push(`\n📋 ${escapeHtml(alert.instruction[0])}`);

    await sendTelegramMessage(lines.join('\n'), env);
  }

  // Send cleared messages for alerts that have dropped off
  for (const [id, title] of Object.entries(storedMap)) {
    if (id in activeMap) continue;
    await sendTelegramMessage(`✅ <b>${escapeHtml(title)}</b> has expired or been lifted.`, env);
  }

  // Persist current active id → title map
  await env.ALERT_STATE.put('active_alerts', JSON.stringify(activeMap));
}

// ─── Wind alert ──────────────────────────────────────────────────────────────

const WIND_ALERT_THRESHOLD_KMH = 50;

async function checkWindAlert(env: Env, coords: Coords, snapshot?: WeatherSnapshot): Promise<void> {
  const s = snapshot ?? await getOpenMeteoSnapshot(env, coords);
  if (!s) return;

  const windDetected = s.windGustKmh >= WIND_ALERT_THRESHOLD_KMH;
  const alertActive = (await env.WIND_STATE.get('wind_alert_active')) === 'true';

  if (windDetected && !alertActive) {
    const msg = [
      `${locationTag(coords)}💨 <b>Wind Alert for ${placeName(coords)}</b>\n`,
      `Gusts up to <b>${Math.round(s.windGustKmh)} km/h</b> expected in the next hour.`,
      `\n⚠️ Secure loose items and be cautious outdoors.`,
    ].join('\n');
    await sendTelegramMessage(msg, env);
    await env.WIND_STATE.put('wind_alert_active', 'true');
  } else if (!windDetected && alertActive) {
    await sendTelegramMessage(`🌬️ Wind has calmed down. Gusts no longer expected above ${WIND_ALERT_THRESHOLD_KMH} km/h.`, env);
    await env.WIND_STATE.put('wind_alert_active', 'false');
  }
}

// ─── Full report (morning cron + on-demand via Telegram) ────────────────────

async function sendFullReport(env: Env, coords: Coords): Promise<void> {
  const [dailyData, hourlyWeather, daysWeather, uvForecast] = await Promise.all([
    getDailyUV(env, coords),
    getHourlyWeather(env, coords),
    getDaysWeather(env, coords, 2),
    getUVForecast(env, coords),
  ]);

  const weatherBlock = buildWeatherBlock(
    hourlyWeather,
    daysWeather.forecastDays[0],
    coords.custom ? null : computeSunDeltas(),
  );

  await sendTelegramMessage(locationTag(coords) + weatherBlock, env, true);
  await sendTelegramMessage(buildUVBlock(dailyData, uvForecast), env, true);
}

// ─── Telegram webhook ────────────────────────────────────────────────────────

interface TelegramUpdate {
  message?: {
    chat: { id: number };
    text?: string;
    location?: { latitude: number; longitude: number };
  };
}

async function handleTelegramWebhook(request: Request, env: Env): Promise<Response> {
  if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response('forbidden', { status: 403 });
  }

  // Alert state belongs to the previous location — reset on any location change
  // so we don't send bogus "rain has passed" / "alert lifted" messages.
  const clearAlertStates = () => Promise.all([
    env.RAIN_STATE.put('rain_alert_active', 'false'),
    env.WIND_STATE.put('wind_alert_active', 'false'),
    env.ALERT_STATE.delete('active_alerts'),
  ]);

  const update = await request.json() as TelegramUpdate;
  const msg = update.message;
  // Always ack with 200 so Telegram doesn't retry.
  if (!msg || String(msg.chat.id) !== env.CHAT_ID) return new Response('ok');

  if (msg.location) {
    const { latitude, longitude } = msg.location;
    await env.ALERT_STATE.put(CUSTOM_LOCATION_KEY, JSON.stringify({ lat: latitude, lng: longitude }));
    await clearAlertStates();
    await sendFullReport(env, { lat: String(latitude), lng: String(longitude), custom: true });
    return new Response('ok');
  }

  if (msg.text?.startsWith('🏠') || msg.text === '/reset') {
    await env.ALERT_STATE.delete(CUSTOM_LOCATION_KEY);
    await clearAlertStates();
    await sendTelegramMessage('🏠 Location reset to Amsterdam.', env, true);
    await sendFullReport(env, { lat: env.LATITUDE, lng: env.LONGITUDE, custom: false });
    return new Response('ok');
  }

  // Any other text: send report for the active location.
  await sendFullReport(env, await getActiveCoords(env));
  return new Response('ok');
}

async function registerWebhook(request: Request, env: Env): Promise<Response> {
  const workerUrl = new URL(request.url);
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: `${workerUrl.origin}/telegram`,
      secret_token: env.TELEGRAM_WEBHOOK_SECRET,
      allowed_updates: ['message'],
    }),
  });
  return new Response(await res.text());
}

// ─── Worker ──────────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/telegram' && request.method === 'POST') {
      return handleTelegramWebhook(request, env);
    }
    if (url.pathname === '/setup-webhook') {
      return registerWebhook(request, env);
    }
    if (url.pathname === '/webhook-info') {
      const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getWebhookInfo`);
      return new Response(await res.text());
    }
    if (url.pathname === '/test-rain') {
      await checkRainForecast(env, await getActiveCoords(env), true);
      return new Response('Rain alert test sent to Telegram!');
    }
    if (url.pathname === '/test-wind') {
      await checkWindAlert(env, await getActiveCoords(env));
      return new Response('Wind alert check triggered — check Telegram!');
    }
    if (url.pathname === '/test-morning') {
      ctx.waitUntil(this.scheduled({ cron: '0 5 * * *' } as ScheduledEvent, env, ctx));
      return new Response('Morning report triggered — check Telegram!');
    }
    if (url.pathname === '/test-alerts') {
      await checkWeatherAlerts(env, await getActiveCoords(env));
      return new Response('Weather alerts check triggered — check Telegram!');
    }
    return new Response('Use /test-rain, /test-wind, /test-alerts, or /test-morning.');
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    if (event.cron === '*/5 * * * *') {
      const coords = await getActiveCoords(env);
      const snapshot = await getOpenMeteoSnapshot(env, coords);
      if (snapshot) {
        await Promise.all([checkRainForecast(env, coords, false, snapshot), checkWindAlert(env, coords, snapshot)]);
      }
      return;
    }

    if (event.cron === '*/30 * * * *') {
      await checkWeatherAlerts(env, await getActiveCoords(env));
      return;
    }

    // Morning report — uses custom location if one is set
    await sendFullReport(env, await getActiveCoords(env));
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
