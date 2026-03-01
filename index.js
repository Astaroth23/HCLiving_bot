import TelegramBot from "node-telegram-bot-api";
import { google } from "googleapis";

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

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// ==== Config ====
const CAMERA_RANGES = [
  { app: "app5p12", range: "tab_camere_app5p12", base: 800 },
  { app: "app7p1",  range: "tab_camere_app7p1",  base: 500 },
  { app: "app10p1", range: "tab_camere_app10p1", base: 500 },
];

function bonusCompagni(n) {
  const x = Number(n) || 0;
  if (x === 1) return 100;
  if (x === 2) return 200;
  if (x === 3) return 400;
  if (x >= 4) return 600;
  return 0;
}

function fmtDate(d) {
  if (!d) return "—";
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return "—";
  return dt.toLocaleDateString("it-IT");
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
  const now = new Date().toISOString();

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (String(r[0] ?? "") === String(userId)) {
      // update row i+1
      const rowIndex = i + 1;
      await valuesUpdate(`Registrazioni!A${rowIndex}:C${rowIndex}`, [String(userId), String(tuoNick), now]);
      return;
    }
  }
  // append
  await valuesAppend("Registrazioni!A:C", [String(userId), String(tuoNick), now]);
}

// ===== Lookup in camere by header =====
function headerIndexMap(headerRow) {
  const h = headerRow.map(x => String(x ?? "").trim().toLowerCase());
  const idx = (name) => h.indexOf(name);

  return {
    camera: idx("camera"),
    stato: idx("stato"),
    cf: idx("cod.fiscale"),
    comp: idx("n° compagni"),
    scad: idx("scadenza"),
  };
}

function isOccupata(stato) {
  return String(stato ?? "").trim().toUpperCase() === "OCCUPATA";
}

async function findOccupanteByNick(tuoNickRaw) {
  const target = String(tuoNickRaw || "").trim().toUpperCase();
  for (const c of CAMERA_RANGES) {
    const rows = await valuesGet(c.range);
    if (rows.length < 2) continue;

    const idxs = headerIndexMap(rows[0]);
    if (idxs.camera < 0 || idxs.stato < 0 || idxs.cf < 0) continue;

    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r || r.length === 0) continue;

      if (!isOccupata(r[idxs.stato])) continue;

      const nick = String(r[idxs.cf] ?? "").trim().toUpperCase();
      if (nick !== target) continue;

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

// ===== Telegram handlers =====
bot.onText(/^\/ping$/, async (msg) => {
  await bot.sendMessage(msg.chat.id, "pong ✅ (polling ok)");
});

bot.onText(/^\/start(?:\s+(.+))?$/i, async (msg, match) => {
  // registrazione solo in privato (evita casini in gruppo)
  if (msg.chat.type !== "private") {
    await bot.sendMessage(msg.chat.id, "🔒 Scrivimi in privato per registrarti: /start <TuoNick>");
    return;
  }

  const arg = (match && match[1]) ? String(match[1]).trim() : "";
  if (!arg) {
    await bot.sendMessage(msg.chat.id, "Per registrarti: /start <TuoNick>\nEsempio: /start Astaroth19");
    return;
  }

  const res = await findOccupanteByNick(arg);
  if (!res.found) {
    await bot.sendMessage(msg.chat.id, `TuoNick non trovato oppure non risulti occupante.\nHai scritto: ${arg}`);
    return;
  }

  await upsertRegistration(msg.from.id, arg);
  await bot.sendMessage(msg.chat.id, "✅ Registrazione completata! Ora usa /info.");
});

bot.onText(/^\/(info|informazioni)$/i, async (msg) => {
  const userId = msg.from?.id;
  if (!userId) return;

  // in gruppo rispondo in privato (serve che l’utente abbia avviato il bot almeno una volta)
  const targetChat = (msg.chat.type === "private") ? msg.chat.id : userId;

  const nick = await getRegisteredNick(userId);
  if (!nick) {
    await bot.sendMessage(targetChat, "Non sei registrato. Scrivimi in privato: /start <TuoNick>");
    return;
  }

  const res = await findOccupanteByNick(nick);
  if (!res.found) {
    await bot.sendMessage(targetChat, "Sei registrato, ma ora non risulti occupante di una camera.");
    return;
  }

  const b = bonusCompagni(res.compagni);
  const sett = res.prezzoBase + b;

  const reply =
    "📌 Le tue info affitto\n" +
    `🪪 TuoNick: ${nick}\n` +
    `🏠 Appartamento: ${res.appartamento.toUpperCase()}\n` +
    `🚪 Camera: ${res.camera}\n` +
    `👥 Compagni: ${res.compagni} (bonus +${b})\n` +
    `💶 Prezzo settimanale: ${sett}€\n` +
    `📅 Scadenza: ${fmtDate(res.scadenza)}`;

  await bot.sendMessage(targetChat, reply);
});

// fallback (opzionale)
bot.on("message", async (msg) => {
  const t = String(msg.text || "");
  if (t.startsWith("/")) return; // comandi già gestiti sopra
});
