require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { chromium } = require('playwright');
const cheerio = require('cheerio');

const INTRANET = (process.env.INTRANET_URL || 'https://intranet.olisto.fr').replace(/\/$/, '');
const LEAD_FOLDER = process.env.LEAD_FOLDER || 'Lead Olisto';
const DEBUG_DIR = path.join(__dirname, 'logs');
const PROFILE_DIR = path.join(__dirname, 'pw-profile');

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function getImapPass() {
  try {
    const cfg = fs.readFileSync(
      path.join(process.env.USERPROFILE || process.env.HOME, '.config', 'email-mcp', 'config.toml'),
      'utf8'
    );
    const m = cfg.match(/name = "olisto-courtage"[\s\S]{0,500}?password = '([^']+)'/);
    if (m) return m[1];
  } catch (e) {
    log('config.toml illisible:', e.message);
  }
  if (process.env.OLISTO_EMAIL_PASS) return process.env.OLISTO_EMAIL_PASS;
  throw new Error('Pas de mot de passe IMAP trouvé');
}

// Parse le HTML de l'email de notification
function parseLeadEmail(html) {
  const $ = cheerio.load(html);
  const out = { name: null, cityAndText: null, besoin: null, arrived: null, claimLink: null };
  const b = $('b').first();
  if (b.length) {
    out.name = b.text().trim();
    const after = b[0].nextSibling;
    if (after && after.type === 'text') out.cityAndText = after.data.replace(/^,\s*/, '').trim();
  }
  $('p').each((i, el) => {
    const t = $(el).html() || '';
    if (/Besoin\s*:/.test(t)) {
      out.besoin = t.replace(/^.*Besoin\s*:\s*/, '').replace(/<br\s*\/?>\s*Arriv[ée].*$/i, '').replace(/<[^>]+>/g, '').trim();
      const arr = t.match(/Arriv[ée]\s+le\s+([^<]+)/i);
      if (arr) out.arrived = arr[1].trim();
    }
  });
  $('a').each((i, el) => {
    const label = $(el).text().toLowerCase();
    if (/voir si le lead/i.test(label)) out.claimLink = $(el).attr('href');
  });
  return out;
}

// Notification Telegram via CallMeBot (fallback WhatsApp si configuré)
async function notify(text) {
  const tgUser = process.env.TELEGRAM_USER;
  if (tgUser) {
    try {
      const url = `https://api.callmebot.com/text.php?user=${encodeURIComponent(tgUser)}&text=${encodeURIComponent(text)}&html=no`;
      const r = await fetch(url);
      log('Telegram envoyé:', r.status);
      if (r.ok) return true;
    } catch (e) {
      log('Erreur Telegram:', e.message);
    }
  }
  const phone = process.env.WHATSAPP_PHONE;
  const key = process.env.WHATSAPP_APIKEY;
  if (phone && key) {
    try {
      const url = `https://api.callmebot.com/whatsapp.php?phone=${phone}&text=${encodeURIComponent(text)}&apikey=${key}`;
      const r = await fetch(url);
      log('WhatsApp envoyé:', r.status);
      return r.ok;
    } catch (e) {
      log('Erreur WhatsApp:', e.message);
    }
  }
  log('[NOTIFICATION NON CONFIGURÉE]', text);
  return false;
}

function appendLog(entry) {
  fs.mkdirSync(DEBUG_DIR, { recursive: true });
  fs.appendFileSync(path.join(DEBUG_DIR, 'leads.log'), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
}

// ---- Partie navigateur (Playwright) ----

let browserContext = null;

async function getBrowser() {
  if (browserContext) return browserContext;
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  browserContext = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    viewport: { width: 1366, height: 850 },
    locale: 'fr-FR',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  });
  return browserContext;
}

const CLAIM_LABELS = /prendre|disponible|r[ée]cup[ée]rer|claim|je le veux|attribuer|ouvrir/i;
const TAKEN_RE = /(d[ée]j[àa]\s+(pris|attribu[ée]|r[ée]serv[ée]))|((lead|annonce|cet?\s?annonce).{0,30}(pris|attribu[ée]|r[ée]serv[ée]))|plus\s+disponible/i;
const CONFIRM_RE = /(f[ée]licitations|lead\s+(pris|attribu[ée]|r[ée]serv[ée]|enregistr[ée]))|coordonn[ée]es\s+(du\s+)?(prospect|client)|t[ée]l[ée]phone/i;

// Login intranet via navigateur (le JS honeypot s'exécute normalement)
async function ensureLoggedIn(page) {
  await page.goto(INTRANET + '/', { waitUntil: 'domcontentloaded' });
  if (!/wp-login\.php/.test(page.url())) {
    log('Session intranet déjà active');
    return true;
  }
  log('Login intranet requis...');
  await page.waitForSelector('#user_login', { timeout: 15000 });
  await page.fill('#user_login', process.env.INTRANET_LOGIN);
  await page.fill('#user_pass', process.env.INTRANET_PASSWORD);
  if (await page.isChecked('#rememberme').catch(() => false) === false) {
    await page.check('#rememberme').catch(() => {});
  }
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
    page.click('#wp-submit'),
  ]);
  if (/wp-login\.php/.test(page.url())) {
    const err = await page.locator('#login_error').textContent().catch(() => null);
    throw new Error('Login intranet échoué: ' + (err ? err.trim() : page.url()));
  }
  log('Login intranet OK ->', page.url());
  return true;
}

// Ouvre le lien du lead et clique sur le bouton de claim
async function claimLead(claimLink) {
  fs.mkdirSync(DEBUG_DIR, { recursive: true });
  const ctx = await getBrowser();
  const page = await ctx.newPage();
  const result = { status: 'unknown', leadId: null, url: null, text: '' };
  try {
    await page.goto(claimLink, { waitUntil: 'domcontentloaded', timeout: 45000 });
    // Le lien Brevo redirige vers /?lead=N ; le redirect_to du login nous ramène ensuite
    const m = page.url().match(/lead=(\d+)/);
    result.leadId = m ? m[1] : null;

    await ensureLoggedIn(page);

    // Recharge la page du lead si on a atterri ailleurs après login
    if (result.leadId && !/lead=\d+/.test(page.url())) {
      await page.goto(`${INTRANET}/?lead=${result.leadId}`, { waitUntil: 'domcontentloaded' });
    }
    result.url = page.url();

    await page.waitForTimeout(1500);
    const bodyText = await page.locator('body').innerText();
    result.text = bodyText.replace(/\s+/g, ' ').slice(0, 300);
    await page.screenshot({ path: path.join(DEBUG_DIR, `lead-${result.leadId || 'x'}-1.png`), fullPage: false });

    if (TAKEN_RE.test(bodyText)) {
      result.status = 'taken';
      return result;
    }

    // Cherche le bouton/lien de claim
    const btn = page.locator(`a:has-text("disponible"), button:has-text("disponible"), a:has-text("prendre"), button:has-text("prendre"), a:has-text("récupérer"), button:has-text("récupérer")`).first();
    if (await btn.count() === 0) {
      result.status = 'unknown';
      return result;
    }
    log(`Bouton de claim trouvé: "${(await btn.textContent()).trim().slice(0, 60)}"`);
    await btn.click();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);

    const text2 = await page.locator('body').innerText();
    result.url = page.url();
    result.text = text2.replace(/\s+/g, ' ').slice(0, 300);
    await page.screenshot({ path: path.join(DEBUG_DIR, `lead-${result.leadId || 'x'}-2.png`), fullPage: false });

    if (TAKEN_RE.test(text2)) result.status = 'taken';
    else if (CONFIRM_RE.test(text2)) result.status = 'claimed';
    else result.status = 'post-claim-unknown';
    return result;
  } catch (e) {
    result.status = 'error';
    result.error = e.message.slice(0, 200);
    try {
      await page.screenshot({ path: path.join(DEBUG_DIR, `lead-${result.leadId || 'x'}-err.png`) });
    } catch (_) {}
    return result;
  } finally {
    await page.close().catch(() => {});
  }
}

// Traite un email lead: claim + notification + rangement
async function processLeadEmail(client, uid) {
  const msg = await client.fetchOne(uid, { source: true }, { uid: true });
  if (!msg) return;
  const parsed = await simpleParser(msg.source);
  const subject = (parsed.subject || '').trim();
  const from = (parsed.from && parsed.from.text) || '';
  if (!/marketing@olisto\.fr/i.test(from) || !/^Nouveau lead/i.test(subject)) return;

  log(`Lead détecté (uid ${uid}): ${subject.slice(0, 90)}`);
  let lead;
  try {
    lead = parseLeadEmail(parsed.html || parsed.text || '');
  } catch (e) {
    log('Parse erreur:', e.message);
  }
  const detail = `${lead && lead.name ? lead.name : '?'}${lead && lead.cityAndText ? ' (' + lead.cityAndText.split(/(?=L[’']appartement|La maison|Le terrain|Je |Nous |Bonjour)/i)[0].trim() + ')' : ''}`;

  let result = { status: 'no-link' };
  if (lead && lead.claimLink) {
    try {
      result = await claimLead(lead.claimLink);
    } catch (e) {
      result = { status: 'error', error: e.message };
    }
  }

  let notif;
  if (result.status === 'claimed') {
    notif = `✅ Lead CLAIMÉ: ${detail}\nBesoin: ${lead.besoin || '?'}\nArrivé: ${lead.arrived || '?'}\n-> Vérifie Actelo`;
  } else if (result.status === 'taken') {
    notif = `⏱️ Lead déjà pris: ${detail}\nBesoin: ${lead.besoin || '?'}`;
  } else if (result.status === 'error') {
    notif = `⚠️ Erreur auto-claim: ${detail}\n${result.error || ''}\n-> AGIS VITE: ${lead.claimLink || ''}`;
  } else {
    notif = `⚡ Lead à vérifier: ${detail}\nBesoin: ${lead.besoin || '?'}\nArrivé: ${lead.arrived || '?'}\n-> ${lead.claimLink || INTRANET}`;
  }
  await notify(notif);
  appendLog({ uid, subject, detail, status: result.status, leadId: result.leadId, text: result.text });

  // Marque lu et range dans "Lead Olisto"
  try {
    await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
    await client.messageMove(uid, LEAD_FOLDER, { uid: true });
    log(`Email rangé dans "${LEAD_FOLDER}"`);
  } catch (e) {
    log('Rangement échoué:', e.message);
  }
}

// Verrou anti-doublon + heartbeat : le watchdog tue et relance si le process se fige
function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function acquireLock() {
  const lockFile = path.join(__dirname, 'bot.lock');
  try {
    const raw = fs.readFileSync(lockFile, 'utf8').trim();
    let pid = null;
    try { pid = JSON.parse(raw).pid; } catch (e) {}
    if (!pid) pid = parseInt(raw, 10);
    if (pid && pid !== process.pid && isProcessAlive(pid)) return false;
  } catch (e) {}
  const writeHeartbeat = () => {
    try { fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() })); } catch (e) {}
  };
  writeHeartbeat();
  setInterval(writeHeartbeat, 60000);
  process.on('exit', () => { try { fs.unlinkSync(lockFile); } catch (e) {} });
  return true;
}

// Scanne INBOX + "Lead Olisto" : tout lead non lu est traité, où qu'il soit
async function scanUnseen(client) {
  let total = 0;
  for (const box of ['INBOX', LEAD_FOLDER]) {
    try { await client.mailboxOpen(box); } catch (e) { continue; }
    const uids = await client.search({ from: 'marketing@olisto.fr', subject: 'Nouveau lead', seen: false }, { uid: true });
    if (uids && uids.length) {
      log(`${uids.length} lead(s) non vu(s) dans ${box}`);
      for (const uid of uids.sort((a, b) => a - b)) {
        await processLeadEmail(client, uid);
      }
      total += uids.length;
    }
  }
  return total;
}

async function main() {
  const testLead = process.argv.find(a => a.startsWith('--test='));
  if (testLead) {
    const id = testLead.split('=')[1];
    log(`TEST: claim direct du lead ${id}`);
    const r = await claimLead(`${INTRANET}/?lead=${id}`);
    log('Résultat:', JSON.stringify(r, null, 2));
    if (browserContext) await browserContext.close();
    return;
  }

  const once = process.argv.includes('--once');

  if (!once && !acquireLock()) {
    log('Instance déjà active (bot.lock) -> arrêt');
    return;
  }

  // Notification de démarrage : si elle ne t'arrive pas, le bot ne tourne pas
  if (!once) notify(`🟢 Bot leads Olisto démarré (PID ${process.pid})`).catch(() => {});

  // Boucle de reconnexion : un crash IMAP ne tue plus le bot, il réessaie dans 30s
  for (;;) {
    let client = null;
    try {
      client = new ImapFlow({
        host: 'mail.infomaniak.com',
        port: 993,
        secure: true,
        auth: { user: 'r.mpassi@olisto.fr', pass: getImapPass() },
        logger: false,
      });
      await client.connect();
      log('Connecté IMAP olisto-courtage');

      const backlog = await scanUnseen(client);
      if (backlog) log(`${backlog} lead(s) rattrapés au démarrage`);

      if (once) {
        await client.logout().catch(() => {});
        if (browserContext) await browserContext.close();
        log(`--- Mode once terminé (${backlog} lead(s) traités) ---`);
        return;
      }

      await client.mailboxOpen('INBOX');
      log('En écoute (IDLE)...');
      for (;;) {
        await client.idle();
        await scanUnseen(client);
      }
    } catch (e) {
      log('ERREUR IMAP:', e.message, once ? '-> arrêt (mode once)' : '-> reconnexion dans 30s');
      if (client) await client.logout().catch(() => {});
      if (browserContext) await browserContext.close().catch(() => {});
      if (once) throw e;
      await new Promise(r => setTimeout(r, 30000));
    }
  }
}

main().catch(e => {
  log('FATAL:', e.message);
  process.exit(1);
});
