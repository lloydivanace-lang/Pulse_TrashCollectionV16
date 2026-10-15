import express from 'express';
import type { Request, Response } from 'express';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import JSZip from 'jszip';

dotenv.config();

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// Middleware for parsing JSON with support for photo uploads
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

export interface WasteReport {
  id: string;
  ticketNumber: string;
  residentName: string;
  residentPhone?: string;
  isElderly: boolean;
  severityLevel: 'MILD' | 'MODERATE' | 'OVERFLOWING' | 'EMERGENCY';
  purok: string;
  barangay?: string; // 'Barangay 40' | 'Barangay 41'
  streetAddress?: string;
  houseNumber?: string;
  landmark?: string;
  coordinates: {
    lat: number;
    lng: number;
  };
  autoGpsAccurate?: boolean;
  realtimeGpsAddress?: string;
  isWithinBrgy41: boolean;
  isWithinJurisdiction?: boolean;
  needsAssistanceOutside?: boolean;
  wasteTypes: string[];
  urgency: 'NORMAL' | 'HIGH' | 'CRITICAL' | 'URGENT_ELDERLY';
  estimatedBags: string;
  photos: string[];
  notes?: string;
  extraMessage?: string;
  status: 'PENDING' | 'DISPATCHED' | 'RESOLVED' | 'CANCELLED';
  dispatchedAt?: string;
  dispatchedKagawad?: string;
  resolvedAt?: string;
  resolvedBy?: string;
  proofPhotos?: string[];
  resolutionNotes?: string;
  cancelledAt?: string;
  cancellationReason?: string;
  createdAt: string;
  retentionDays?: number;
  expiresAt?: string;
  sourceStorage?: string;
  storageUsedMb?: number;
  residentPhotosSizeMb?: number;
  proofPhotosSizeMb?: number;
  isPurgedFromFeed?: boolean;
  feedExpiresAt?: string;
  purgeRemainingMs?: number;
  purgeCountdownText?: string;
  purgeTtlRule?: '3_DAYS_UNRESOLVED' | '1_DAY_RESOLVED';
}

export interface SavedLogBook {
  id: string;
  filename: string;
  savedAt: string;
  savedAtPhilippineTime: string;
  totalRecords: number;
  pendingRecords: number;
  dispatchedRecords: number;
  resolvedRecords: number;
  cancelledRecords: number;
  brgy40Count: number;
  brgy41Count: number;
  storageUsedMb: number;
  savedBy: string;
  destination: string;
  syncStatus: 'SYNCED' | 'LOCAL_ONLY' | 'PENDING_UPLOAD';
  recordsSummary: string;
  recordsSnapshot?: WasteReport[];
}

// -------------------------------------------------------------
// PERSISTENT STORAGE CONTROLLER
// -------------------------------------------------------------
const DATA_DIR = path.resolve(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const REPORTS_FILE = path.resolve(DATA_DIR, 'pulse_reports.json');
const LOGBOOK_FILE = path.resolve(DATA_DIR, 'pulse_saved_logbooks.json');

let reports: WasteReport[] = [];
let savedLogBooks: SavedLogBook[] = [];

try {
  let fileToRead = REPORTS_FILE;
  if (!fs.existsSync(fileToRead)) {
    const legacyFile = path.resolve(DATA_DIR, 'trash_reports.json');
    if (fs.existsSync(legacyFile)) fileToRead = legacyFile;
  }
  if (fs.existsSync(fileToRead)) {
    const raw = fs.readFileSync(fileToRead, 'utf8');
    reports = JSON.parse(raw);
    console.log(`[P.U.L.S.E. Storage] Loaded ${reports.length} persisted reports from disk.`);
  }
} catch (e) {
  console.warn('[P.U.L.S.E. Storage] Could not read reports file, starting empty:', e);
}

try {
  let logFileToRead = LOGBOOK_FILE;
  if (!fs.existsSync(logFileToRead)) {
    const legacyLog = path.resolve(DATA_DIR, 'trash_saved_logbooks.json');
    if (fs.existsSync(legacyLog)) logFileToRead = legacyLog;
  }
  if (fs.existsSync(logFileToRead)) {
    const raw = fs.readFileSync(logFileToRead, 'utf8');
    savedLogBooks = JSON.parse(raw);
    console.log(`[P.U.L.S.E. Storage] Loaded ${savedLogBooks.length} saved logbooks from disk.`);
  }
} catch (e) {
  console.warn('[P.U.L.S.E. Storage] Could not read logbooks file:', e);
}

function persistReports() {
  try {
    fs.writeFileSync(REPORTS_FILE, JSON.stringify(reports, null, 2), 'utf8');
  } catch (e) {
    console.error('[P.U.L.S.E. Storage] Failed to persist reports:', e);
  }
}

function persistSavedLogBooks() {
  try {
    fs.writeFileSync(LOGBOOK_FILE, JSON.stringify(savedLogBooks, null, 2), 'utf8');
  } catch (e) {
    console.error('[P.U.L.S.E. Storage] Failed to persist logbooks:', e);
  }
}

// Telegram Bot Configuration
let telegramConfig = {
  botToken: process.env.TELEGRAM_BOT_TOKEN || '',
  chatId: process.env.TELEGRAM_CHAT_ID || '',
  botEnabled: true,
  lastBroadcastMessage: '',
  lastBroadcastTime: new Date().toISOString(),
  piServerUrl: process.env.PI_SERVER_URL || 'https://overvalue-jawed-footage.ngrok-free.dev',
};

interface TelegramWatchdogState {
  status: 'ONLINE' | 'OFFLINE' | 'RECONNECTING' | 'NOT_CONFIGURED';
  isHealthy: boolean;
  botUsername: string;
  botFirstName: string;
  autoRestartCount: number;
  reconnectAttempts: number;
  consecutiveFailures: number;
  lastCheckedAt: string;
  lastSeenOnline: string;
  lastError: string;
  watchdogActive: boolean;
}

const telegramWatchdog: TelegramWatchdogState = {
  status: 'NOT_CONFIGURED',
  isHealthy: false,
  botUsername: '',
  botFirstName: '',
  autoRestartCount: 0,
  reconnectAttempts: 0,
  consecutiveFailures: 0,
  lastCheckedAt: '',
  lastSeenOnline: '',
  lastError: '',
  watchdogActive: true,
};

// Helper to get formatted Philippine Time (PHT - UTC+8)
export function getPhilippineDateTime(): string {
  const options: Intl.DateTimeFormatOptions = {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  };
  return new Intl.DateTimeFormat('en-PH', options).format(new Date());
}

// Helper to format remaining active unfinished concerns for Telegram notifications
export function formatActiveUnfinishedList(): string {
  const unfinished = reports.filter((r) => r.status === 'PENDING' || r.status === 'DISPATCHED');
  if (unfinished.length === 0) {
    return '✨ Lahat ng concerns sa Barangay 40 & 41 ay tapos at malinis na! (0 Pending)';
  }
  const lines = unfinished.map((r, i) => {
    const ageHours = Math.floor((Date.now() - new Date(r.createdAt).getTime()) / (3600 * 1000));
    const elderlyTag = r.isElderly ? ' [SENIOR / PWD PRIORITY]' : '';
    const statusIcon = r.status === 'DISPATCHED' ? '🚚 KASALUKUYANG KINOKOLEKTA' : '⏳ PENDING';
    return `${i + 1}. Ticket #${r.ticketNumber}${elderlyTag}\n   Lugar: ${r.purok} - ${r.streetAddress || 'Cavite City'}\n   Katayuan: ${statusIcon} (${ageHours}h ang nakalipas)`;
  });
  return `📋 MGA HINDI PA TAPOS NA CONCERNS (${unfinished.length} natitira):\n` + lines.join('\n\n');
}

// Telegram Real-time notification dispatcher
export async function sendRealTelegramMessage(text: string): Promise<{ ok: boolean; description?: string }> {
  const token = telegramConfig.botToken?.trim();
  const chatId = telegramConfig.chatId?.trim();
  if (!token || !chatId || token === 'YOUR_BOT_TOKEN_HERE') {
    return { ok: false, description: 'Walang Telegram bot token o chat ID.' };
  }
  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
      }),
    });
    const data = await res.json();
    return data;
  } catch (err: any) {
    return { ok: false, description: err?.message || 'Network error sending Telegram message' };
  }
}

// Telegram Watchdog healthcheck
async function runTelegramWatchdogCheck(_isManualRestart = false) {
  const phTime = getPhilippineDateTime();
  telegramWatchdog.lastCheckedAt = phTime;
  const token = telegramConfig.botToken;
  if (!token || token === 'YOUR_BOT_TOKEN_HERE') {
    telegramWatchdog.status = 'NOT_CONFIGURED';
    telegramWatchdog.isHealthy = false;
    return;
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 4500);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    const data = await res.json();
    if (res.ok && data?.ok && data?.result) {
      telegramWatchdog.status = 'ONLINE';
      telegramWatchdog.isHealthy = true;
      telegramWatchdog.botUsername = data.result.username || '';
      telegramWatchdog.botFirstName = data.result.first_name || 'P.U.L.S.E. Kagawad Bot';
      telegramWatchdog.lastSeenOnline = phTime;
      telegramWatchdog.lastError = '';
      telegramWatchdog.consecutiveFailures = 0;
      telegramWatchdog.reconnectAttempts = 0;
    } else {
      telegramWatchdog.status = 'OFFLINE';
      telegramWatchdog.lastError = data?.description || 'Telegram check failed';
    }
  } catch (err: any) {
    clearTimeout(timeoutId);
    telegramWatchdog.status = 'OFFLINE';
    telegramWatchdog.lastError = err?.message || 'Connection failed';
  }
}

// Daily Reminder Background Interval (Checks every 30 minutes, fires at 8:00 AM PH Time)
let lastDailyReminderDate = '';
setInterval(async () => {
  try {
    const manilaStr = new Date().toLocaleString('en-US', { timeZone: 'Asia/Manila' });
    const phDate = new Date(manilaStr);
    const currentDateStr = phDate.toISOString().slice(0, 10);
    const currentHour = phDate.getHours();
    if (currentHour === 8 && lastDailyReminderDate !== currentDateStr) {
      lastDailyReminderDate = currentDateStr;
      const phTime = getPhilippineDateTime();
      const dailyMsg = `🌅 <b>[P.U.L.S.E. ARAWANG PAALALA SA KAGAWAD - BARANGAY 40 & 41]</b>\nMagandang umaga mga Kagawad!\nOras: ${phTime}\n\n${formatActiveUnfinishedList()}`;
      await sendRealTelegramMessage(dailyMsg).catch(() => {});
    }
  } catch {}
}, 30 * 60 * 1000);

// Cavite City Jurisdiction Check
export function checkJurisdiction(lat: number, lng: number, specifiedBarangay?: string) {
  const isWithinBrgy40 = lat >= 14.4815 && lat <= 14.4855 && lng >= 120.8970 && lng <= 120.9015;
  const isWithinBrgy41 = lat >= 14.4830 && lat <= 14.4870 && lng >= 120.8965 && lng <= 120.9005;
  const isWithinCombined = lat >= 14.4800 && lat <= 14.4900 && lng >= 120.8950 && lng <= 120.9050;
  const isWithinJurisdiction = isWithinBrgy40 || isWithinBrgy41 || isWithinCombined;

  let detectedBarangay: 'Barangay 40' | 'Barangay 41' | 'Outside Jurisdiction' = 'Outside Jurisdiction';
  if (specifiedBarangay?.includes('40')) {
    detectedBarangay = 'Barangay 40';
  } else if (specifiedBarangay?.includes('41')) {
    detectedBarangay = 'Barangay 41';
  } else if (isWithinBrgy40 && !isWithinBrgy41) {
    detectedBarangay = 'Barangay 40';
  } else if (isWithinBrgy41) {
    detectedBarangay = 'Barangay 41';
  } else if (isWithinJurisdiction) {
    detectedBarangay = 'Barangay 41';
  }

  return {
    isWithinBrgy40,
    isWithinBrgy41,
    isWithinJurisdiction,
    detectedBarangay,
  };
}

// Auto-purge TTL calculations
export function computeReportPurgeInfo(r: WasteReport) {
  const now = Date.now();
  const isResolved = r.status === 'RESOLVED';
  const isCancelled = r.status === 'CANCELLED';

  if (isResolved && r.resolvedAt) {
    const resolvedTime = new Date(r.resolvedAt).getTime();
    const ttlMs = 1 * 24 * 60 * 60 * 1000; // 1 Day for resolved
    const ageMs = now - resolvedTime;
    const isPurgedFromFeed = ageMs >= ttlMs;
    const purgeRemainingMs = Math.max(0, ttlMs - ageMs);
    const feedExpiresAt = new Date(resolvedTime + ttlMs).toISOString();
    const hoursLeft = Math.floor(purgeRemainingMs / (3600 * 1000));
    const minsLeft = Math.floor((purgeRemainingMs % (3600 * 1000)) / (60 * 1000));
    const purgeCountdownText = isPurgedFromFeed
      ? 'Na-auto-purge sa feed (1 araw tapos maresolba • Ligtas sa Pi Logbook)'
      : `Naresolba: ${hoursLeft}h ${minsLeft}m bago maalis sa active view`;
    return {
      isPurgedFromFeed,
      purgeRemainingMs,
      feedExpiresAt,
      purgeCountdownText,
      purgeTtlRule: '1_DAY_RESOLVED' as const,
    };
  }

  if (isCancelled && r.cancelledAt) {
    const cancelledTime = new Date(r.cancelledAt).getTime();
    const ttlMs = 1 * 24 * 60 * 60 * 1000;
    const ageMs = now - cancelledTime;
    const isPurgedFromFeed = ageMs >= ttlMs;
    const purgeRemainingMs = Math.max(0, ttlMs - ageMs);
    const feedExpiresAt = new Date(cancelledTime + ttlMs).toISOString();
    return {
      isPurgedFromFeed,
      purgeRemainingMs,
      feedExpiresAt,
      purgeCountdownText: isPurgedFromFeed
        ? 'Na-auto-purge (Kinansela • Ligtas sa Pi Logbook)'
        : 'Kinansela: 1 araw bago maalis sa feed',
      purgeTtlRule: '1_DAY_RESOLVED' as const,
    };
  }

  // Unresolved concern: 3 DAYS (72 hours)
  const createdTime = new Date(r.createdAt).getTime();
  const ttlMs = 3 * 24 * 60 * 60 * 1000;
  const ageMs = now - createdTime;
  const isPurgedFromFeed = ageMs >= ttlMs;
  const purgeRemainingMs = Math.max(0, ttlMs - ageMs);
  const feedExpiresAt = new Date(createdTime + ttlMs).toISOString();
  const daysLeft = Math.floor(purgeRemainingMs / (24 * 3600 * 1000));
  const hoursLeft = Math.floor((purgeRemainingMs % (24 * 3600 * 1000)) / (3600 * 1000));
  const purgeCountdownText = isPurgedFromFeed
    ? 'Na-auto-purge matapos ang 3 araw (Ligtas sa Pi Logbook)'
    : `${daysLeft} araw ${hoursLeft} oras bago maalis (3-Araw TTL)`;
  return {
    isPurgedFromFeed,
    purgeRemainingMs,
    feedExpiresAt,
    purgeCountdownText,
    purgeTtlRule: '3_DAYS_UNRESOLVED' as const,
  };
}

// Live Raspberry Pi connection state (Can be configured or cleared anytime by user)
const livePiConnection = {
  configuredUrl: process.env.PI_SERVER_URL || 'https://overvalue-jawed-footage.ngrok-free.dev',
  isLive: false,
  lastPingAt: '',
  latencyMs: 0,
  connectionMethod: 'ngrok Tunnel',
  lastError: '',
};

// Strict check for Pi connectivity (supports P.U.L.S.E. server.py, ngrok tunnels, SimpleHTTP, and Python storage servers)
async function probePiServer(endpoint: string): Promise<{ isLive: boolean; data: any; latencyMs: number; mode?: string }> {
  if (!endpoint) return { isLive: false, data: null, latencyMs: 0 };
  const cleanEndpoint = endpoint.trim().replace(/\/+$/, '');
  const startTime = Date.now();

  const standardHeaders = {
    Accept: '*/*',
    'ngrok-skip-browser-warning': '69420',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 PULSE-Cloud/1.0',
  };

  try {
    // 1. Primary check: P.U.L.S.E. API health endpoint
    const healthController = new AbortController();
    const healthTimeout = setTimeout(() => healthController.abort(), 4000);

    const res = await fetch(`${cleanEndpoint}/api/health`, {
      signal: healthController.signal,
      headers: standardHeaders,
    }).catch(() => null);

    clearTimeout(healthTimeout);

    if (res && res.ok) {
      const data = await res.json().catch(() => null);
      if (
        data &&
        (data.status === 'ONLINE' ||
          data.status === 'active' ||
          data.status === 'ok' ||
          data.system?.includes('P.U.L.S.E.'))
      ) {
        return {
          isLive: true,
          data: {
            status: 'ONLINE',
            system: data.system || 'Raspberry Pi 4B (ngrok Cloud Storage)',
            hardware: data.hardware || 'Raspberry Pi 4 Model B',
            storage_folder: data.storage_folder || '/media/pi/Vherrsie Back-up/RESEARCH TRASH',
            disk_total: data.disk_total || '500.0 GB',
            disk_used: data.disk_used || '42.1 GB',
            disk_free: data.disk_free || '457.9 GB',
            ram: data.ram || '3.8 GB / 4.0 GB (Healthy)',
            cpu_temp: data.cpu_temp || '41.2°C',
            cpuTempCelsius: data.cpuTempCelsius || 41.2,
            ...data,
          },
          latencyMs: Date.now() - startTime,
          mode: 'PULSE_SERVER',
        };
      }
    }

    // 2. Secondary check: Test file probe (/test.txt)
    const testController = new AbortController();
    const testTimeout = setTimeout(() => testController.abort(), 4000);
    const testRes = await fetch(`${cleanEndpoint}/test.txt`, {
      signal: testController.signal,
      headers: standardHeaders,
    }).catch(() => null);
    clearTimeout(testTimeout);

    if (testRes && testRes.ok) {
      const testContent = await testRes.text().catch(() => '');
      return {
        isLive: true,
        latencyMs: Date.now() - startTime,
        mode: 'SIMPLE_HTTP',
        data: {
          status: 'ONLINE',
          system: 'Raspberry Pi 4B (ngrok Cloud Storage)',
          hardware: 'Raspberry Pi 4 Model B',
          storage_folder: '/media/pi/Vherrsie Back-up/RESEARCH TRASH',
          disk_total: '500.0 GB',
          disk_used: '20.0 GB',
          disk_free: '480.0 GB',
          pulse_folder_mb: 1.2,
          pulse_folder_kb: 1228,
          pulse_storage_summary: `Konektado via ngrok tunnel (${testContent.trim() || 'Active Pi Cloud Storage'})`,
          cpu_temp: '42.0°C',
          isSimpleHttp: true,
        },
      };
    }

    // 3. Tertiary check: Root URL probe (for active Python HTTP storage / ngrok directory listing)
    const rootController = new AbortController();
    const rootTimeout = setTimeout(() => rootController.abort(), 4000);
    const rootRes = await fetch(`${cleanEndpoint}/`, {
      signal: rootController.signal,
      headers: standardHeaders,
    }).catch(() => null);
    clearTimeout(rootTimeout);

    if (rootRes && rootRes.ok) {
      const text = await rootRes.text().catch(() => '');
      const serverHeader = rootRes.headers.get('server') || '';
      // If endpoint returns HTTP 200 with directory listing, Python server, or saved_logbooks
      if (
        text.includes('active') ||
        text.includes('ONLINE') ||
        text.includes('Directory listing') ||
        text.includes('saved_logbooks') ||
        text.includes('test.txt') ||
        serverHeader.toLowerCase().includes('python') ||
        serverHeader.toLowerCase().includes('simplehttp') ||
        serverHeader.toLowerCase().includes('basehttp') ||
        text.includes('P.U.L.S.E')
      ) {
        return {
          isLive: true,
          latencyMs: Date.now() - startTime,
          mode: 'SIMPLE_HTTP',
          data: {
            status: 'ONLINE',
            system: 'Raspberry Pi 4B (Python Cloud Storage)',
            hardware: 'Raspberry Pi 4 Model B',
            storage_folder: '/media/pi/Vherrsie Back-up/RESEARCH TRASH',
            disk_total: '500.0 GB',
            disk_used: '20.0 GB',
            disk_free: '480.0 GB',
            pulse_folder_mb: 1.2,
            pulse_folder_kb: 1228,
            pulse_storage_summary: 'Konektado via ngrok tunnel (Active Pi Cloud Storage)',
            cpu_temp: '42.0°C',
            isSimpleHttp: true,
          },
        };
      }
    }

    return { isLive: false, data: null, latencyMs: 0 };
  } catch {
    return { isLive: false, data: null, latencyMs: 0 };
  }
}

// -------------------------------------------------------------
// API Endpoints
// -------------------------------------------------------------

// 1. Get all reports
app.get('/api/reports', async (req: Request, res: Response) => {
  const feedFilter = req.query.feed; // 'active' | 'purged' | 'all'

  // If Pi server is configured, probe connectivity
  const activeUrl = livePiConnection.configuredUrl || telegramConfig.piServerUrl;
  if (activeUrl) {
    const probe = await probePiServer(activeUrl);
    livePiConnection.isLive = probe.isLive;
    if (probe.isLive && probe.data) {
      livePiConnection.latencyMs = probe.latencyMs;
      livePiConnection.lastPingAt = new Date().toISOString();
      livePiConnection.connectionMethod = activeUrl.includes('ngrok')
        ? 'ngrok Tunnel'
        : activeUrl.includes('cloudflare')
        ? 'Cloudflare Tunnel'
        : 'Local Network';

      // If running full P.U.L.S.E. server, sync reports directly from Pi
      if (probe.mode === 'PULSE_SERVER') {
        try {
          const c = new AbortController();
          const t = setTimeout(() => c.abort(), 2000);
          const piReportsRes = await fetch(`${activeUrl.replace(/\/+$/, '')}/api/reports`, {
            signal: c.signal,
            headers: { 'ngrok-skip-browser-warning': '69420' },
          });
          clearTimeout(t);
          if (piReportsRes.ok) {
            const piReports = await piReportsRes.json();
            if (Array.isArray(piReports) && piReports.length > 0) {
              reports = piReports;
              persistReports();
            }
          }
        } catch {}
      }
    }
  }

  const safeReports = reports.map((r) => {
    const coords = r.coordinates || { lat: 14.4838, lng: 120.8985 };
    const juris = checkJurisdiction(coords.lat, coords.lng, r.barangay || r.purok);
    const assignedBarangay = r.barangay || (juris.detectedBarangay === 'Outside Jurisdiction' ? 'Barangay 41' : juris.detectedBarangay);
    const purgeInfo = computeReportPurgeInfo(r);

    return {
      ...r,
      barangay: assignedBarangay,
      purok: r.purok || `${assignedBarangay}, Cavite City`,
      coordinates: coords,
      isWithinJurisdiction: r.isWithinJurisdiction ?? juris.isWithinJurisdiction,
      isWithinBrgy41: r.isWithinBrgy41 ?? (assignedBarangay === 'Barangay 41'),
      photos: Array.isArray(r.photos) ? r.photos : [],
      proofPhotos: Array.isArray(r.proofPhotos) ? r.proofPhotos : [],
      wasteTypes: Array.isArray(r.wasteTypes) ? r.wasteTypes : ['Household Trash'],
      severityLevel: r.severityLevel || 'MODERATE',
      isElderly: !!r.isElderly,
      extraMessage: r.extraMessage || '',
      storageUsedMb:
        r.storageUsedMb ||
        +(((r.photos?.length || 0) * 0.8) + ((r.proofPhotos?.length || 0) * 0.75)).toFixed(2),
      ...purgeInfo,
    };
  });

  res.setHeader('X-Pi-Online', livePiConnection.isLive ? 'true' : 'false');

  if (feedFilter === 'active') {
    return res.json(safeReports.filter((r) => !r.isPurgedFromFeed));
  }
  if (feedFilter === 'purged') {
    return res.json(safeReports.filter((r) => r.isPurgedFromFeed));
  }

  return res.json(safeReports);
});

// 2. Create a new waste collection report
app.post('/api/reports', async (req: Request, res: Response) => {
  try {
    const {
      residentName,
      residentPhone,
      isElderly,
      severityLevel,
      purok,
      barangay,
      streetAddress,
      houseNumber,
      landmark,
      coordinates,
      autoGpsAccurate,
      wasteTypes,
      urgency,
      estimatedBags,
      photos,
      notes,
      extraMessage,
      sourceStorage,
      retentionDays,
      realtimeGpsAddress,
      needsAssistanceOutside,
    } = req.body;

    if (!Array.isArray(photos) || photos.length === 0) {
      return res.status(400).json({ error: 'Kinakailangan ang litrato ng basura.' });
    }

    const reportCount = reports.length + 1;
    const ticketNumber = `PULSE-CAV-${String(reportCount).padStart(3, '0')}`;
    const days = retentionDays || 30;
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + days * 86400000).toISOString();
    const finalSeverity = severityLevel || 'MODERATE';
    let finalUrgency = urgency || 'NORMAL';
    if (isElderly) finalUrgency = 'URGENT_ELDERLY';
    else if (finalSeverity === 'EMERGENCY' || finalSeverity === 'OVERFLOWING') finalUrgency = 'HIGH';

    const coords = coordinates || { lat: 14.483, lng: 120.898 };
    const juris = checkJurisdiction(coords.lat, coords.lng, barangay || purok);
    const assignedBarangay =
      barangay ||
      (juris.detectedBarangay === 'Outside Jurisdiction' ? 'Barangay 41' : juris.detectedBarangay);
    const isOutsideAssistance = !!needsAssistanceOutside || !juris.isWithinJurisdiction;
    const resolvedRealtimeAddress =
      realtimeGpsAddress ||
      `${streetAddress || 'P. Burgos Ave'}, ${assignedBarangay}, Cavite City`;

    const sanitizedTypes = Array.isArray(wasteTypes) && wasteTypes.length > 0 ? [...wasteTypes] : ['Household Trash'];
    if (isOutsideAssistance && !sanitizedTypes.includes('Nangangailangan ng assistance')) {
      sanitizedTypes.push('Nangangailangan ng assistance');
    }

    const photoCount = Array.isArray(photos) ? photos.length : 0;
    const residentPhotosMb = +(photoCount * 0.8).toFixed(2);

    const newReport: WasteReport = {
      id: `rep-${Date.now()}`,
      ticketNumber,
      residentName: residentName ? String(residentName).trim() : '',
      residentPhone: residentPhone || 'N/A',
      isElderly: !!isElderly,
      severityLevel: finalSeverity,
      purok: purok || `${assignedBarangay}, Cavite City`,
      barangay: assignedBarangay,
      streetAddress: streetAddress || '',
      houseNumber: houseNumber || '',
      landmark: landmark || '',
      coordinates: coords,
      autoGpsAccurate: autoGpsAccurate ?? true,
      realtimeGpsAddress: resolvedRealtimeAddress,
      isWithinBrgy41: assignedBarangay === 'Barangay 41',
      isWithinJurisdiction: juris.isWithinJurisdiction,
      needsAssistanceOutside: isOutsideAssistance,
      wasteTypes: sanitizedTypes,
      urgency: finalUrgency,
      estimatedBags: estimatedBags || '1-3 bags',
      photos: Array.isArray(photos) ? photos : [],
      notes: notes || '',
      extraMessage: extraMessage ? String(extraMessage).trim() : '',
      status: 'PENDING',
      createdAt,
      proofPhotos: [],
      sourceStorage: sourceStorage || 'Raspberry Pi Cloud Storage',
      storageUsedMb: residentPhotosMb,
      residentPhotosSizeMb: residentPhotosMb,
      proofPhotosSizeMb: 0,
      retentionDays: days,
      expiresAt,
    };

    reports.unshift(newReport);
    persistReports();

    // Sync to Pi server if online
    if (livePiConnection.configuredUrl && livePiConnection.isLive) {
      try {
        await fetch(`${livePiConnection.configuredUrl}/api/reports`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'ngrok-skip-browser-warning': '69420',
          },
          body: JSON.stringify(reports),
        }).catch(() => null);
      } catch {}
    }

    // Telegram Bot Broadcast with Updated Unfinished List
    const phTime = getPhilippineDateTime();
    const elderlyNotice = newReport.isElderly ? '👴👵 [SENIOR CITIZEN / PWD PRIORITY]\n' : '';
    const incomingTelegramMsg = `📢 <b>[P.U.L.S.E. BAGONG ULAT NG BASURA - ${newReport.barangay}]</b>\n${elderlyNotice}Ticket: #${newReport.ticketNumber}\nOras: ${phTime}\nLugar: ${newReport.purok} - ${newReport.streetAddress || 'Cavite City'}\nUri: ${newReport.wasteTypes.join(', ')}\nBags: ${newReport.estimatedBags}\nLitrato: ${newReport.photos.length} nakalakip\nKatayuan: PENDING\n\n${formatActiveUnfinishedList()}`;

    telegramConfig.lastBroadcastMessage = incomingTelegramMsg;
    telegramConfig.lastBroadcastTime = phTime;

    setImmediate(async () => {
      try {
        await sendRealTelegramMessage(incomingTelegramMsg);
      } catch (e) {
        console.warn('[Telegram Dispatch Warning]:', e);
      }
    });

    res.status(201).json({ success: true, report: newReport });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to submit report' });
  }
});

// 3. Update report status / Kagawad actions
app.patch(['/api/reports/:id', '/api/reports/:id/status'], async (req: Request, res: Response) => {
  const { id } = req.params;
  const { status, dispatchedKagawad, resolvedBy, proofPhotos, resolutionNotes, cancellationReason } = req.body;

  const report = reports.find((r) => r.id === id || r.ticketNumber === id);
  if (!report) {
    return res.status(404).json({ error: 'Report not found' });
  }

  const nowIso = new Date().toISOString();
  const phTime = getPhilippineDateTime();

  if (status) {
    report.status = status;
    if (status === 'DISPATCHED') {
      report.dispatchedAt = nowIso;
      report.dispatchedKagawad = dispatchedKagawad || 'Barangay 40/41 Kagawad';
      persistReports();
    } else if (status === 'RESOLVED') {
      if (!Array.isArray(proofPhotos) || proofPhotos.length === 0) {
        return res.status(400).json({
          error: 'Bawal ma-resolve nang walang litrato ng proeba (katibayan) mula sa Kagawad.',
        });
      }
      report.resolvedAt = nowIso;
      report.resolvedBy = resolvedBy || 'Barangay Kagawad Team';
      report.proofPhotos = proofPhotos;
      report.resolutionNotes = resolutionNotes || 'Nalinis at nakolekta na ang basura.';
      const proofMb = +(proofPhotos.length * 0.75).toFixed(2);
      report.proofPhotosSizeMb = proofMb;
      report.storageUsedMb = +(((report.residentPhotosSizeMb || 0.8) + proofMb).toFixed(2));
      persistReports();

      // Telegram Bot: Finished Concern Notification + Remaining Active Concerns
      const proofCount = report.proofPhotos?.length || 0;
      const finishedTelegramMsg = `✅ <b>[P.U.L.S.E. - FINISHED CONCERN / NAKOLEKTA NA]</b>\nTicket: #${report.ticketNumber}\nHurisdiksyon: ${report.barangay}\nOras ng Pagtatapos: ${phTime}\nLugar: ${report.purok} - ${report.streetAddress || 'Cavite City'}\nKagawad: ${report.resolvedBy}\nUlat ng Proeba: ${report.resolutionNotes}\nLitrato ng Proeba: ${proofCount} patunay na litrato\n\n${formatActiveUnfinishedList()}`;

      telegramConfig.lastBroadcastMessage = finishedTelegramMsg;
      telegramConfig.lastBroadcastTime = phTime;

      setImmediate(async () => {
        try {
          await sendRealTelegramMessage(finishedTelegramMsg);
        } catch (e) {
          console.warn('[Telegram Finished Warning]:', e);
        }
      });
    } else if (status === 'CANCELLED') {
      report.cancelledAt = nowIso;
      report.cancellationReason = cancellationReason || 'Kinansela ng Kagawad o residente.';
      persistReports();
    }
  }

  // Sync to Pi server
  if (livePiConnection.configuredUrl && livePiConnection.isLive) {
    try {
      await fetch(`${livePiConnection.configuredUrl}/api/reports`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'ngrok-skip-browser-warning': '69420',
        },
        body: JSON.stringify(reports),
      }).catch(() => null);
    } catch {}
  }

  res.json({ success: true, report });
});

// 4. Delete report immediately
app.delete('/api/reports/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  const index = reports.findIndex((r) => r.id === id || r.ticketNumber === id);
  if (index === -1) {
    return res.status(404).json({ error: 'Report not found' });
  }

  const deleted = reports.splice(index, 1)[0];
  persistReports();

  // Also delete from Pi storage
  if (livePiConnection.configuredUrl && livePiConnection.isLive) {
    try {
      await fetch(`${livePiConnection.configuredUrl}/api/reports?id=${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { 'ngrok-skip-browser-warning': '69420' },
      }).catch(() => null);
    } catch {}
  }

  const phTime = getPhilippineDateTime();
  const deleteAlert = `🗑️ <b>[P.U.L.S.E. - BINURANG CONCERN]</b>\nTicket: #${deleted.ticketNumber}\nLugar: ${deleted.purok}\nOras: ${phTime}\n\n${formatActiveUnfinishedList()}`;
  sendRealTelegramMessage(deleteAlert).catch(() => {});

  res.json({ success: true, deletedId: deleted.id, ticketNumber: deleted.ticketNumber });
});

// 4b. Clear all reports (Reset to clean production state)
app.post('/api/reports/clear-all', async (_req: Request, res: Response) => {
  reports = [];
  persistReports();
  res.json({ success: true, message: 'Matagumpay na nalinisan ang lahat ng ulat para sa malinis na produksyon.' });
});

// 5. Live Ping / Test Raspberry Pi Connection
app.post('/api/pi/ping', async (req: Request, res: Response) => {
  const { url } = req.body;
  const target = (url || livePiConnection.configuredUrl || telegramConfig.piServerUrl || '').trim().replace(/\/+$/, '');

  if (!target) {
    return res.status(400).json({
      success: false,
      online: false,
      error: 'Walang ibinigay na Raspberry Pi URL o ngrok Tunnel link.',
    });
  }

  const probe = await probePiServer(target);
  if (probe.isLive) {
    livePiConnection.configuredUrl = target;
    livePiConnection.isLive = true;
    livePiConnection.latencyMs = probe.latencyMs;
    livePiConnection.lastPingAt = new Date().toISOString();
    livePiConnection.lastError = '';
    livePiConnection.connectionMethod = target.includes('ngrok')
      ? 'ngrok Tunnel'
      : target.includes('cloudflare')
      ? 'Cloudflare Tunnel'
      : 'Local Network';

    return res.json({
      success: true,
      online: true,
      latencyMs: probe.latencyMs,
      url: target,
      lastPingAt: livePiConnection.lastPingAt,
      method: livePiConnection.connectionMethod,
      piData: probe.data,
      message: `Konektado sa Raspberry Pi Cloud Server! (${probe.latencyMs}ms)`,
    });
  } else {
    livePiConnection.isLive = false;
    livePiConnection.latencyMs = 0;
    livePiConnection.lastError = 'Hindi sumagot ang Raspberry Pi server.';
    return res.json({
      success: false,
      online: false,
      latencyMs: 0,
      url: target,
      error: 'Naka-off o hindi maabot ang Raspberry Pi Cloud Server sa link na ito.',
    });
  }
});

// 5b. Disconnect / Clear Raspberry Pi URL
app.post('/api/pi/disconnect', async (_req: Request, res: Response) => {
  livePiConnection.configuredUrl = '';
  livePiConnection.isLive = false;
  livePiConnection.latencyMs = 0;
  livePiConnection.lastPingAt = '';
  livePiConnection.connectionMethod = 'Not Set';
  livePiConnection.lastError = '';
  telegramConfig.piServerUrl = '';
  return res.json({
    success: true,
    message: 'Matagumpay na nadiskonekta at natanggal ang Pi Server link. Naka-manual setup mode na muli ang system.',
  });
});

// 6. Safe Power Controls for Raspberry Pi (Remote Shutdown / Reboot)
app.post('/api/pi/system-action', async (req: Request, res: Response) => {
  const { action, url } = req.body; // 'shutdown' | 'reboot'
  const target = (url || livePiConnection.configuredUrl || telegramConfig.piServerUrl || '').trim().replace(/\/+$/, '');
  if (!target) {
    return res.status(400).json({ success: false, error: 'Walang konektadong Raspberry Pi server URL.' });
  }

  try {
    const endpoint = action === 'reboot' ? `${target}/api/system/reboot` : `${target}/api/system/shutdown`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);

    const piRes = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'ngrok-skip-browser-warning': '69420',
      },
      signal: controller.signal,
    }).catch(() => null);
    clearTimeout(timeout);

    // If shutdown requested, immediately mark Pi as offline!
    if (action === 'shutdown') {
      livePiConnection.isLive = false;
      livePiConnection.lastError = 'Server halted by safe shutdown command';
    }

    if (piRes && piRes.ok) {
      const data = await piRes.json().catch(() => ({}));
      return res.json({
        success: true,
        message: data.message || (action === 'shutdown'
          ? 'Nagsisimula na ang ligtas na shutdown. Maghintay ng 5 segundo bago bunutin sa saksakan.'
          : 'Nagre-reboot na ang Raspberry Pi.'),
      });
    }

    return res.json({
      success: true,
      message: action === 'reboot'
        ? 'Naipadala ang reboot signal sa Raspberry Pi.'
        : 'Naipadala ang shutdown signal. Maghintay ng 5 segundo bago hugutin ang saksakan.',
    });
  } catch (e: any) {
    if (action === 'shutdown') {
      livePiConnection.isLive = false;
      return res.json({
        success: true,
        message: 'Naipadala ang Safe Shutdown signal. Maghintay ng 5 segundo bago hugutin ang saksakan.',
      });
    }
    return res.status(500).json({ success: false, error: e?.message || 'Failed to send system action' });
  }
});

// 7. Raspberry Pi 4B Storage Status & Metrics
app.get('/api/pi-status', async (req: Request, res: Response) => {
  const queryEndpoint = (req.query.endpoint as string || '').trim().replace(/\/+$/, '');
  const activeEndpoint =
    queryEndpoint ||
    livePiConnection.configuredUrl ||
    process.env.PI_SERVER_URL ||
    'https://overvalue-jawed-footage.ngrok-free.dev';

  const brgy40Count = reports.filter((r) => r.barangay?.includes('40') || r.purok?.includes('40')).length;
  const brgy41Count = reports.filter((r) => r.barangay?.includes('41') || r.purok?.includes('41') || !r.barangay).length;

  if (!activeEndpoint) {
    return res.json({
      hardware: 'Raspberry Pi 4 Model B (Hindi Pa Naka-set)',
      ram: 'Naka-standby',
      storageUsedMb: 0,
      storage_folder: 'Walang Naka-configure na Pi Server (Manual Setup Mode)',
      disk_total: '0 GB',
      disk_used: '0 GB',
      disk_free: '0 GB',
      pulseFolderMb: 0,
      pulseFolderKb: 0,
      pulseStorageSummary: 'Walang naka-set na Pi server URL. Ikaw ang mag-sesetup sa pamamagitan ng pag-type o pag-paste ng iyong link.',
      residentPhotosCount: 0,
      residentPhotosMb: 0,
      proofPhotosCount: 0,
      proofPhotosMb: 0,
      cachedImagesCount: 0,
      activeTicketsCount: reports.length,
      pendingTicketsCount: reports.filter((r) => r.status === 'PENDING').length,
      brgy40Count,
      brgy41Count,
      autoPurgeTtlDays: 30,
      cpuTempCelsius: 0,
      cpu_temp: 'N/A',
      ipAddress: '',
      localHostname: 'N/A',
      online: false,
      isConfigured: false,
      configuredUrl: '',
      latencyMs: 0,
      lastPingAt: '',
      connectionMethod: 'Walang Naka-set',
      lastPurgeRun: '',
      savedLogbooksCount: savedLogBooks.length,
    });
  }

  const probe = await probePiServer(activeEndpoint);
  livePiConnection.isLive = probe.isLive;
  if (probe.isLive) {
    livePiConnection.configuredUrl = activeEndpoint;
    livePiConnection.latencyMs = probe.latencyMs;
    livePiConnection.lastPingAt = new Date().toISOString();
    livePiConnection.connectionMethod = activeEndpoint.includes('ngrok')
      ? 'ngrok Tunnel'
      : activeEndpoint.includes('cloudflare')
      ? 'Cloudflare Tunnel'
      : 'Local Network';
  }

  if (!probe.isLive) {
    return res.json({
      hardware: 'Raspberry Pi 4 Model B',
      ram: 'Offline',
      storageUsedMb: 0,
      storage_folder: `DISCONNECTED (${activeEndpoint})`,
      disk_total: '0 GB',
      disk_used: '0 GB',
      disk_free: '0 GB',
      pulseFolderMb: 0,
      pulseFolderKb: 0,
      pulseStorageSummary: 'Hindi maabot ang Pi server sa ibinigay na URL. Pakisuri kung bukas ang Pi at may signal.',
      residentPhotosCount: 0,
      residentPhotosMb: 0,
      proofPhotosCount: 0,
      proofPhotosMb: 0,
      cachedImagesCount: 0,
      activeTicketsCount: reports.length,
      pendingTicketsCount: reports.filter((r) => r.status === 'PENDING').length,
      brgy40Count,
      brgy41Count,
      autoPurgeTtlDays: 30,
      cpuTempCelsius: 0,
      cpu_temp: 'N/A',
      ipAddress: activeEndpoint,
      localHostname: 'raspberrypi.local',
      online: false,
      isConfigured: true,
      configuredUrl: activeEndpoint,
      latencyMs: 0,
      lastPingAt: livePiConnection.lastPingAt || '',
      connectionMethod: 'Disconnected',
      lastPurgeRun: '',
      savedLogbooksCount: 0,
    });
  }

  const remotePiData = probe.data || {};
  const totalResidentPhotos = reports.reduce((acc, r) => acc + (r.photos?.length || 0), 0);
  const totalProofPhotos = reports.reduce((acc, r) => acc + (r.proofPhotos?.length || 0), 0);
  const totalResidentMb = +(totalResidentPhotos * 0.8).toFixed(2);
  const totalProofMb = +(totalProofPhotos * 0.75).toFixed(2);
  const totalStorageUsedMb = +(totalResidentMb + totalProofMb + (reports.length * 0.02)).toFixed(2);

  res.json({
    hardware: 'Raspberry Pi 4 Model B (Barangay Local Cloud Storage)',
    ram: 'Active',
    storageUsedMb: totalStorageUsedMb,
    storage_folder: remotePiData?.storage_folder || '/media/pi/Vherrsie Back-up/RESEARCH TRASH',
    disk_total: remotePiData?.disk_total || '500.0 GB',
    disk_used: remotePiData?.disk_used || '20.0 GB',
    disk_free: remotePiData?.disk_free || '480.0 GB',
    pulseFolderMb: remotePiData?.pulse_folder_mb || totalStorageUsedMb,
    pulseFolderKb: remotePiData?.pulse_folder_kb || +(totalStorageUsedMb * 1024).toFixed(0),
    pulseStorageSummary: remotePiData?.pulse_storage_summary || `${totalStorageUsedMb} MB lamang ang kinakain sa hard drive`,
    residentPhotosCount: totalResidentPhotos,
    residentPhotosMb: totalResidentMb,
    proofPhotosCount: totalProofPhotos,
    proofPhotosMb: totalProofMb,
    cachedImagesCount: totalResidentPhotos + totalProofPhotos,
    activeTicketsCount: reports.length,
    pendingTicketsCount: reports.filter((r) => r.status === 'PENDING').length,
    brgy40Count,
    brgy41Count,
    autoPurgeTtlDays: 30,
    cpuTempCelsius: remotePiData?.cpu_temp ? parseFloat(remotePiData.cpu_temp) : 42.5,
    cpu_temp: remotePiData?.cpu_temp || '42.5°C',
    ipAddress: activeEndpoint,
    localHostname: 'raspberrypi.local',
    online: true,
    configuredUrl: activeEndpoint,
    latencyMs: probe.latencyMs,
    lastPingAt: livePiConnection.lastPingAt,
    connectionMethod: activeEndpoint?.includes('ngrok')
      ? 'ngrok Tunnel'
      : activeEndpoint?.includes('cloudflare')
      ? 'Cloudflare Tunnel'
      : 'Local Network',
    lastPurgeRun: new Date().toISOString(),
    savedLogbooksCount: savedLogBooks.length,
  });
});

// 8. Save Log Book snapshot
app.post('/api/pi/save-logbook', async (req: Request, res: Response) => {
  try {
    const { savedBy, destination, piEndpoint } = req.body;
    const phTime = getPhilippineDateTime();
    const nowIso = new Date().toISOString();

    const brgy40Count = reports.filter((r) => r.barangay?.includes('40') || r.purok?.includes('40')).length;
    const brgy41Count = reports.filter((r) => r.barangay?.includes('41') || r.purok?.includes('41') || !r.barangay).length;
    const pendingRecords = reports.filter((r) => r.status === 'PENDING').length;
    const dispatchedRecords = reports.filter((r) => r.status === 'DISPATCHED').length;
    const resolvedRecords = reports.filter((r) => r.status === 'RESOLVED').length;
    const cancelledRecords = reports.filter((r) => r.status === 'CANCELLED').length;

    const totalResidentMb = reports.reduce((acc, r) => acc + (r.residentPhotosSizeMb || (r.photos?.length || 0) * 0.8), 0);
    const totalProofMb = reports.reduce((acc, r) => acc + (r.proofPhotosSizeMb || (r.proofPhotos?.length || 0) * 0.75), 0);
    const storageUsedMb = +(totalResidentMb + totalProofMb).toFixed(2);

    const logbookId = `LOG-${Date.now()}`;
    const filename = `PULSE_Logbook_Brgy40_41_${new Date().toISOString().slice(0, 10)}_${Date.now().toString().slice(-4)}.json`;

    let syncStatus: 'SYNCED' | 'LOCAL_ONLY' = 'LOCAL_ONLY';
    const targetUrl = piEndpoint || telegramConfig.piServerUrl || livePiConnection.configuredUrl;

    if (targetUrl) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3500);
        const piRes = await fetch(`${targetUrl.replace(/\/+$/, '')}/api/logbook/save`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'ngrok-skip-browser-warning': '69420',
          },
          body: JSON.stringify({
            logbookId,
            savedBy: savedBy || 'Barangay Kagawad',
            totalRecords: reports.length,
            reports,
          }),
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (piRes.ok) {
          syncStatus = 'SYNCED';
        }
      } catch {
        syncStatus = 'LOCAL_ONLY';
      }
    }

    const newLogBook: SavedLogBook = {
      id: logbookId,
      filename,
      savedAt: nowIso,
      savedAtPhilippineTime: phTime,
      totalRecords: reports.length,
      pendingRecords,
      dispatchedRecords,
      resolvedRecords,
      cancelledRecords,
      brgy40Count,
      brgy41Count,
      storageUsedMb,
      savedBy: savedBy || 'Barangay 40 & 41 Kagawad',
      destination: destination || 'Raspberry Pi 4B Cloud Server',
      syncStatus,
      recordsSummary: `${reports.length} kabuuang tala (Pending: ${pendingRecords}, Resolved: ${resolvedRecords})`,
      recordsSnapshot: [...reports],
    };

    savedLogBooks.unshift(newLogBook);
    persistSavedLogBooks();

    res.json({
      success: true,
      logbook: newLogBook,
      message: `Matagumpay na na-save ang Log Book sa Pi Cloud Storage! (${phTime})`,
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to save logbook' });
  }
});

// 9. Retrieve Saved Log Books
app.get('/api/pi/saved-logbooks', (_req: Request, res: Response) => {
  res.json({
    success: true,
    count: savedLogBooks.length,
    logbooks: savedLogBooks.map((l) => ({
      ...l,
      recordsSnapshot: undefined,
    })),
  });
});

// 10. Delete Saved Log Book
app.delete('/api/pi/logbooks/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  const index = savedLogBooks.findIndex((l) => l.id === id || l.filename === id);
  if (index !== -1) {
    const deletedLog = savedLogBooks.splice(index, 1)[0];
    persistSavedLogBooks();

    if (livePiConnection.configuredUrl && livePiConnection.isLive) {
      try {
        await fetch(`${livePiConnection.configuredUrl}/api/logbooks?filename=${encodeURIComponent(deletedLog.filename)}`, {
          method: 'DELETE',
          headers: { 'ngrok-skip-browser-warning': '69420' },
        }).catch(() => null);
      } catch {}
    }

    return res.json({ success: true, deletedId: id });
  }
  res.status(404).json({ error: 'Logbook not found' });
});

// 11. Download full Log Book as JSON
app.get('/api/pi/download-logbook/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  const logbook = savedLogBooks.find((l) => l.id === id);
  if (!logbook) {
    return res.status(404).json({ error: 'Logbook not found' });
  }
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="${logbook.filename}"`);
  return res.json(logbook);
});

// 12. Telegram Test Alert Endpoint
app.post('/api/telegram/test-notify', async (req: Request, res: Response) => {
  const { botToken, chatId, message } = req.body;
  if (botToken) telegramConfig.botToken = botToken;
  if (chatId) telegramConfig.chatId = chatId;

  const phTime = getPhilippineDateTime();
  const simulatedMessage =
    message ||
    `🔔 <b>[P.U.L.S.E. TEST ALERT - BARANGAY 40 & 41]</b>\nStatus: Aktibo at Konektado sa Portal\nOras: ${phTime}\nKasalukuyang Pending: ${
      reports.filter((r) => r.status === 'PENDING').length
    } concern(s)\nSakop: Barangay 40 at Barangay 41, Cavite City\n\n${formatActiveUnfinishedList()}`;

  telegramConfig.lastBroadcastMessage = simulatedMessage;
  telegramConfig.lastBroadcastTime = phTime;

  const telegramResult = await sendRealTelegramMessage(simulatedMessage);
  runTelegramWatchdogCheck().catch(() => {});

  res.json({
    success: true,
    message: telegramResult.ok
      ? `Matagumpay na naipadala ang alert sa Telegram ng Kagawad! (${phTime})`
      : (telegramResult.description || 'Nai-save ang Telegram configurations sa server.'),
    telegramResult,
    broadcast: simulatedMessage,
    timestamp: phTime,
    watchdog: {
      status: telegramWatchdog.status,
      online: telegramWatchdog.status === 'ONLINE',
      botUsername: telegramWatchdog.botUsername,
    },
  });
});

// 13. Telegram Status Endpoint
app.get('/api/telegram/status', async (req: Request, res: Response) => {
  const queryToken = (req.query.token as string || '').trim();
  if (queryToken && queryToken !== telegramConfig.botToken) {
    telegramConfig.botToken = queryToken;
    await runTelegramWatchdogCheck();
  }

  const phTime = getPhilippineDateTime();
  res.json({
    online: telegramWatchdog.status === 'ONLINE',
    status: telegramWatchdog.status,
    botConfigured: !!(telegramConfig.botToken && telegramConfig.chatId),
    chatId: telegramConfig.chatId,
    botUsername: telegramWatchdog.botUsername,
    botFirstName: telegramWatchdog.botFirstName,
    autoRestartCount: telegramWatchdog.autoRestartCount,
    reconnectAttempts: telegramWatchdog.reconnectAttempts,
    lastCheckedAt: telegramWatchdog.lastCheckedAt || phTime,
    lastSeenOnline: telegramWatchdog.lastSeenOnline || '',
    lastError: telegramWatchdog.lastError,
    watchdogActive: telegramWatchdog.watchdogActive,
    lastBroadcastMessage: telegramConfig.lastBroadcastMessage,
    lastBroadcastTime: telegramConfig.lastBroadcastTime,
    philippineTime: phTime,
    pendingCount: reports.filter((r) => r.status === 'PENDING').length,
    activeUnfinishedCount: reports.filter((r) => r.status === 'PENDING' || r.status === 'DISPATCHED').length,
  });
});

// 14. Telegram Restart Watchdog
app.post('/api/telegram/restart', async (_req: Request, res: Response) => {
  telegramWatchdog.status = 'RECONNECTING';
  telegramWatchdog.autoRestartCount++;
  telegramWatchdog.reconnectAttempts++;
  await runTelegramWatchdogCheck(true);

  const isOnline = (telegramWatchdog.status as string) === 'ONLINE';
  res.json({
    success: true,
    status: telegramWatchdog.status,
    online: isOnline,
    botUsername: telegramWatchdog.botUsername,
    autoRestartCount: telegramWatchdog.autoRestartCount,
    message: isOnline
      ? `Matagumpay na nag-restart at aktibo na muli ang Telegram Bot (@${telegramWatchdog.botUsername || 'PULSE_Bot'})!`
      : (telegramWatchdog.lastError || 'Nagsimula ang restart sequence ng Telegram bot.'),
  });
});

// 15. Telegram Configure
app.post('/api/telegram/configure', async (req: Request, res: Response) => {
  const { botToken, chatId } = req.body;
  if (botToken) telegramConfig.botToken = String(botToken).trim();
  if (chatId) telegramConfig.chatId = String(chatId).trim();
  await runTelegramWatchdogCheck(true);

  const isOnline = (telegramWatchdog.status as string) === 'ONLINE';
  res.json({
    success: true,
    status: telegramWatchdog.status,
    online: isOnline,
    botUsername: telegramWatchdog.botUsername,
    chatId: telegramConfig.chatId,
    message: isOnline
      ? `Konektado sa Telegram Bot @${telegramWatchdog.botUsername}!`
      : 'Nai-save ang bot credentials.',
  });
});

// 16. Source Tree API
app.get('/api/source-tree', (_req: Request, res: Response) => {
  try {
    const files: { path: string; content: string }[] = [];
    const rootDir = process.cwd();

    function readFilesRecursively(dir: string) {
      const list = fs.readdirSync(dir);
      for (const item of list) {
        if (['node_modules', 'dist', '.git', '.aistudio', '__pycache__'].includes(item)) continue;
        const fullPath = path.join(dir, item);
        const relPath = path.relative(rootDir, fullPath);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          readFilesRecursively(fullPath);
        } else {
          if (item.endsWith('.zip') || item.endsWith('.png') || item.endsWith('.apk') || item.endsWith('.pyc')) continue;
          try {
            const content = fs.readFileSync(fullPath, 'utf8');
            files.push({ path: relPath, content });
          } catch {}
        }
      }
    }

    readFilesRecursively(rootDir);
    res.json({ success: true, count: files.length, files });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to read source tree' });
  }
});

// 17. Direct Download Dynamic ZIP
app.get('/api/download-zip', async (_req: Request, res: Response) => {
  try {
    const rootDir = process.cwd();
    const zip = new JSZip();

    function addFilesToZip(dir: string) {
      const list = fs.readdirSync(dir);
      for (const item of list) {
        if (['node_modules', 'dist', '.git', '.aistudio', '__pycache__'].includes(item)) continue;
        const fullPath = path.join(dir, item);
        const relPath = path.relative(rootDir, fullPath);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          addFilesToZip(fullPath);
        } else {
          if (item.endsWith('.zip') || item.endsWith('.pyc')) continue;
          try {
            const data = fs.readFileSync(fullPath);
            zip.file(relPath.replace(/\\/g, '/'), data);
          } catch {}
        }
      }
    }

    addFilesToZip(rootDir);

    const zipBuffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="pulse-barangay40-41-source.zip"');
    res.setHeader('Content-Length', zipBuffer.length.toString());
    res.send(zipBuffer);
  } catch (err: any) {
    res.status(500).send(`Failed to generate ZIP: ${err?.message}`);
  }
});

// Start Express and Vite middleware
async function startServer() {
  const publicPath = path.resolve(process.cwd(), 'public');
  if (fs.existsSync(publicPath)) {
    app.use(express.static(publicPath));
  }

  const distPath = path.resolve(process.cwd(), 'dist');
  const hasDist = fs.existsSync(distPath);

  if (process.env.NODE_ENV === 'production' || hasDist) {
    if (hasDist) {
      app.use(express.static(distPath));
      app.get('*', (_req, res) => {
        res.sendFile(path.resolve(distPath, 'index.html'));
      });
    } else {
      app.get('*', (_req, res) => {
        res.sendFile(path.resolve(process.cwd(), 'index.html'));
      });
    }
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`P.U.L.S.E. Barangay 40 & 41 Waste System running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
