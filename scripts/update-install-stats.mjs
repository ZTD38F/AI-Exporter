#!/usr/bin/env node

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BOOTSTRAP_START_DATE = '2026-08-30';
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

function utcDate(date) {
  return date.toISOString().slice(0, 10);
}

export function getQueryRange(today = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(today);
  const datePart = (type) => parts.find((part) => part.type === type)?.value;
  const localToday = `${datePart('year')}-${datePart('month')}-${datePart('day')}`;
  const yesterday = new Date(`${localToday}T00:00:00Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const rangeStart = new Date(yesterday);
  rangeStart.setUTCDate(rangeStart.getUTCDate() - 59);
  return { startDate: utcDate(rangeStart), endDate: utcDate(yesterday) };
}

export function getHistoryRange(queryRange) {
  if (queryRange.startDate >= BOOTSTRAP_START_DATE) return queryRange;
  return { ...queryRange, startDate: BOOTSTRAP_START_DATE };
}

export function mergeHistory(existing, returnedRows, { startDate, endDate }) {
  const daily = new Map();
  for (const row of existing) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date) || !Number.isSafeInteger(row.installs) || row.installs < 0) {
      throw new Error('Existing install history contains an invalid row.');
    }
    daily.set(row.date, row.installs);
  }

  const returned = new Map();
  for (const row of returnedRows) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date) || !Number.isSafeInteger(row.installs) || row.installs < 0) {
      throw new Error('Analytics response contains an invalid row.');
    }
    if (row.date >= startDate && row.date <= endDate) returned.set(row.date, (returned.get(row.date) ?? 0) + row.installs);
  }

  for (let cursor = new Date(`${startDate}T00:00:00Z`); utcDate(cursor) <= endDate; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const date = utcDate(cursor);
    daily.set(date, returned.get(date) ?? 0);
  }
  return [...daily.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, installs]) => ({ date, installs }));
}

export function cumulativeHistory(dailyInstalls) {
  let total = 0;
  return dailyInstalls.map(({ date, installs }) => {
    total += installs;
    return { date, installs, cumulative: total };
  });
}

export function renderSvg(dailyInstalls) {
  const points = cumulativeHistory(dailyInstalls);
  const width = 960;
  const height = 480;
  const pad = { left: 76, right: 36, top: 100, bottom: 74 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const maxValue = Math.max(1, ...points.map((point) => point.cumulative));
  const yMax = Math.ceil(maxValue / 5) * 5 || 5;
  const x = (index) => pad.left + (points.length <= 1 ? plotWidth / 2 : (index / (points.length - 1)) * plotWidth);
  const y = (value) => pad.top + plotHeight - (value / yMax) * plotHeight;
  const polyline = points.map((point, index) => `${x(index).toFixed(2)},${y(point.cumulative).toFixed(2)}`).join(' ');
  const total = points.at(-1)?.cumulative ?? 0;
  const firstDate = points[0]?.date ?? '';
  const lastDate = points.at(-1)?.date ?? '';
  const gridLines = Array.from({ length: 5 }, (_, index) => {
    const value = Math.round((yMax * index) / 4);
    const yy = y(value).toFixed(2);
    return `<line x1="${pad.left}" y1="${yy}" x2="${width - pad.right}" y2="${yy}" stroke="#e2e8f0"/><text x="${pad.left - 14}" y="${Number(yy) + 5}" text-anchor="end" class="axis">${value.toLocaleString('en-US')}</text>`;
  }).join('\n    ');
  const safeDate = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title description">
  <title id="title">Cumulative Chrome Web Store Installs</title>
  <desc id="description">Cumulative Google Analytics install events: ${total.toLocaleString('en-US')} through ${safeDate(lastDate)}.</desc>
  <style>
    text{font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:#0f172a}
    .title{font-size:25px;font-weight:700}.total{font-size:32px;font-weight:700;fill:#2563eb}.subtitle,.axis{font-size:13px;fill:#64748b}
    .line{fill:none;stroke:#2563eb;stroke-width:4;stroke-linecap:round;stroke-linejoin:round}.area{fill:url(#fill);opacity:.18}
  </style>
  <defs><linearGradient id="fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="#3b82f6"/><stop offset="100%" stop-color="#bfdbfe"/></linearGradient></defs>
  <rect width="100%" height="100%" rx="18" fill="#fff"/>
  <text x="${pad.left}" y="38" class="title">Cumulative Chrome Web Store Installs</text>
  <text x="${pad.left}" y="80" class="total">${total.toLocaleString('en-US')}</text>
  <text x="${pad.left + 132}" y="78" class="subtitle">total GA install events</text>
  ${gridLines}
  <polygon class="area" points="${pad.left},${pad.top + plotHeight} ${polyline} ${width - pad.right},${pad.top + plotHeight}"/>
  <polyline class="line" points="${polyline}"/>
  <text x="${pad.left}" y="${height - 28}" class="axis">${safeDate(firstDate)}</text>
  <text x="${width - pad.right}" y="${height - 28}" text-anchor="end" class="axis">${safeDate(lastDate)}</text>
</svg>
`;
}

async function exchangeRefreshToken(adc) {
  if (adc.type !== 'authorized_user' || !adc.client_id || !adc.client_secret || !adc.refresh_token) {
    throw new Error('GA_ADC_JSON must contain authorized-user OAuth credentials.');
  }
  const tokenUrl = adc.token_uri || 'https://oauth2.googleapis.com/token';
  let response;
  try {
    response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: adc.client_id,
        client_secret: adc.client_secret,
        refresh_token: adc.refresh_token,
        grant_type: 'refresh_token',
      }),
    });
  } catch {
    throw new Error('Could not reach the OAuth token endpoint.');
  }
  if (!response.ok) throw new Error(`OAuth token refresh failed (HTTP ${response.status}).`);
  const token = await response.json();
  if (typeof token.access_token !== 'string' || !token.access_token) throw new Error('OAuth token response did not contain an access token.');
  return token.access_token;
}

async function fetchInstallRows(propertyId, accessToken, { startDate, endDate }) {
  let response;
  try {
    response = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(propertyId)}:runReport`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        dateRanges: [{ startDate, endDate }],
        dimensions: [{ name: 'date' }],
        metrics: [{ name: 'eventCount' }],
        dimensionFilter: { filter: { fieldName: 'eventName', stringFilter: { matchType: 'EXACT', value: 'install' } } },
        keepEmptyRows: true,
        orderBys: [{ dimension: { dimensionName: 'date' } }],
      }),
    });
  } catch {
    throw new Error('Could not reach the Google Analytics Data API.');
  }
  if (!response.ok) throw new Error(`Google Analytics report failed (HTTP ${response.status}).`);
  const report = await response.json();
  return (report.rows ?? []).map((row) => ({
    date: `${row.dimensionValues[0].value.slice(0, 4)}-${row.dimensionValues[0].value.slice(4, 6)}-${row.dimensionValues[0].value.slice(6, 8)}`,
    installs: Number(row.metricValues[0].value),
  }));
}

async function readHistory(path) {
  if (!path) return [];
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    if (!Array.isArray(parsed.dailyInstalls)) throw new Error('bad schema');
    return parsed.dailyInstalls;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new Error('Could not read existing install history.');
  }
}

export async function updateInstallStats({ propertyId, adcJson, historyPath, outputDir, today = new Date() }) {
  if (!propertyId || !adcJson) throw new Error('GA_PROPERTY_ID and GA_ADC_JSON are required.');
  let adc;
  try {
    adc = JSON.parse(adcJson);
  } catch {
    throw new Error('GA_ADC_JSON is not valid JSON.');
  }
  const existing = await readHistory(historyPath);
  const range = getQueryRange(today);
  const accessToken = await exchangeRefreshToken(adc);
  const rows = await fetchInstallRows(propertyId, accessToken, range);
  const historyRange = getHistoryRange(range);
  const dailyInstalls = mergeHistory(existing, rows, historyRange);
  const history = `${JSON.stringify({ eventName: 'install', dailyInstalls }, null, 2)}\n`;
  await mkdir(outputDir, { recursive: true });
  await writeFile(resolve(outputDir, 'install-history.json'), history, 'utf8');
  await writeFile(resolve(outputDir, 'install-growth.svg'), renderSvg(dailyInstalls), 'utf8');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputDir = process.env.STATS_OUTPUT_DIR || resolve(SCRIPT_DIR, '../stats');
  updateInstallStats({
    propertyId: process.env.GA_PROPERTY_ID,
    adcJson: process.env.GA_ADC_JSON,
    historyPath: process.env.STATS_HISTORY_PATH,
    outputDir,
  }).then(() => {
    process.stdout.write('Install statistics updated.\n');
  }).catch((error) => {
    // Error messages are intentionally credential-free; never print response bodies or tokens.
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
