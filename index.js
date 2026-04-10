import TelegramBot from "node-telegram-bot-api";
import { google } from "googleapis";
import http from "http";
import fs from "fs";

/**
 * ENV richieste:
 * TELEGRAM_TOKEN
 * SPREADSHEET_ID
 * GOOGLE_SERVICE_ACCOUNT_JSON  (il JSON completo del service account)
 *
 * Named ranges richiesti nel foglio:
 * tab_camere_app5p12
 * tab_camere_app7p1
 * tab_camere_app10p1
 * tab_camere_app13p1
 *
 * Foglio richiesto:
 * Registrazioni (UserID, TuoNick, DataRegistrazione)
 */

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SA_JSON_RAW = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

if (!TELEGRAM_TOKEN || !SPREADSHEET_ID || !SA_JSON_RAW) {
  console.error("Missing ENV. Need TELEGRAM_TOKEN, SPREADSHEET_ID, GOOGLE_SERVICE_ACCOUNT_JSON");
  process.exit(1);
}

let SA;
try {
  SA = JSON.parse(SA_JSON_RAW);
} catch (e) {
  console.error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON");
  process.exit(1);
}

const auth = new google.auth.JWT({
  email: SA.client_email,
  key: SA.private_key,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

const LOCK_FILE = "/tmp/bot.lock";

try {
  fs.writeFileSync(LOCK_FILE, String(Date.now()), { flag: "wx" });
  console.log("Lock acquired:", LOCK_FILE);
} catch (e) {
  console.log("Another instance detected, exiting.");
  process.exit(0);
}

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

await bot.getMe().then(me => {
  bot.botInfo = me;
});

bot.onText(/^\/ping$/, async (msg) => {
  console.log("CHAT ID:", msg.chat.id);
  await bot.sendMessage(msg.chat.id, "pong ✅ (polling ok)");
});

bot.on("new_chat_members", async (msg) => {
  if (!msg.new_chat_members) return;

  for (const member of msg.new_chat_members) {
    // Ignora se è il bot stesso
    if (member.id === bot.botInfo?.id) continue;

    const username = member.username
      ? `@${member.username}`
      : member.first_name;

    const text =
      `⚜️ <b>Benvenuto ${username}!</b>\n\n` +
      `Per controllare pagamenti e scadenze utilizza il bot in <b>privato</b>.\n\n` +
      `➡️ Prima di tutto, avviami cliccando sul mio profilo e premi <code>/start</code>.\n` +
      `➡️ Usa i seguenti comandi <code>/compagni</code>,<code>/modifiche</code> e <code>/bonifici</code> per avere informazioni sulle tariffe dei compagni, sulle modifiche all'interno della tua camera e sui bonifici.`;

    await bot.sendMessage(msg.chat.id, text, {
      parse_mode: "HTML"
    });
  }
});

// ==== Config ====
const CAMERA_RANGES = [
  { app: "app5p12", range: "tab_camere_app5p12", base: 800 },
  { app: "app7p1",  range: "tab_camere_app7p1",  base: 500 },
  { app: "app10p1", range: "tab_camere_app10p1", base: 500 },
  { app: "app13p1", range: "tab_camere_app13p1", base: 1200 },
];

const COMP_RANGES = [
  { app: "app5p12", range: "tab_compagni_app5p12" },
  { app: "app7p1",  range: "tab_compagni_app7p1" },
  { app: "app10p1", range: "tab_compagni_app10p1" },
  { app: "app13p1", range: "tab_compagni_app13p1" },
];

function normalizeNick_(s) {
  return String(s || "").trim().toLowerCase();
}

function normalizeTelegramTag_(s) {
  const raw = String(s || "").trim();
  if (!raw) return "";
  return raw.startsWith("@") ? raw : `@${raw}`;
}

function bonusCompagni(app, n) {
  const x = Number(n) || 0;
  const a = String(app || "").trim().toLowerCase();

  if (a === "app13p1") {
    return x * 200;
  }

  if (x === 1) return 100;
  if (x === 2) return 200;
  if (x === 3) return 400;
  if (x >= 4) return 600;
  return 0;
}

function fmtDate(d) {
  if (!d) return "—";

  // 1) Se è già una Date
  if (d instanceof Date && !Number.isNaN(d.getTime())) {
    return formatDDMMYYYY_(d);
  }

  const s = String(d).trim();

  // 2) ISO (2026-03-01 o 2026-03-01T...)
  // NB: questo è sempre interpretabile bene
  const iso = new Date(s);
  if (!Number.isNaN(iso.getTime()) && /^\d{4}-\d{2}-\d{2}/.test(s)) {
    return formatDDMMYYYY_(iso);
  }

  // 3) Se arriva già DD/MM/YYYY (o DD/MM/YYYY HH:MM)
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const yyyy = Number(m[3]);

    // Heuristica:
    // - se il primo numero > 12 -> è DD/MM sicuro
    // - se il secondo numero > 12 -> è MM/DD sicuro
    // - se entrambi <= 12, assumiamo DD/MM (italiano)
    let dd, mm;
    if (a > 12) { dd = a; mm = b; }
    else if (b > 12) { dd = b; mm = a; }
    else { dd = a; mm = b; }

    const hh = m[4] ? Number(m[4]) : 0;
    const min = m[5] ? Number(m[5]) : 0;

    const dt = new Date(yyyy, mm - 1, dd, hh, min, 0);
    if (!Number.isNaN(dt.getTime())) return formatDDMMYYYY_(dt);
  }

  // 4) Se arriva tipo "3/1/2026" senza zeri, stesso parsing sopra lo copre.
  return "—";
}

function formatDDMMYYYY_(dt) {
  const dd = String(dt.getDate()).padStart(2, "0");
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const yyyy = dt.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

// ===== Google Sheets helpers =====
async function valuesGet(range) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range,
    valueRenderOption: "UNFORMATTED_VALUE",
    dateTimeRenderOption: "FORMATTED_STRING",
  });
  return res.data.values || [];
}

async function valuesAppend(rangeA1, row) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: rangeA1,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row] },
  });
}

async function valuesUpdate(rangeA1, row) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: rangeA1,
    valueInputOption: "RAW",
    requestBody: { values: [row] },
  });
}

// ===== Registrazioni =====
async function getRegisteredNick(userId) {
  const rows = await valuesGet("Registrazioni!A:C");
  // rows[0] header
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (String(r[0] ?? "") === String(userId)) {
      return String(r[1] ?? "").trim() || null;
    }
  }
  return null;
}

async function upsertRegistration(userId, tuoNick) {
  const rows = await valuesGet("Registrazioni!A:C");
  const now = new Date()
  .toLocaleString("it-IT", {
    timeZone: "Europe/Rome",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  })
  .replace(",", "");

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (String(r[0] ?? "") === String(userId)) {
      // update row i+1
      const rowIndex = i + 1;
      await valuesUpdate(`Registrazioni!A${rowIndex}:C${rowIndex}`, [String(userId), normalizeNick_(tuoNick), now]);
      return;
    }
  }
  // append
  await valuesAppend("Registrazioni!A:C", [String(userId), normalizeNick_(tuoNick), now]);
}

// ===== Lookup in camere by header =====
function headerIndexMap(headerRow) {
  const h = headerRow.map(x => String(x ?? "").trim().toLowerCase());
  const idx = (name) => h.indexOf(name);

  return {
    camera: idx("camera"),
    stato: idx("stato"),
    cf: idx("cod.fiscale"),
    telegram: idx("telegram"),
    comp: idx("n° compagni"),
    scad: idx("scadenza"),
  };
}

function isOccupata(stato) {
  return String(stato ?? "").trim().toUpperCase() === "OCCUPATA";
}

async function findOccupanteByNick(tuoNickRaw) {
  const target = normalizeNick_(tuoNickRaw);

  // 1) Prima: cerca intestatario nelle camere
  const owner = await findOwnerInCamere_(target);
  if (owner.found) return { ...owner, ruolo: "intestatario" };

  // 2) Se non trovato: cerca come compagno
  const comp = await findCompagnoInCompagni_(target);
  if (!comp.found) return { found: false };

  // 3) Risali alla camera nell'app corrispondente e prendi info dalla tab camere
  const ownerFromCamera = await findOwnerByAppCamera_(comp.appartamento, comp.camera);
  if (!ownerFromCamera.found) {
    // compagno esiste ma la camera non risulta occupata / mismatch
    return { found: false };
  }

  return { ...ownerFromCamera, ruolo: "compagno" };
}

// ===== Helpers =====
// comment
async function findOwnerInCamere_(targetNickUpper) {
  for (const c of CAMERA_RANGES) {
    const rows = await valuesGet(c.range);
    if (rows.length < 2) continue;

    const idxs = headerIndexMap(rows[0]);
    if (idxs.camera < 0 || idxs.stato < 0 || idxs.cf < 0) continue;

    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r || r.length === 0) continue;
      if (!isOccupata(r[idxs.stato])) continue;

      const nick = normalizeNick_(r[idxs.cf]);
      if (nick !== targetNickUpper) continue;

      const camera = String(r[idxs.camera] ?? "").trim();
      const comp = idxs.comp >= 0 ? Number(r[idxs.comp]) || 0 : 0;
      const scad = idxs.scad >= 0 ? String(r[idxs.scad] ?? "").trim() : "";

      return {
        found: true,
        appartamento: c.app,
        camera,
        compagni: comp,
        scadenza: scad,
        prezzoBase: c.base,
      };
    }
  }
  return { found: false };
}

function compHeaderIndexMap_(headerRow) {
  const h = headerRow.map(x => String(x ?? "").trim().toLowerCase());

  const idx = (names) => {
    for (const n of names) {
      const k = h.indexOf(n);
      if (k >= 0) return k;
    }
    for (let i = 0; i < h.length; i++) {
      for (const n of names) {
        if (h[i].includes(n)) return i;
      }
    }
    return -1;
  };

  return {
    camera: idx(["camera"]),
    cf: idx(["cod.fiscale", "codice fiscale", "cf", "tuonick"]),
    telegram: idx(["telegram"]),
  };
}

async function findCompagnoInCompagni_(targetNickUpper) {
  for (const c of COMP_RANGES) {
    const rows = await valuesGet(c.range);
    if (rows.length < 2) continue;

    const idxs = compHeaderIndexMap_(rows[0]);
    if (idxs.camera < 0 || idxs.cf < 0) continue;

    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r || r.length === 0) continue;

      const nick = normalizeNick_(r[idxs.cf]);
      if (nick !== targetNickUpper) continue;

      const camera = String(r[idxs.camera] ?? "").trim();
      return { found: true, appartamento: c.app, camera };
    }
  }
  return { found: false };
}

async function findOwnerByAppCamera_(app, camera) {
  const conf = CAMERA_RANGES.find(x => x.app === app);
  if (!conf) return { found: false };

  const rows = await valuesGet(conf.range);
  if (rows.length < 2) return { found: false };

  const idxs = headerIndexMap(rows[0]);
  if (idxs.camera < 0 || idxs.stato < 0) return { found: false };

  const camTarget = String(camera || "").trim();

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length === 0) continue;

    const cam = String(r[idxs.camera] ?? "").trim();
    if (cam !== camTarget) continue;

    if (!isOccupata(r[idxs.stato])) return { found: false };

    const comp = idxs.comp >= 0 ? Number(r[idxs.comp]) || 0 : 0;
    const scad = idxs.scad >= 0 ? String(r[idxs.scad] ?? "").trim() : "";

    return {
      found: true,
      appartamento: conf.app,
      camera: cam,
      compagni: comp,
      scadenza: scad,
      prezzoBase: conf.base,
    };
  }

  return { found: false };
}

// ===== Messaggi =====
function startPrivatoText(usernameOrAt) {
  return (
    `⚜️ <b>Benvenuto nel bot di HcLiving</b> ${usernameOrAt}\n\n` +
    `In questo bot potrai controllare:\n` +
    `• I tuoi <b>pagamenti</b>\n` +
    `• Le tue <b>scadenze</b>\n` +
    `• La tua <b>camera</b>\n\n` +
    `Per iniziare utilizza <code>/registra nickname</code>\n\n` +
    `Se sei già registrato utilizza <code>/info</code>\n` +
    `Per altri comandi consultare il gruppo principale.\n\n` +
    `<i>Bot sviluppato da Astaroth19</i>`
  );
}

const helpText =
`⚜️ <b>Lista comandi in privato: </b>\n\n` +
`<code>/start</code>\n` +
`<code>/info</code>\n` +
`<code>/registra</code> tuoNick\n\n` +
`⚜️ <b>Lista comandi: </b>\n\n` +
`<code>/help</code>\n` +
`<code>/bonifici</code>\n` +
`<code>/compagni</code>\n` +
`<code>/modifiche</code>\n` +
`<code>/about</code>\n` +
`<code>/ping (non abusare)</code>\n`;

const aboutText =
`⚜️ <b>Su di noi:</b>\n\n` +
`Bot sviluppato principalmente per noia, non a scopo di lucro, esclusiva HcLiving per @AtlantisRP. Per bug, segnalazioni o trattamenti speciali 😏 contattare @PollyEugene\n` +
`<i>Astaroth19</i>`;
  
const bonificiText = 
`⚜️ <b>Bonifici</b>\n\n` +
`Nome p.IVA <i>𝐇𝐂 𝐋𝐢𝐯𝐢𝐧𝐠</i>. Rimborseremo interamente il costo della tassa bancaria, secondo le seguenti condizioni:\n\n` + 
`<b>𝐓𝐚𝐫𝐢𝐟𝐟𝐞 𝐁𝐨𝐧𝐢𝐟𝐢𝐜𝐨</b>\n\n` +
`• Da 0€ a 1000€ → 30€\n` +
`• Oltre 1000€ → 3%\n\n` +
`✦ <b>𝐂𝐨𝐦𝐞 𝐑𝐢𝐜𝐡𝐢𝐞𝐝𝐞𝐫𝐞 𝐢𝐥 𝐑𝐢𝐦𝐛𝐨𝐫𝐬𝐨</b>\n\n` +  
`Per richiedere il rimborso, compilate il seguente format e scrivetelo qui:\n` +
`Nickname:\n` +
`Somma pagata:\n` +
`Tassa pagata:\n` +
`#rimborso:\n\n` +
`Il rimborso verrà emesso il prima possibile, <b>attendete sempre pazientemente. </b>`;

const compagniText = 
`⚜️ <b>Compagni</b>\n\n` +
`Si informano gli inquilini del regolamento interno riguardo la condivisione della camera con più di un compagno 
(fino a un massimo di 𝟒).\n` + 
`<b>𝐓𝐀𝐑𝐈𝐅𝐅𝐄</b> (𝐬𝐮𝐩𝐩𝐥𝐞𝐦𝐞𝐧𝐭𝐨 𝐬𝐞𝐭𝐭𝐢𝐦𝐚𝐧𝐚𝐥𝐞):\n` +
`• 𝟏 𝐜𝐨𝐦𝐩𝐚𝐠𝐧𝐨: +𝟏𝟎𝟎\n` +
`• 2 𝐜𝐨𝐦𝐩𝐚𝐠𝐧i: +2𝟎𝟎\n` +
`• 3 𝐜𝐨𝐦𝐩𝐚𝐠𝐧i: +4𝟎𝟎\n` +
`• 4 𝐜𝐨𝐦𝐩𝐚𝐠𝐧i: +6𝟎𝟎\n\n` +
`Il relativo importo verrà aggiunto al pagamento della quota settimanale.`;

const modificheText =
`⚜️ <b>Modifiche</b>\n\n` +
`• Modifiche rapide (< 15 minuti): 0€\n` + 
`• Modifiche estese (> 15 minuti): 1.000€\n` +
`L’importo relativo verrà addebitato prima della prestazione del servizio.\n\n` +
`❗️ Importante: noi di <i>HC 𝐋𝐢𝐯𝐢𝐧𝐠 </i> mettiamo sempre al primo posto il buonsenso, mai il vil denaro. La tariffa estesa verrà applicata SOLO per modifiche importanti alla camera, mai per piccole questioni.`;

const startGruppoText =
`⚜️ <b>Bot HcLiving</b>\n\n` +
`❌ Il bot <b>non può essere utilizzato nei gruppi</b>.\n` +
`➡️ Avviami in <b>privato</b> o usa <code>/help</code>.`;

const registraErroreText =
  `Utilizza correttamente il comando "/registra nickname"`;

const registraOkText =
  `Ti sei registrato con successo, utilizza /info per vedere la tua situazione.`;

const infoNonRegistratoText =
  `Non sei registrato, utilizza prima /registra nickname per poter accedere all'area personale.`;

// ===== /start =====
bot.onText(/^\/start(?:@\w+)?$/i, async (msg) => {
  const isGroup = msg.chat.type !== "private";
  if (isGroup) {
    await bot.sendMessage(msg.chat.id, startGruppoText, {
    parse_mode: "HTML"
    });
    return;
  }
  const at = msg.from?.username ? `@${msg.from.username}` : "@";
  await bot.sendMessage(msg.chat.id, startPrivatoText(at), {
  parse_mode: "HTML"
});
});

// ===== /help =====
bot.onText(/^\/help(?:@\w+)?$/i, async (msg) => {
  const isGroup = msg.chat.type !== "private";
  if (isGroup) {
    await bot.sendMessage(msg.chat.id, helpText, {
    parse_mode: "HTML"
    });
    return;
  }
});

// ===== /modifiche =====
bot.onText(/^\/modifiche(?:@\w+)?$/i, async (msg) => {
  const isGroup = msg.chat.type !== "private";
  if (isGroup) {
    await bot.sendMessage(msg.chat.id, modificheText, {
    parse_mode: "HTML"
    });
    return;
  }
});

// ===== /bonifici =====
bot.onText(/^\/bonifici(?:@\w+)?$/i, async (msg) => {
  const isGroup = msg.chat.type !== "private";
  if (isGroup) {
    await bot.sendMessage(msg.chat.id, bonificiText, {
    parse_mode: "HTML"
    });
    return;
  }
});

// ===== /about =====
bot.onText(/^\/about(?:@\w+)?$/i, async (msg) => {
  const isGroup = msg.chat.type !== "private";
  if (isGroup) {
    await bot.sendMessage(msg.chat.id, aboutText, {
    parse_mode: "HTML"
    });
    return;
  }
});

// ===== /compagni =====
bot.onText(/^\/compagni(?:@\w+)?$/i, async (msg) => {
  const isGroup = msg.chat.type !== "private";
  if (isGroup) {
    await bot.sendMessage(msg.chat.id, compagniText, {
    parse_mode: "HTML"
    });
    return;
  }
});

// ===== /registra nickname =====
bot.onText(/^\/registra(?:@\w+)?(?:\s+(.+))?$/i, async (msg, match) => {
  if (msg.chat.type !== "private") {
    await bot.sendMessage(msg.chat.id, startGruppoText, {
      parse_mode: "HTML"
    });
    return;
  }

  const arg = (match && match[1]) ? String(match[1]).trim() : "";
  if (!arg) {
    await bot.sendMessage(msg.chat.id, registraErroreText);
    return;
  }

  const res = await findOccupanteByNick(arg);
  if (!res.found) {
    await bot.sendMessage(
      msg.chat.id,
      `TuoNick non trovato oppure non risulti occupante.\nHai scritto: ${arg}`
    );
    return;
  }

  await upsertRegistration(msg.from.id, arg);
  await bot.sendMessage(msg.chat.id, registraOkText);
});


// ===== /info =====
bot.onText(/^\/(info|informazioni)(?:@\w+)?$/i, async (msg) => {
  if (msg.chat.type !== "private") {
    await bot.sendMessage(msg.chat.id, startGruppoText, {
      parse_mode: "HTML"
    });
    return;
  }

  const userId = msg.from?.id;
  if (!userId) return;

  const nick = await getRegisteredNick(userId);
  if (!nick) {
    await bot.sendMessage(msg.chat.id, infoNonRegistratoText);
    return;
  }

  const res = await findOccupanteByNick(nick);
  if (!res.found) {
    await bot.sendMessage(msg.chat.id, "Sei registrato, ma ora non risulti occupante di una camera.");
    return;
  }

  const b = bonusCompagni(res.appartamento, res.compagni);
  const sett = res.prezzoBase + b;

  const days = giorniDaOggi_(res.scadenza);

  let daysTxt;
  if (days > 0) {
    daysTxt = `(-${days} giorni)`;
  } else if (days === 0) {
    daysTxt = `⚠️ <b>Scade oggi</b>`;
  } else {
    daysTxt = `❗ <b>Scaduto da ${Math.abs(days)} giorni</b>`;
  }

  const ruoloTxt = res.ruolo === "compagno"
    ? "👥 <i>Sei registrato come compagno</i>\n\n"
    : "";

  const reply =
    `⚜️ <b>Area Personale</b>\n` +
    `👤 <b>${nick}</b>\n\n` +
    ruoloTxt +
    `🏠 <b>Appartamento:</b> ${res.appartamento.toUpperCase()}\n` +
    `🛏 <b>Camera:</b> ${res.camera}\n` +
    `👥 <b>Compagni:</b> ${res.compagni} (bonus +${b}€)\n\n` +
    `💰 <b>Prezzo settimanale:</b> ${sett}€\n` +
    `📅 <b>Scadenza:</b> ${fmtDate(res.scadenza)}\n` +
    `⏳ <b>Giorni mancanti:</b> ${daysTxt}`;

  await bot.sendMessage(msg.chat.id, reply, {
    parse_mode: "HTML"
  });
});

// ===== helpers giorni =====
function giorniDaOggi_(scadenza) {
  const d = parseDateToJS_(scadenza);
  if (!d) return 0;

  const now = new Date();
  const nowIT = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Rome" }));
  const dIT = new Date(d.toLocaleString("en-US", { timeZone: "Europe/Rome" }));

  // azzera ore per confronto giorni “pulito”
  dIT.setHours(0, 0, 0, 0);
  nowIT.setHours(0, 0, 0, 0);

  const diffMs = dIT.getTime() - nowIT.getTime();
  return Math.round(diffMs / (1000 * 60 * 60 * 24));
}

function parseDateToJS_(x) {
  if (!x) return null;
  if (x instanceof Date && !Number.isNaN(x.getTime())) return x;

  const s = String(x).trim();

  // ISO
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const dt = new Date(s);
    return Number.isNaN(dt.getTime()) ? null : dt;
  }

  // DD/MM/YYYY (o DD/MM/YYYY HH:MM)
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (m) {
    const dd = Number(m[1]);
    const mm = Number(m[2]) - 1;
    const yyyy = Number(m[3]);
    const hh = m[4] ? Number(m[4]) : 0;
    const min = m[5] ? Number(m[5]) : 0;
    const dt = new Date(yyyy, mm, dd, hh, min, 0);
    return Number.isNaN(dt.getTime()) ? null : dt;
  }

  // fallback
  const dt = new Date(s);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

const PORT = process.env.PORT || 10000;

http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Bot online");
}).listen(PORT, "0.0.0.0", () => {
  console.log("Health server listening on", PORT);
});


const GROUP_CHAT_MAP = {
  app5p12: process.env.GROUP_APP5P12_CHAT_ID,
  app7p1: process.env.GROUP_APP7P1_CHAT_ID,
  app10p1: process.env.GROUP_APP10P1_CHAT_ID,
  app13p1: process.env.GROUP_APP13P1_CHAT_ID,
};

const DAILY_SUMMARY_HOUR = Number(process.env.DAILY_SUMMARY_HOUR ?? 9);
const DAILY_SUMMARY_MINUTE = Number(process.env.DAILY_SUMMARY_MINUTE ?? 0);

const STATE_SHEET = "BotState"; // key/value

setInterval(async () => {
  try {
    const now = new Date();
    const nowIT = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Rome" }));
    const hh = nowIT.getHours();
    const mm = nowIT.getMinutes();

    // finestra 5 minuti
    if (!(hh === DAILY_SUMMARY_HOUR && mm >= DAILY_SUMMARY_MINUTE && mm < DAILY_SUMMARY_MINUTE + 5)) return;

    const todayKey = nowIT.toISOString().slice(0, 10); // YYYY-MM-DD

    // per ogni appartamento
    for (const c of CAMERA_RANGES) {
      const groupId = GROUP_CHAT_MAP[c.app];
      if (!groupId) continue; // se non impostato, skip

      const sentKey = `daily_${c.app}`;
      const last = await getState_(sentKey);
      if (last === todayKey) continue; // già inviato oggi per questo appartamento

      const msgText = await buildDailySummaryForApp_(c.app);
      if (msgText) {
        await bot.sendMessage(groupId, msgText);
        await setState_(sentKey, todayKey);
      }
    }
  } catch (e) {
    console.log("daily summary error:", e?.message || e);
  }
}, 60 * 1000);

// ===== costruisce riepilogo SOLO per 1 appartamento =====
async function buildDailySummaryForApp_(app) {
  const conf = CAMERA_RANGES.find(x => x.app === app);
  if (!conf) return null;

  const rows = await valuesGet(conf.range);
  if (rows.length < 2) return null;

  const idxs = headerIndexMap(rows[0]);
  if (idxs.camera < 0 || idxs.stato < 0 || idxs.cf < 0) return null;

  const items = [];

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length === 0) continue;
    if (!isOccupata(r[idxs.stato])) continue;

    const ownerNick = String(r[idxs.cf] ?? "").trim();
    const camera = String(r[idxs.camera] ?? "").trim();

    const compCount = idxs.comp >= 0 ? Number(r[idxs.comp]) || 0 : 0;
    const scadStr = idxs.scad >= 0 ? String(r[idxs.scad] ?? "").trim() : "";
    const telegrams = await getTelegramByAppCamera_(app, camera);
    const compNicks = await getCompagniNickByAppCamera_(app, camera);
    const displayName = compNicks.length ? `${ownerNick} & ${compNicks.join(" & ")}` : ownerNick;

    const bonus = bonusCompagni(app, compCount);
    const importo = conf.base + bonus;

    const days = giorniDaOggi_(scadStr);

    let daysTxt = "";
    let alertLine = "";
    
    if (days < 0) {
      daysTxt = `(+${Math.abs(days)} giorni)`;
      alertLine = `❗ SCADUTO`;
    } else if (days === 0) {
      daysTxt = `(oggi)`;
      const mentions = [telegrams.owner, ...telegrams.compagni]
        .filter(Boolean)
        .map(toMention_)
        .join(" ");
      alertLine = `🚨 IN SCADENZA ${mentions}`;
    } else if (days <= 2) {
      daysTxt = `(-${days} giorni)`;
      const mentions = [telegrams.owner, ...telegrams.compagni]
        .filter(Boolean)
        .map(toMention_)
        .join(" ");
      alertLine = `🚨 IN SCADENZA ${mentions}`;
    } else {
      daysTxt = `(-${days} giorni)`;
      alertLine = "";
    }

    items.push({
      displayName,
      scadenzaFmt: fmtDate(scadStr),
      days,
      daysTxt,
      alertLine,
      importo,
      sortKey: sortKeyFromDays_(days),
    });
  }

  if (!items.length) {
    const upd = new Date().toLocaleDateString("it-IT", { timeZone: "Europe/Rome" });
    return `📋 GESTIONE AFFITTI ${app.toUpperCase()}\n\nNessuna camera occupata.\n\nAggiornato ${upd}`;
  }

  items.sort((a, b) => a.sortKey - b.sortKey);

  const upd = new Date().toLocaleDateString("it-IT", { timeZone: "Europe/Rome" });

  let out = `📋 GESTIONE AFFITTI ${app.toUpperCase()}\n\n`;

  for (const it of items) {
  out += `👤 ${it.displayName}\n`;
  if (it.alertLine) {
    out += `${it.alertLine}\n`;
  }
  out += `- Scadenza: ${it.scadenzaFmt} ${it.daysTxt}\n`;
  out += `- Importo: ${it.importo}€\n\n`;
  }

  out += `Aggiornato ${upd}`;
  return out.trim();
}

function sortKeyFromDays_(days) {
  // Ordine:
  // 1) già scaduti
  // 2) scade oggi
  // 3) scade presto
  // 4) il resto
  if (days < 0) return -1000 + days; // più urgente
  return days;
}

// ===== BotState sheet key/value =====
async function ensureStateSheet_() {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const exists = (meta.data.sheets || []).some(s => s.properties?.title === STATE_SHEET);
  if (exists) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [{ addSheet: { properties: { title: STATE_SHEET } } }]
    }
  });

  await valuesUpdate(`${STATE_SHEET}!A1:B1`, ["Key", "Value"]);
}

async function getState_(key) {
  await ensureStateSheet_();
  const rows = await valuesGet(`${STATE_SHEET}!A:B`);
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0] ?? "") === key) return String(rows[i][1] ?? "");
  }
  return "";
}

async function setState_(key, value) {
  await ensureStateSheet_();
  const rows = await valuesGet(`${STATE_SHEET}!A:B`);
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0] ?? "") === key) {
      const rowIndex = i + 1;
      await valuesUpdate(`${STATE_SHEET}!A${rowIndex}:B${rowIndex}`, [key, String(value)]);
      return;
    }
  }
  await valuesAppend(`${STATE_SHEET}!A:B`, [key, String(value)]);
}

// ===== Compagni per camera (serve COMP_RANGES + headers in tab_compagni_*) =====
async function getCompagniNickByAppCamera_(app, camera) {
  // se non hai COMP_RANGES, ritorna []
  if (typeof COMP_RANGES === "undefined") return [];

  const conf = COMP_RANGES.find(x => x.app === app);
  if (!conf) return [];

  const rows = await valuesGet(conf.range);
  if (rows.length < 2) return [];

  // header: camera + cod.fiscale (nick)
  const header = rows[0].map(x => String(x ?? "").trim().toLowerCase());
  const idxCam = header.indexOf("camera");
  const idxCf = header.indexOf("cod.fiscale");
  if (idxCam < 0 || idxCf < 0) return [];

  const camTarget = String(camera || "").trim();
  const nicks = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length === 0) continue;
    if (String(r[idxCam] ?? "").trim() !== camTarget) continue;
    const nick = String(r[idxCf] ?? "").trim();
    if (nick) nicks.push(nick);
  }
  return nicks;
}

async function getTelegramByAppCamera_(app, camera) {
  const conf = CAMERA_RANGES.find(x => x.app === app);
  if (!conf) return { owner: "", compagni: [] };

  const rows = await valuesGet(conf.range);
  if (rows.length < 2) return { owner: "", compagni: [] };

  const header = rows[0].map(x => String(x ?? "").trim().toLowerCase());

  const idxCam = header.indexOf("camera");
  const idxTel = header.indexOf("telegram");

  if (idxCam < 0 || idxTel < 0) return { owner: "", compagni: [] };

  let ownerTelegram = "";

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;

    if (String(r[idxCam] ?? "").trim() === String(camera)) {
      ownerTelegram = String(r[idxTel] ?? "").trim();
      break;
    }
  }

  // compagni
  const compConf = COMP_RANGES.find(x => x.app === app);
  if (!compConf) return { owner: ownerTelegram, compagni: [] };

  const compRows = await valuesGet(compConf.range);
  if (compRows.length < 2) return { owner: ownerTelegram, compagni: [] };

  const compHeader = compRows[0].map(x => String(x ?? "").trim().toLowerCase());
  const idxCamC = compHeader.indexOf("camera");
  const idxTelC = compHeader.indexOf("telegram");

  if (idxCamC < 0 || idxTelC < 0) return { owner: ownerTelegram, compagni: [] };

  const compTelegrams = [];

  for (let i = 1; i < compRows.length; i++) {
    const r = compRows[i];
    if (!r) continue;

    if (String(r[idxCamC] ?? "").trim() !== String(camera)) continue;

    const tel = String(r[idxTelC] ?? "").trim();
    if (tel) compTelegrams.push(tel);
  }

  return {
    owner: ownerTelegram,
    compagni: compTelegrams,
  };
}

async function getReminderMentionsByAppCamera_(app, camera) {
  const mentions = [];

  // owner
  const camConf = CAMERA_RANGES.find(x => x.app === app);
  if (camConf) {
    const rows = await valuesGet(camConf.range);
    if (rows.length >= 2) {
      const idxs = headerIndexMap(rows[0]);
      const camTarget = String(camera || "").trim();

      for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        if (!r || r.length === 0) continue;
        if (String(r[idxs.camera] ?? "").trim() !== camTarget) continue;

        const tg = idxs.telegram >= 0 ? normalizeTelegramTag_(r[idxs.telegram]) : "";
        if (tg) mentions.push(tg);
        break;
      }
    }
  }

  // compagni
  const compConf = COMP_RANGES.find(x => x.app === app);
  if (compConf) {
    const rows = await valuesGet(compConf.range);
    if (rows.length >= 2) {
      const idxs = compHeaderIndexMap_(rows[0]);
      const camTarget = String(camera || "").trim();

      for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        if (!r || r.length === 0) continue;
        if (String(r[idxs.camera] ?? "").trim() !== camTarget) continue;

        const tg = idxs.telegram >= 0 ? normalizeTelegramTag_(r[idxs.telegram]) : "";
        if (tg) mentions.push(tg);
      }
    }
  }

  return [...new Set(mentions)];
  
}

function toMention_(username) {
  const s = String(username || "").trim();
  if (!s) return "";
  return s.startsWith("@") ? s : `@${s}`;
}

function reminderText_(days, mentions, app, camera) {
  let whenTxt = "";
  if (days === 0) whenTxt = "scade oggi";
  else if (days === 1) whenTxt = "scade domani";
  else whenTxt = `scade tra ${days} giorni`;

  const who = mentions.length ? mentions.join(" ") : "Inquilini";
  return `${who} la scadenza della camera ${camera} in ${app.toUpperCase()} ${whenTxt}, volete rinnovare?`;
}


