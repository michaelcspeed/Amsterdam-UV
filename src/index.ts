/// <reference types="@cloudflare/workers-types" />

interface Env {
  TELEGRAM_BOT_TOKEN: string;
  CHAT_ID: string;
  OPENUV_API_KEY: string;
  LATITUDE: string;
  LONGITUDE: string;
}

interface UVForecast {
  uv: number;
  uv_time: string;
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

interface OpenUVForecastResponse {
  result: UVForecast[];
}

interface OpenUVDailyResponse {
  result: DailyUV;
}

function getUVDescription(uvIndex: number): string {
  if (uvIndex < 3) return "Low ✅";
  if (uvIndex < 6) return "Moderate 🟨";
  if (uvIndex < 8) return "High 🟧";
  if (uvIndex < 11) return "Very High 🟥";
  return "Extreme 🟪";
}

function formatTime(timeStr: string): string {
  const date = new Date(timeStr);
  return date.toLocaleTimeString('en-GB', { 
    hour: '2-digit', 
    minute: '2-digit',
    timeZone: 'Europe/Amsterdam'
  });
}

function formatExposureTime(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  
  if (hours === 0) return `${mins} min`;
  if (mins === 0) return `${hours} hr`;
  return `${hours} hr ${mins} min`;
}

function createUVGraph(forecastData: UVForecast[]): string {
  return forecastData
    .map(entry => {
      const uv = entry.uv;
      const time = formatTime(entry.uv_time);
      const bar = '█'.repeat(Math.floor(uv * 2));
      return `${time}: ${bar} ${uv.toFixed(1)}`;
    })
    .join('\n');
}

async function getUVForecast(env: Env): Promise<UVForecast[]> {
  const url = 'https://api.openuv.io/api/v1/forecast';
  const params = new URLSearchParams({
    lat: env.LATITUDE,
    lng: env.LONGITUDE,
    alt: '0',
  });

  const response = await fetch(`${url}?${params}`, {
    headers: {
      'x-access-token': env.OPENUV_API_KEY,
    },
  });

  const data = await response.json() as OpenUVForecastResponse;
  return data.result;
}

async function getDailyUV(env: Env): Promise<DailyUV> {
  const url = 'https://api.openuv.io/api/v1/uv';
  const params = new URLSearchParams({
    lat: env.LATITUDE,
    lng: env.LONGITUDE,
    alt: '0',
  });

  const response = await fetch(`${url}?${params}`, {
    headers: {
      'x-access-token': env.OPENUV_API_KEY,
    },
  });

  const data = await response.json() as OpenUVDailyResponse;
  return data.result;
}

async function sendTelegramMessage(message: string, env: Env): Promise<void> {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      chat_id: env.CHAT_ID,
      text: message,
      parse_mode: 'Markdown',
    }),
  });
}

export default {
  // Add fetch handler for local development
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return new Response('This worker only responds to scheduled events. Use `wrangler dev --test-scheduled` for testing.');
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const forecastData = await getUVForecast(env);
    const dailyData = await getDailyUV(env);

    const currentDate = new Date().toLocaleDateString('en-GB', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: 'Europe/Amsterdam',
    });

    const maxUV = dailyData.uv_max;
    const maxUVTime = formatTime(dailyData.uv_max_time);
    const maxUVDescription = getUVDescription(maxUV);
    const graph = createUVGraph(forecastData);

    const sunTimes = dailyData.sun_info.sun_times;
    const sunrise = formatTime(sunTimes.sunrise);
    const sunset = formatTime(sunTimes.sunset);
    const goldenHourMorning = formatTime(sunTimes.goldenHourEnd);
    const goldenHourEvening = formatTime(sunTimes.goldenHour);

    const safeExposureTime = dailyData.safe_exposure_time;

    const message = [
      "☀️ *Daily UV Index Report for Amsterdam* ☀️\n",
      `🔆 Max Today: *${maxUV.toFixed(1)}* @ ${maxUVTime} (${maxUVDescription})\n`,
      "Hourly UV Index Forecast:",
      "```",
      graph,
      "```\n",
      `🌅 Sunrise: ${sunrise}`,
      `🌇 Sunset: ${sunset}`,
      `✨ Morning Golden Hour ends: ${goldenHourMorning}`,
      `✨ Evening Golden Hour starts: ${goldenHourEvening}\n`,
      "⏱️ Safe Exposure Time at max UV:",
      `  • Very fair skin: ${formatExposureTime(safeExposureTime.st1)}`,
      `  • Fair skin: ${formatExposureTime(safeExposureTime.st2)}`,
      `  • Light skin: ${formatExposureTime(safeExposureTime.st3)}`,
      `  • Light brown skin: ${formatExposureTime(safeExposureTime.st4)}`,
      `  • Brown skin: ${formatExposureTime(safeExposureTime.st5)}`,
      `  • Dark brown/Black skin: ${formatExposureTime(safeExposureTime.st6)}\n`,
    ].join('\n');

    await sendTelegramMessage(message, env);
  },
}; 