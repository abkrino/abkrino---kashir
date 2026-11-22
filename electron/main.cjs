const { app, BrowserWindow, ipcMain, shell, protocol, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

const isWindows = process.platform === 'win32';
const APP_SCHEME = 'kashir';
protocol.registerSchemesAsPrivileged([{
  scheme: APP_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
}]);
let mainWindow;
let cachedMachineId = null;

function getStableMachineId() {
  if (cachedMachineId) return cachedMachineId;
  try {
    const result = spawnSync('reg.exe', [
      'query',
      'HKLM\\SOFTWARE\\Microsoft\\Cryptography',
      '/v',
      'MachineGuid'
    ], { encoding: 'utf8', windowsHide: true });
    const match = String(result.stdout || '').match(/MachineGuid\\s+REG_SZ\\s+([^\\r\\n]+)/i);
    if (result.status === 0 && match && match[1]) {
      const rawMachineGuid = match[1].trim().toLowerCase();
      cachedMachineId = 'win-' + crypto.createHash('sha256').update(rawMachineGuid).digest('hex').slice(0, 32);
      return cachedMachineId;
    }
  } catch {}

  // Fallback remains stable for this Windows user if MachineGuid cannot be read.
  const fallbackPath = path.join(app.getPath('userData'), 'device-id.txt');
  try {
    cachedMachineId = fsSync.readFileSync(fallbackPath, 'utf8').trim();
  } catch {
    cachedMachineId = 'fallback-' + crypto.randomUUID();
    fsSync.mkdirSync(path.dirname(fallbackPath), { recursive: true });
    fsSync.writeFileSync(fallbackPath, cachedMachineId, 'utf8');
  }
  return cachedMachineId;
}

ipcMain.on('system:get-machine-id', event => {
  event.returnValue = getStableMachineId();
});

app.setAppUserModelId('com.abkrino.kashir');
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

function getAnnouncementDir() { return path.join(app.getPath('userData'), 'announcements'); }
function getPlaylistPath() { return path.join(getAnnouncementDir(), 'playlist.json'); }
async function ensureAnnouncementStore() { await fs.mkdir(getAnnouncementDir(), { recursive: true }); }
async function readPlaylist() {
  await ensureAnnouncementStore();
  try {
    const parsed = JSON.parse(await fs.readFile(getPlaylistPath(), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
}
async function writePlaylist(items) {
  const target = getPlaylistPath();
  const temp = target + '.' + process.pid + '.tmp';
  await fs.writeFile(temp, JSON.stringify(items, null, 2), 'utf8');
  await fs.rename(temp, target);
}
function runArabicSpeech(text, outputPath) {
  return new Promise((resolve, reject) => {
    if (!isWindows) return reject(new Error('توليد الصوت المحلي متاح في نسخة Windows فقط.'));
    const textB64 = Buffer.from(text, 'utf8').toString('base64');
    const pathB64 = Buffer.from(outputPath, 'utf8').toString('base64');
    const ps = [
      "$ErrorActionPreference = 'Stop'",
      'Add-Type -AssemblyName System.Speech',
      "$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + textB64 + "'))",
      "$output = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + pathB64 + "'))",
      '$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer',
      'try {',
      "  $voice = $synth.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name.StartsWith('ar', [StringComparison]::OrdinalIgnoreCase) } | Select-Object -First 1",
      "  if (-not $voice) { throw 'لم يتم العثور على صوت عربي مثبت في Windows. ثبّت حزمة صوت عربية من إعدادات Windows ثم أعد المحاولة.' }",
      '  $synth.SelectVoice($voice.VoiceInfo.Name)',
      '  $synth.SetOutputToWaveFile($output)',
      '  $synth.Speak($text)',
      '} finally { $synth.Dispose() }'
    ].join('\r\n');
    const encoded = Buffer.from(ps, 'utf16le').toString('base64');
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', async code => {
      if (code === 0) {
        try {
          const stat = await fs.stat(outputPath);
          if (stat.size < 44) return reject(new Error('ملف الصوت الناتج غير صالح.'));
          resolve();
        } catch (error) { reject(error); }
      } else reject(new Error(stderr.trim() || 'فشل محرك تحويل النص إلى كلام في Windows.'));
    });
  });
}

ipcMain.handle('announcer:list', async () => readPlaylist());
ipcMain.handle('announcer:create', async (_event, payload) => {
  if (!isWindows) throw new Error('توليد الصوت المحلي متاح في نسخة Windows فقط.');
  const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
  const title = typeof payload?.title === 'string' ? payload.title.trim().slice(0, 80) : '';
  if (!text) throw new Error('اكتب نص العرض أولاً.');
  if (text.length > 700) throw new Error('الحد الأقصى لنص الإعلان 700 حرف.');
  const id = crypto.randomUUID();
  const fileName = id + '.wav';
  const audioPath = path.join(await getAnnouncementDir(), fileName);
  await runArabicSpeech(text, audioPath);
  const items = await readPlaylist();
  const item = { id, title: title || text.slice(0, 48), text, fileName, createdAt: new Date().toISOString() };
  items.unshift(item);
  await writePlaylist(items);
  return item;
});
ipcMain.handle('announcer:audio', async (_event, id) => {
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id)) throw new Error('معرّف ملف صوت غير صالح.');
  const items = await readPlaylist();
  const item = items.find(entry => entry.id === id);
  if (!item) throw new Error('الإعلان غير موجود في قائمة التشغيل.');
  const data = await fs.readFile(path.join(getAnnouncementDir(), id + '.wav'));
  return data.toString('base64');
});
ipcMain.handle('announcer:delete', async (_event, id) => {
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id)) throw new Error('معرّف إعلان غير صالح.');
  const items = await readPlaylist();
  const item = items.find(entry => entry.id === id);
  if (!item) return false;
  await fs.rm(path.join(getAnnouncementDir(), id + '.wav'), { force: true });
  await writePlaylist(items.filter(entry => entry.id !== id));
  return true;
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440, height: 920, minWidth: 1024, minHeight: 700,
    show: false, autoHideMenuBar: true, backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
      devTools: !app.isPackaged
    }
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = app.isPackaged ? url.startsWith('kashir://app/') : (url.startsWith('http://127.0.0.1:3000/') || url.startsWith('http://localhost:3000/'));
    if (!allowed) event.preventDefault();
  });
  if (app.isPackaged) mainWindow.loadURL('kashir://app/index.html');
  else mainWindow.loadURL('http://127.0.0.1:3000');
  mainWindow.on('closed', () => { mainWindow = null; });
}
app.whenReady().then(() => {
  if (!isWindows) { app.quit(); return; }
  if (app.isPackaged) {
    const distRoot = path.resolve(__dirname, '..', 'dist');
    protocol.handle(APP_SCHEME, request => {
      const requestUrl = new URL(request.url);
      if (requestUrl.host !== 'app') return new Response('Not found', { status: 404 });
      let decodedPath;
      try { decodedPath = decodeURIComponent(requestUrl.pathname); }
      catch { return new Response('Bad request', { status: 400 }); }
      const targetPath = path.resolve(distRoot, '.' + decodedPath);
      if (targetPath !== distRoot && !targetPath.startsWith(distRoot + path.sep)) {
        return new Response('Forbidden', { status: 403 });
      }
      return net.fetch(pathToFileURL(targetPath).href);
    });
  }
  createWindow();
});
app.on('second-instance', () => {
  if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
});
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0 && isWindows) createWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
