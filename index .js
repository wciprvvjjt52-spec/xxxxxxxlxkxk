const express = require('express');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Api } = require('telegram/tl');
const input = require('input');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ strict: false }));

const PORT = process.env.PORT || 3000;

// Telegram API bilgileri
const API_ID = 2040;
const API_HASH = 'b18441a1ff607e10a989891a5462e627';

const SESSION_FILE = path.join(__dirname, 'session.txt');
const DATA_FILE = path.join(__dirname, 'data.json');

// ─── data.json yönetimi ──────────────────────────────────────────────────────
const DEFAULT_DATA = {
  bots: {},
  botStates: {},
  logs: [],
  settings: {
    keepAlive: true
  }
};

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const data = JSON.parse(raw);
      // Eksik alanları doldur
      for (const key of Object.keys(DEFAULT_DATA)) {
        if (!(key in data)) {
          data[key] = DEFAULT_DATA[key];
        }
      }
      return data;
    }
  } catch (e) {
    console.log('Data dosyası okunamadı, yeni oluşturuluyor.');
  }
  return JSON.parse(JSON.stringify(DEFAULT_DATA));
}

function saveData(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('Data kaydedilemedi:', e.message);
  }
}

// ─── Verileri yükle ──────────────────────────────────────────────────────────
let data = loadData();
let bots = data.bots || {};
let botStates = data.botStates || {};
let globalLogs = data.logs || [];

// ─── Log sistemi ─────────────────────────────────────────────────────────────
function addLog(msg, type) {
  type = type || 'info';
  const logEntry = { msg: String(msg), type: type, time: new Date().toLocaleTimeString('tr-TR') };
  globalLogs.unshift(logEntry);
  if (globalLogs.length > 300) globalLogs.pop();
  
  // Data'ya da kaydet
  data.logs = globalLogs;
  saveData(data);
  
  console.log(`[${type.toUpperCase()}] ${msg}`);
}

let client = null;
let connected = false;
let authStep = 'idle';
let phoneNumber = '';
let phoneCodeHash = '';

function saveSession(sessionStr) {
  try { 
    fs.writeFileSync(SESSION_FILE, sessionStr, 'utf8');
    console.log('[SESSION] Oturum kaydedildi');
  } catch(e) {
    console.error('[SESSION] Kayıt hatası:', e.message);
  }
}

function loadSession() {
  try { 
    return fs.existsSync(SESSION_FILE) ? fs.readFileSync(SESSION_FILE, 'utf8').trim() : ''; 
  } catch(e) { 
    return ''; 
  }
}

// ─── KEEP-ALIVE: Render URL'yi otomatik algıla ─────────────────────────────
async function keepAlive() {
  const renderHost = process.env.RENDER_EXTERNAL_HOSTNAME || process.env.RENDER_INTERNAL_HOSTNAME;
  if (renderHost) {
    const renderUrl = `https://${renderHost}`;
    try {
      await fetch(`${renderUrl}/api/ping`, { timeout: 8000 });
      console.log(`[KEEP-ALIVE] ${renderUrl} pinglendi`);
    } catch (e) {
      // Sessiz geç
    }
  }
}

setInterval(keepAlive, 10000);
setTimeout(keepAlive, 3000);

// ─── API Ping endpoint ───────────────────────────────────────────────────────
app.get('/api/ping', (req, res) => {
  res.json({ ok: true, connected, time: new Date().toISOString() });
});

// ─── Bot verilerini kaydet ──────────────────────────────────────────────────
function saveBotData() {
  data.bots = bots;
  data.botStates = botStates;
  data.logs = globalLogs;
  saveData(data);
}

// ─── Otomatik giriş ──────────────────────────────────────────────────────────
async function autoLogin() {
  const saved = loadSession();
  if (!saved) {
    addLog('Kayıtlı oturum bulunamadı. Telefon ile giriş yapın.', 'warn');
    return false;
  }
  
  try {
    client = new TelegramClient(new StringSession(saved), API_ID, API_HASH, {
      connectionRetries: 5,
      useWSS: true
    });
    
    await client.connect();
    
    if (await client.isUserAuthorized()) {
      connected = true;
      authStep = 'done';
      addLog('✅ Oturum otomatik yüklendi! Hesabınıza bağlandı.', 'success');
      
      // Botları başlat
      const botNames = Object.keys(bots);
      if (botNames.length > 0) {
        addLog(`${botNames.length} bot yüklendi`, 'info');
        startAllBots();
      }
      
      return true;
    }
  } catch(e) {
    addLog('Oturum yüklenemedi: ' + e.message, 'error');
  }
  return false;
}

// ─── API Rotaları ───────────────────────────────────────────────────────────

// Telefon ile giriş başlat
app.post('/api/auth/send-code', async (req, res) => {
  const { phone } = req.body;
  
  if (!phone) {
    return res.json({ ok: false, error: 'Telefon numarası gerekli' });
  }
  
  try {
    if (client) {
      try { await client.disconnect(); } catch(e) {}
    }
    
    client = new TelegramClient(new StringSession(''), API_ID, API_HASH, {
      connectionRetries: 5,
      useWSS: true
    });
    
    await client.connect();
    
    const result = await client.sendCode({
      apiId: API_ID,
      apiHash: API_HASH
    }, phone);
    
    phoneNumber = phone;
    phoneCodeHash = result.phoneCodeHash;
    authStep = 'code_sent';
    
    addLog(`📱 Doğrulama kodu gönderildi: ${phone}`, 'success');
    res.json({ ok: true, message: 'Kod gönderildi' });
    
  } catch(e) {
    addLog('Kod gönderme hatası: ' + e.message, 'error');
    res.json({ ok: false, error: e.message });
  }
});

// Kodu doğrula
app.post('/api/auth/verify-code', async (req, res) => {
  const { code } = req.body;
  
  if (!code) {
    return res.json({ ok: false, error: 'Kodu girin' });
  }
  
  try {
    await client.invoke(new Api.auth.SignIn({
      phoneNumber: phoneNumber,
      phoneCodeHash: phoneCodeHash,
      phoneCode: code
    }));
    
    const session = client.session.save();
    saveSession(session);
    connected = true;
    authStep = 'done';
    
    addLog('✅ Giriş başarılı! Oturum kaydedildi.', 'success');
    res.json({ ok: true });
    
  } catch(e) {
    if (e.message.includes('SESSION_PASSWORD_NEEDED')) {
      authStep = 'need_2fa';
      res.json({ ok: true, need2fa: true });
    } else {
      res.json({ ok: false, error: e.message });
    }
  }
});

// 2FA doğrula
app.post('/api/auth/verify-2fa', async (req, res) => {
  const { password } = req.body;
  
  if (!password) {
    return res.json({ ok: false, error: '2FA şifresi gerekli' });
  }
  
  try {
    const { computeCheck } = require('telegram/Password');
    const passwordSrp = await client.invoke(new Api.account.GetPassword());
    const checkPassword = await computeCheck(passwordSrp, password);
    
    await client.invoke(new Api.auth.CheckPassword({ password: checkPassword }));
    
    const session = client.session.save();
    saveSession(session);
    connected = true;
    authStep = 'done';
    
    addLog('✅ 2FA doğrulandı! Oturum kaydedildi.', 'success');
    res.json({ ok: true });
    
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

// Çıkış yap
app.post('/api/auth/logout', async (req, res) => {
  try {
    if (client) {
      try { await client.invoke(new Api.auth.LogOut({})); } catch(e) {}
      try { await client.disconnect(); } catch(e) {}
    }
    client = null;
    connected = false;
    authStep = 'idle';
    try { fs.unlinkSync(SESSION_FILE); } catch(e) {}
    addLog('Çıkış yapıldı', 'warn');
    res.json({ ok: true });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

// Bot ekle (userbot olarak)
app.post('/api/bot/add', (req, res) => {
  const { name, chatId, messages, delay, typingDelay, prefix, usePrefix } = req.body;
  
  if (!name) return res.json({ ok: false, error: 'Bot adı gerekli' });
  if (bots[name]) return res.json({ ok: false, error: 'Bu isimde bot zaten var' });
  if (!chatId) return res.json({ ok: false, error: 'Chat ID gerekli' });
  if (!messages || messages.length === 0) return res.json({ ok: false, error: 'En az 1 mesaj girin' });
  
  bots[name] = {
    name,
    chatId,
    messages: messages.filter(m => m.trim()),
    delay: delay || 1000,
    typingDelay: typingDelay || 2000,
    prefix: prefix || '',
    usePrefix: usePrefix || false,
    running: false,
    stats: { sent: 0, errors: 0, loops: 0 }
  };
  
  saveBotData();
  addLog(`🤖 Userbot eklendi: ${name}`, 'success');
  res.json({ ok: true, bot: bots[name] });
});

// Bot sil
app.post('/api/bot/remove', (req, res) => {
  const { name } = req.body;
  if (!bots[name]) return res.json({ ok: false, error: 'Bot bulunamadı' });
  
  if (botStates[name] && botStates[name].running) {
    botStates[name].running = false;
  }
  
  delete bots[name];
  delete botStates[name];
  saveBotData();
  addLog(`🗑️ Userbot silindi: ${name}`, 'warn');
  res.json({ ok: true });
});

// Bot başlat
app.post('/api/bot/start', async (req, res) => {
  const { name } = req.body;
  
  if (!connected || !client) {
    return res.json({ ok: false, error: 'Önce Telegram hesabınıza giriş yapın' });
  }
  
  if (!bots[name]) return res.json({ ok: false, error: 'Userbot bulunamadı' });
  
  const bot = bots[name];
  if (botStates[name]?.running) return res.json({ ok: false, error: 'Userbot zaten çalışıyor' });
  
  botStates[name] = { running: true };
  bot.running = true;
  saveBotData();
  
  addLog(`🚀 Userbot başlatıldı: ${name} -> ${bot.chatId}`, 'success');
  startBotSpam(name);
  res.json({ ok: true });
});

// Bot durdur
app.post('/api/bot/stop', (req, res) => {
  const { name } = req.body;
  if (!bots[name]) return res.json({ ok: false, error: 'Userbot bulunamadı' });
  
  if (botStates[name]?.running) {
    botStates[name].running = false;
    bots[name].running = false;
    saveBotData();
    addLog(`⏹️ Userbot durduruldu: ${name}`, 'warn');
  }
  res.json({ ok: true });
});

// Bot güncelle
app.post('/api/bot/update', (req, res) => {
  const { name, chatId, messages, delay, typingDelay, prefix, usePrefix } = req.body;
  if (!bots[name]) return res.json({ ok: false, error: 'Userbot bulunamadı' });
  
  if (chatId !== undefined) bots[name].chatId = chatId;
  if (messages !== undefined) bots[name].messages = messages;
  if (delay !== undefined) bots[name].delay = delay;
  if (typingDelay !== undefined) bots[name].typingDelay = typingDelay;
  if (prefix !== undefined) bots[name].prefix = prefix;
  if (usePrefix !== undefined) bots[name].usePrefix = usePrefix;
  
  saveBotData();
  addLog(`✏️ Userbot güncellendi: ${name}`, 'info');
  res.json({ ok: true });
});

// Tüm botları getir
app.get('/api/bots', (req, res) => {
  const botList = {};
  for (const name in bots) {
    botList[name] = {
      name,
      chatId: bots[name].chatId,
      messagesCount: bots[name].messages.length,
      running: bots[name].running || false,
      delay: bots[name].delay,
      typingDelay: bots[name].typingDelay,
      prefix: bots[name].prefix,
      usePrefix: bots[name].usePrefix,
      stats: bots[name].stats
    };
  }
  res.json({
    connected,
    authStep,
    bots: botList,
    logs: globalLogs.slice(0, 60)
  });
});

// Spam döngüsü
async function startBotSpam(botName) {
  const bot = bots[botName];
  const state = botStates[botName];
  if (!state || !state.running) return;
  
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  
  while (state.running) {
    const currentBot = bots[botName];
    if (!currentBot || !currentBot.messages.length || !currentBot.chatId) {
      await sleep(3000);
      continue;
    }
    
    if (!connected || !client) {
      addLog(`❌ [${botName}] Telegram bağlantısı yok!`, 'error');
      await sleep(5000);
      continue;
    }
    
    currentBot.stats.loops++;
    
    for (let i = 0; i < currentBot.messages.length; i++) {
      if (!state.running) break;
      
      let msg = currentBot.messages[i];
      if (currentBot.usePrefix && currentBot.prefix) {
        msg = currentBot.prefix + ' ' + msg;
      }
      
      try {
        // Typing efekti
        try {
          await client.invoke(new Api.messages.SetTyping({
            peer: currentBot.chatId,
            action: new Api.SendMessageTypingAction()
          }));
        } catch(te) {}
        
        if (currentBot.typingDelay > 0) await sleep(currentBot.typingDelay);
        if (!state.running) break;
        
        // Mesaj gönder
        await client.sendMessage(currentBot.chatId, { message: msg });
        currentBot.stats.sent++;
        addLog(`✓ [${botName}] ${msg.substring(0,35)}`, 'success');
        saveBotData();
        
      } catch(e) {
        currentBot.stats.errors++;
        addLog(`✗ [${botName}] ${e.message.substring(0,50)}`, 'error');
        
        if (e.message && e.message.includes('FLOOD_WAIT')) {
          const wait = parseInt(e.message.match(/\d+/) || [10])[0] * 1000;
          addLog(`⏳ FloodWait ${wait/1000}sn bekleniyor...`, 'warn');
          await sleep(wait);
        }
      }
      
      if (currentBot.delay > 0 && state.running) await sleep(currentBot.delay);
    }
  }
}

// Kayıtlı botları başlat
async function startAllBots() {
  for (const name in bots) {
    if (bots[name].running) {
      botStates[name] = { running: true };
      startBotSpam(name);
      addLog(`🤖 Otomatik başlatıldı: ${name}`, 'success');
    }
  }
}

// ─── HTML arayüzü ──────────────────────────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Wazer Userbot Manager</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; background: #0a0a0f; color: #e2e8f0; }
    .header { text-align: center; padding: 40px 20px; background: linear-gradient(135deg, #0a0a0f, #1a1a2e); }
    .badge { display: inline-block; background: linear-gradient(135deg, #7c3aed20, #a855f710); border: 1px solid #7c3aed40; border-radius: 100px; padding: 6px 16px; font-size: 11px; margin-bottom: 16px; color: #a855f7; }
    h1 { font-size: 48px; background: linear-gradient(135deg, #fff, #a855f7, #fbbf24); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .sub { color: #64748b; font-size: 13px; }
    .stats { display: flex; justify-content: center; gap: 30px; margin-top: 20px; flex-wrap: wrap; }
    .stat { text-align: center; }
    .stat-value { font-size: 28px; font-weight: 800; background: linear-gradient(135deg, #a855f7, #fbbf24); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .stat-label { font-size: 10px; color: #64748b; text-transform: uppercase; }
    .container { max-width: 1400px; margin: 0 auto; padding: 30px 20px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(400px, 1fr)); gap: 20px; }
    .card { background: #0d0d14; border: 1px solid #1e1e30; border-radius: 20px; padding: 20px; }
    .card-header { font-size: 12px; font-weight: 700; color: #64748b; margin-bottom: 16px; border-bottom: 1px solid #1e1e30; padding-bottom: 12px; display: flex; align-items: center; gap: 8px; }
    .form-group { margin-bottom: 12px; }
    label { font-size: 11px; font-weight: 600; color: #94a3b8; display: block; margin-bottom: 4px; }
    input, textarea { width: 100%; background: #12121e; border: 1px solid #1e1e30; border-radius: 10px; padding: 10px 12px; color: #e2e8f0; font-size: 13px; outline: none; }
    input:focus, textarea:focus { border-color: #7c3aed; }
    textarea { resize: vertical; min-height: 80px; font-family: monospace; }
    button { border: none; border-radius: 10px; padding: 10px 16px; font-weight: 600; cursor: pointer; font-size: 12px; transition: all 0.2s; }
    .btn-primary { background: linear-gradient(135deg, #7c3aed, #a855f7); color: white; }
    .btn-success { background: linear-gradient(135deg, #10b981, #059669); color: white; }
    .btn-danger { background: linear-gradient(135deg, #ef4444, #dc2626); color: white; }
    .btn-warning { background: linear-gradient(135deg, #f59e0b, #d97706); color: white; }
    .btn-secondary { background: #1e1e30; color: #94a3b8; }
    .btn-sm { padding: 6px 12px; font-size: 11px; }
    .flex { display: flex; gap: 8px; flex-wrap: wrap; }
    .bot-item { background: #12121e; border-radius: 12px; padding: 12px; margin-bottom: 10px; border: 1px solid #1e1e30; }
    .bot-name { font-weight: 700; color: #a855f7; }
    .bot-status { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
    .status-running { background: #10b981; box-shadow: 0 0 8px #10b981; }
    .status-stopped { background: #64748b; }
    .status-connected { background: #10b981; box-shadow: 0 0 8px #10b981; }
    .status-disconnected { background: #ef4444; }
    .logs { background: #0d0d14; border: 1px solid #1e1e30; border-radius: 20px; padding: 20px; margin-top: 20px; max-height: 300px; overflow-y: auto; font-family: monospace; font-size: 11px; }
    .log-entry { display: flex; gap: 10px; padding: 4px 8px; border-radius: 6px; }
    .log-time { color: #64748b; }
    .log-success { color: #10b981; }
    .log-error { color: #ef4444; }
    .log-warn { color: #f59e0b; }
    .log-info { color: #94a3b8; }
    .switch { position: relative; display: inline-block; width: 40px; height: 20px; }
    .switch input { opacity: 0; width: 0; height: 0; }
    .slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #1e1e30; border-radius: 20px; }
    .slider:before { position: absolute; content: ""; height: 16px; width: 16px; left: 2px; bottom: 2px; background-color: white; border-radius: 50%; }
    input:checked + .slider { background-color: #a855f7; }
    input:checked + .slider:before { transform: translateX(20px); }
    .inline { display: inline-flex; align-items: center; gap: 8px; }
    .status-badge { display: inline-block; padding: 4px 12px; border-radius: 20px; font-size: 11px; font-weight: 600; }
    .status-badge.connected { background: #10b98120; color: #10b981; border: 1px solid #10b98130; }
    .status-badge.disconnected { background: #ef444420; color: #ef4444; border: 1px solid #ef444430; }
    hr { margin: 16px 0; border-color: #1e1e30; }
    .keep-alive-badge { display: inline-block; padding: 4px 12px; border-radius: 20px; font-size: 10px; background: #7c3aed20; color: #a855f7; border: 1px solid #7c3aed30; }
  </style>
</head>
<body>
  <div class="header">
    <div class="badge">👤 USERBOT v4.0</div>
    <h1>Wazer Userbot Manager</h1>
    <p class="sub">Telefon ile Giriş · Typing · Prefix · Sonsuz Döngü · Çoklu Bot</p>
    <p style="margin-top:10px"><span class="keep-alive-badge">🔄 Keep-Alive Aktif (10 sn)</span></p>
    <div class="stats">
      <div class="stat"><div class="stat-value" id="totalBots">0</div><div class="stat-label">Toplam Userbot</div></div>
      <div class="stat"><div class="stat-value" id="runningBots">0</div><div class="stat-label">Aktif Userbot</div></div>
      <div class="stat"><div class="stat-value" id="totalSent">0</div><div class="stat-label">Toplam Gönderi</div></div>
    </div>
  </div>

  <div class="container">
    <div class="grid">
      <div class="card">
        <div class="card-header">🔐 Telegram Giriş</div>
        <div id="authSection">
          <div id="loginForm">
            <div class="form-group"><label>📱 Telefon Numarası</label><input type="tel" id="phoneNumber" placeholder="+905551234567"></div>
            <button class="btn-primary" style="width:100%" onclick="sendCode()">📱 Kod Gönder</button>
          </div>
          <div id="codeForm" style="display:none">
            <div class="form-group"><label>🔢 Doğrulama Kodu</label><input type="text" id="verificationCode" placeholder="12345" maxlength="6"></div>
            <button class="btn-success" style="width:100%" onclick="verifyCode()">✅ Doğrula</button>
            <button class="btn-secondary" style="width:100%;margin-top:8px" onclick="backToLogin()">← Geri</button>
          </div>
          <div id="twofaForm" style="display:none">
            <div class="form-group"><label>🔐 2FA Şifresi</label><input type="password" id="twofaPassword" placeholder="Şifrenizi girin"></div>
            <button class="btn-success" style="width:100%" onclick="verify2FA()">✅ Doğrula</button>
          </div>
          <div id="logoutForm" style="display:none">
            <div class="status-badge connected" style="margin-bottom:12px;display:block;text-align:center">✅ Hesaba Bağlı</div>
            <button class="btn-danger" style="width:100%" onclick="logout()">🚪 Çıkış Yap</button>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-header">➕ Yeni Userbot Ekle</div>
        <div class="form-group"><label>🤖 Userbot Adı</label><input type="text" id="newBotName" placeholder="ornek_bot"></div>
        <div class="form-group"><label>🎯 Hedef Chat ID / @username</label><input type="text" id="newBotChatId" placeholder="-1001234567890 veya @username"></div>
        <div class="form-group"><label>📝 Mesajlar (Her satır bir mesaj)</label><textarea id="newBotMessages" placeholder="Mesaj 1&#10;Mesaj 2&#10;Mesaj 3"></textarea></div>
        <div class="flex">
          <div class="form-group" style="flex:1"><label>⏱️ Mesaj Aralığı (ms)</label><input type="number" id="newBotDelay" value="1000"></div>
          <div class="form-group" style="flex:1"><label>✏️ Typing Süresi (ms)</label><input type="number" id="newBotTypingDelay" value="2000"></div>
        </div>
        <div class="flex">
          <div class="form-group" style="flex:2"><label>🏷️ Prefix (Etiket)</label><input type="text" id="newBotPrefix" placeholder="@tag veya [MSG]"></div>
          <div class="form-group" style="flex:1"><label class="inline"><span>🔘 Aktif</span><label class="switch"><input type="checkbox" id="newBotUsePrefix"><span class="slider"></span></label></label></div>
        </div>
        <button class="btn-primary" style="width:100%" onclick="addBot()">➕ Userbot Ekle</button>
      </div>
    </div>

    <div class="card" style="margin-top:20px">
      <div class="card-header">🤖 Aktif Userbotlar</div>
      <div id="botsList">Userbot bulunmuyor...</div>
    </div>

    <div class="card" style="margin-top:20px">
      <div class="card-header">📋 Canlı Loglar</div>
      <div class="logs" id="logs"></div>
    </div>
  </div>

  <script>
    let bots = {};
    let connected = false;
    let authStep = 'idle';

    async function api(endpoint, method = 'GET', data = null) {
      try {
        const options = { method, headers: { 'Content-Type': 'application/json' } };
        if (data) options.body = JSON.stringify(data);
        const res = await fetch(endpoint, options);
        const text = await res.text();
        try { return JSON.parse(text); } catch(e) { return { ok: false, error: text }; }
      } catch(e) { return { ok: false, error: e.message }; }
    }

    function updateAuthUI() {
      if (connected) {
        document.getElementById('loginForm').style.display = 'none';
        document.getElementById('codeForm').style.display = 'none';
        document.getElementById('twofaForm').style.display = 'none';
        document.getElementById('logoutForm').style.display = 'block';
      } else if (authStep === 'code_sent') {
        document.getElementById('loginForm').style.display = 'none';
        document.getElementById('codeForm').style.display = 'block';
        document.getElementById('twofaForm').style.display = 'none';
        document.getElementById('logoutForm').style.display = 'none';
      } else if (authStep === 'need_2fa') {
        document.getElementById('loginForm').style.display = 'none';
        document.getElementById('codeForm').style.display = 'none';
        document.getElementById('twofaForm').style.display = 'block';
        document.getElementById('logoutForm').style.display = 'none';
      } else {
        document.getElementById('loginForm').style.display = 'block';
        document.getElementById('codeForm').style.display = 'none';
        document.getElementById('twofaForm').style.display = 'none';
        document.getElementById('logoutForm').style.display = 'none';
      }
    }

    async function sendCode() {
      const phone = document.getElementById('phoneNumber').value.trim();
      if (!phone) return alert('Telefon numarası girin!');
      const btn = event.target;
      btn.textContent = 'Gönderiliyor...';
      btn.disabled = true;
      const res = await api('/api/auth/send-code', 'POST', { phone });
      btn.textContent = '📱 Kod Gönder';
      btn.disabled = false;
      if (res.ok) {
        authStep = 'code_sent';
        updateAuthUI();
        alert('Kod gönderildi!');
      } else {
        alert('Hata: ' + res.error);
      }
    }

    async function verifyCode() {
      const code = document.getElementById('verificationCode').value.trim();
      if (!code) return alert('Kodu girin!');
      const btn = event.target;
      btn.textContent = 'Doğrulanıyor...';
      btn.disabled = true;
      const res = await api('/api/auth/verify-code', 'POST', { code });
      btn.textContent = '✅ Doğrula';
      btn.disabled = false;
      if (res.ok) {
        if (res.need2fa) {
          authStep = 'need_2fa';
          updateAuthUI();
          alert('2FA şifresi gerekli!');
        } else {
          connected = true;
          authStep = 'done';
          updateAuthUI();
          alert('Giriş başarılı!');
          loadBots();
        }
      } else {
        alert('Hata: ' + res.error);
      }
    }

    async function verify2FA() {
      const password = document.getElementById('twofaPassword').value;
      if (!password) return alert('2FA şifresini girin!');
      const btn = event.target;
      btn.textContent = 'Doğrulanıyor...';
      btn.disabled = true;
      const res = await api('/api/auth/verify-2fa', 'POST', { password });
      btn.textContent = '✅ Doğrula';
      btn.disabled = false;
      if (res.ok) {
        connected = true;
        authStep = 'done';
        updateAuthUI();
        alert('Giriş başarılı!');
        loadBots();
      } else {
        alert('Hata: ' + res.error);
      }
    }

    function backToLogin() {
      authStep = 'idle';
      updateAuthUI();
    }

    async function logout() {
      if (!confirm('Çıkış yapmak istediğinize emin misiniz?')) return;
      const res = await api('/api/auth/logout', 'POST');
      if (res.ok) {
        connected = false;
        authStep = 'idle';
        updateAuthUI();
        alert('Çıkış yapıldı');
        loadBots();
      }
    }

    async function addBot() {
      if (!connected) return alert('Önce Telegram hesabınıza giriş yapın!');
      
      const name = document.getElementById('newBotName').value.trim();
      const chatId = document.getElementById('newBotChatId').value.trim();
      const messagesRaw = document.getElementById('newBotMessages').value;
      const messages = messagesRaw.split('\\n').filter(m => m.trim());
      const delay = parseInt(document.getElementById('newBotDelay').value) || 1000;
      const typingDelay = parseInt(document.getElementById('newBotTypingDelay').value) || 2000;
      const prefix = document.getElementById('newBotPrefix').value.trim();
      const usePrefix = document.getElementById('newBotUsePrefix').checked;

      if (!name) return alert('Userbot adı gerekli!');
      if (!chatId) return alert('Chat ID girin!');
      if (!messages.length) return alert('En az 1 mesaj girin!');

      const res = await api('/api/bot/add', 'POST', { name, chatId, messages, delay, typingDelay, prefix, usePrefix });
      if (res.ok) {
        alert('Userbot eklendi!');
        document.getElementById('newBotName').value = '';
        document.getElementById('newBotChatId').value = '';
        document.getElementById('newBotMessages').value = '';
        document.getElementById('newBotPrefix').value = '';
        document.getElementById('newBotUsePrefix').checked = false;
        loadBots();
      } else {
        alert('Hata: ' + res.error);
      }
    }

    async function startBot(name) {
      const res = await api('/api/bot/start', 'POST', { name });
      if (res.ok) loadBots();
      else alert('Hata: ' + res.error);
    }

    async function stopBot(name) {
      const res = await api('/api/bot/stop', 'POST', { name });
      if (res.ok) loadBots();
      else alert('Hata: ' + res.error);
    }

    async function removeBot(name) {
      if (!confirm('Userbotu silmek istediğinize emin misiniz?')) return;
      const res = await api('/api/bot/remove', 'POST', { name });
      if (res.ok) loadBots();
      else alert('Hata: ' + res.error);
    }

    async function updateBot(name) {
      const newChatId = prompt('Yeni Chat ID:', bots[name]?.chatId || '');
      if (newChatId === null) return;
      const res = await api('/api/bot/update', 'POST', { name, chatId: newChatId });
      if (res.ok) loadBots();
      else alert('Hata: ' + res.error);
    }

    function renderBots() {
      const container = document.getElementById('botsList');
      const botArray = Object.values(bots);
      
      if (botArray.length === 0) {
        container.innerHTML = '<div style="text-align:center;padding:40px;color:#64748b">🤖 Hiç userbot eklenmemiş</div>';
        return;
      }

      let html = '';
      for (const bot of botArray) {
        const isRunning = bot.running;
        html += \`
          <div class="bot-item">
            <div class="flex" style="justify-content:space-between;align-items:center;margin-bottom:10px">
              <div><span class="bot-status \${isRunning ? 'status-running' : 'status-stopped'}"></span><span class="bot-name">\${bot.name}</span></div>
              <div class="flex">
                <button class="btn-sm \${isRunning ? 'btn-warning' : 'btn-success'}" onclick="\${isRunning ? 'stopBot' : 'startBot'}('\${bot.name}')">\${isRunning ? '⏹ Durdur' : '▶ Başlat'}</button>
                <button class="btn-sm btn-secondary" onclick="updateBot('\${bot.name}')">✏️ Düzenle</button>
                <button class="btn-sm btn-danger" onclick="removeBot('\${bot.name}')">🗑️ Sil</button>
              </div>
            </div>
            <div style="font-size:11px;color:#94a3b8">
              <div>🎯 Hedef: \${bot.chatId || 'Belirtilmemiş'}</div>
              <div>📝 Mesaj: \${bot.messagesCount} adet | Prefix: \${bot.usePrefix ? bot.prefix : 'Kapalı'}</div>
              <div>📊 Gönderilen: \${(bot.stats?.sent || 0).toLocaleString()} | Hata: \${(bot.stats?.errors || 0)} | Döngü: \${(bot.stats?.loops || 0)}</div>
            </div>
          </div>
        \`;
      }
      container.innerHTML = html;
    }

    function renderLogs(logs) {
      const container = document.getElementById('logs');
      if (!logs || !logs.length) {
        container.innerHTML = '<div style="text-align:center;padding:20px;color:#64748b">Log bekleniyor...</div>';
        return;
      }
      let html = '';
      for (const log of logs.slice(0, 60)) {
        let colorClass = 'log-info';
        if (log.type === 'success') colorClass = 'log-success';
        else if (log.type === 'error') colorClass = 'log-error';
        else if (log.type === 'warn') colorClass = 'log-warn';
        html += \`<div class="log-entry"><span class="log-time">[\${log.time}]</span><span class="\${colorClass}">\${log.msg}</span></div>\`;
      }
      container.innerHTML = html;
    }

    async function loadBots() {
      try {
        const res = await api('/api/bots');
        connected = res.connected;
        authStep = res.authStep || 'idle';
        bots = res.bots || {};
        
        updateAuthUI();
        renderBots();
        renderLogs(res.logs || []);
        
        const botArray = Object.values(bots);
        let running = 0, totalSent = 0;
        for (const bot of botArray) {
          if (bot.running) running++;
          totalSent += (bot.stats?.sent || 0);
        }
        document.getElementById('totalBots').innerHTML = botArray.length;
        document.getElementById('runningBots').innerHTML = running;
        document.getElementById('totalSent').innerHTML = totalSent.toLocaleString();
      } catch(e) {}
    }

    setInterval(loadBots, 2000);
    loadBots();
  </script>
</body>
</html>`;

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(HTML);
});

// ─── Başlangıç ──────────────────────────────────────────────────────────────
autoLogin();

app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║     👤 WAZER USERBOT MANAGER v4.0      ║
║     Telefon ile Giriş · Çoklu Bot      ║
║                                        ║
║     🚀 http://localhost:${PORT}         ║
║     🔄 Keep-Alive: 10 saniye           ║
║     💾 Veriler: session.txt + data.json║
║     📱 API ID/Hash Gerekmez            ║
╚════════════════════════════════════════╝
  `);
});