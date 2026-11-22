const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');

const isWindows = process.platform === 'win32';
let mainWindow;
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
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true });
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
  const data = await fs.readFile(path.join(await getAnnouncementDir(), item.fileName));
  return data.toString('base64');
});
ipcMain.handle('announcer:delete', async (_event, id) => {
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id)) throw new Error('معرّف إعلان غير صالح.');
  const items = await readPlaylist();
  const item = items.find(entry => entry.id === id);
  if (!item) return false;
  await fs.rm(path.join(await getAnnouncementDir(), item.fileName), { force: true });
  await writePlaylist(items.filter(entry => entry.id !== id));
  return true;
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440, height: 920, minWidth: 1024, minHeight: 700,
    show: false, autoHideMenuBar: true, backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true
    }
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = app.isPackaged ? url.startsWith('file://') : (url.startsWith('http://127.0.0.1:3000') || url.startsWith('http://localhost:3000'));
    if (!allowed) event.preventDefault();
  });
  if (app.isPackaged) mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  else mainWindow.loadURL('http://127.0.0.1:3000');
  mainWindow.on('closed', () => { mainWindow = null; });
}
app.whenReady().then(() => { if (isWindows) createWindow(); else app.quit(); });
app.on('second-instance', () => {
  if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
});
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0 && isWindows) createWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
