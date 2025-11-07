import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  Client, GatewayIntentBits, EmbedBuilder, ButtonBuilder, ButtonStyle,
  ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
  Events
} from 'discord.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATE_PATH = path.join(__dirname, 'state.json');

const ABMELDE_CHANNEL_ID = process.env.ABMELDE_CHANNEL;
const UEBERSICHT_CHANNEL_ID = process.env.UEBERSICHT_CHANNEL;

if (!process.env.DISCORD_TOKEN || !process.env.GUILD_ID || !ABMELDE_CHANNEL_ID || !UEBERSICHT_CHANNEL_ID) {
  console.error('Bitte DISCORD_TOKEN, GUILD_ID, ABMELDE_CHANNEL und UEBERSICHT_CHANNEL in der .env setzen.');
  process.exit(1);
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return {
      lastPanelMessageId: null,
      monthMaps: {} // key: YYYY-MM -> { day(1..31): messageId }
    };
  }
}
function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

const PANEL_BUTTON_ID = 'abmelden_button';
const MODAL_ID = 'abmelden_modal';
const FIELD_ZEITRAUM = 'feld_zeitraum';
const FIELD_GRUND = 'feld_grund';

// ---------- Datum & Format ----------
function pad(n) { return n.toString().padStart(2, '0'); }
function germanDateStr(date) { return `${pad(date.getDate())}.${pad(date.getMonth()+1)}.${date.getFullYear()}`; }
function weekdayGerman(date) {
  return ['Sonntag','Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag'][date.getDay()];
}
function firstDayOfMonth(year, monthIdx0) { return new Date(year, monthIdx0, 1, 12, 0, 0); }
function lastDayOfMonth(year, monthIdx0) { return new Date(year, monthIdx0 + 1, 0, 12, 0, 0); }

// Zeitraum-Parser (DE-Formate):
// - "TT.MM.JJJJ"
// - "TT.MM.JJJJ - TT.MM.JJJJ"
// - "TT.MM.JJJJ HH:MM - TT.MM.JJJJ HH:MM"
// - "TT.MM.JJJJ HH:MM - HH:MM" (gleicher Tag)
function parseZeitraum(input) {
  const s = input.trim().replace(/\s+/g, ' ');
  const reFull = /^(\d{2})\.(\d{2})\.(\d{4})(?: (\d{2}):(\d{2}))?\s*-\s*(?:(\d{2})\.(\d{2})\.(\d{4})(?: (\d{2}):(\d{2}))?|(\d{2}):(\d{2}))$/;
  const reSingle = /^(\d{2})\.(\d{2})\.(\d{4})(?: (\d{2}):(\d{2}))?$/;

  let start = null, end = null, hasTimes = false;

  if (reFull.test(s)) {
    const m = s.match(reFull);
    const d1 = parseInt(m[1],10), mo1 = parseInt(m[2],10), y1 = parseInt(m[3],10);
    const h1 = m[4]?parseInt(m[4],10):0, mi1 = m[5]?parseInt(m[5],10):0;

    if (m[6] && m[7] && m[8]) {
      // Ende mit Datum
      const d2 = parseInt(m[6],10), mo2 = parseInt(m[7],10), y2 = parseInt(m[8],10);
      const h2 = m[9]?parseInt(m[9],10):23, mi2 = m[10]?parseInt(m[10],10):59;
      start = new Date(y1, mo1-1, d1, h1, mi1, 0);
      end   = new Date(y2, mo2-1, d2, h2, mi2, 0);
      hasTimes = !!m[4] || !!m[9];
    } else {
      // Ende mit Uhrzeit (gleicher Tag)
      const h2 = parseInt(m[11],10), mi2 = parseInt(m[12],10);
      start = new Date(y1, mo1-1, d1, h1, mi1, 0);
      end   = new Date(y1, mo1-1, d1, h2, mi2, 0);
      hasTimes = true;
    }
  } else if (reSingle.test(s)) {
    const m = s.match(reSingle);
    const d = parseInt(m[1],10), mo = parseInt(m[2],10), y = parseInt(m[3],10);
    const h = m[4]?parseInt(m[4],10):0, mi = m[5]?parseInt(m[5],10):0;
    start = new Date(y, mo-1, d, h, mi, 0);
    end   = new Date(y, mo-1, d, m[4]?h:23, m[5]?mi:59, 0);
    hasTimes = !!m[4];
  } else {
    throw new Error('Ungültiges Format.');
  }

  if (end < start) throw new Error('Ende liegt vor dem Beginn.');
  return { start, end, hasTimes };
}

function* eachDayInclusive(startDate, endDate) {
  const d = new Date(startDate);
  d.setHours(12,0,0,0);
  while (d <= endDate) {
    yield new Date(d);
    d.setDate(d.getDate() + 1);
  }
}

// ---------- UI-Bausteine ----------
function buildPanelEmbed() {
  return new EmbedBuilder()
    .setTitle('ABMELDUNG')
    .setDescription(
      [
        'Hier für einen bestimmten Zeitraum abmelden.',
        '',
        '**WICHTIG:**',
        '• Abmeldungen sind **NICHT** zum Ausnutzen gedacht!',
        '• Abmeldungen sind **so früh es geht** einzutragen.'
      ].join('\n')
    )
    .setColor(0x2f3136); // dunkelgrau
}

function buildPanelRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(PANEL_BUTTON_ID)
      .setLabel('Abmelden')
      .setStyle(ButtonStyle.Secondary)
  );
}

function buildModal() {
  const modal = new ModalBuilder()
    .setCustomId(MODAL_ID)
    .setTitle('Abwesenheitseintragung');

  // Discord erlaubt keine fette/unterstrichene Formatierung im Feld-Label selbst.
  // Wir geben die Überschrift über den Modal-Titel vor.
  const zeitraum = new TextInputBuilder()
    .setCustomId(FIELD_ZEITRAUM)
    .setLabel('Abmeldezeitraum')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('z. B. 17.11.2025 09:00 - 18.11.2025 16:00 (keine „unbestimmte Zeit“)')
    .setRequired(true);

  const grund = new TextInputBuilder()
    .setCustomId(FIELD_GRUND)
    .setLabel('Grund')
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('z. B. Arzttermin, Urlaub, Schule …')
    .setRequired(true);

  const row1 = new ActionRowBuilder().addComponents(zeitraum);
  const row2 = new ActionRowBuilder().addComponents(grund);

  modal.addComponents(row1, row2);
  return modal;
}

async function sendOrReplacePanel(channel, state) {
  if (state.lastPanelMessageId) {
    try {
      const msg = await channel.messages.fetch(state.lastPanelMessageId);
      if (msg) await msg.delete().catch(() => {});
    } catch {}
  }
  const sent = await channel.send({
    embeds: [buildPanelEmbed()],
    components: [buildPanelRow()]
  });
  state.lastPanelMessageId = sent.id;
  saveState(state);
  return sent;
}

// ---------- Monatsübersichten ----------
async function ensureMonthOverview(channel, year, monthIdx0, state) {
  const key = `${year}-${(monthIdx0+1).toString().padStart(2,'0')}`;
  if (!state.monthMaps[key]) state.monthMaps[key] = {};

  const map = state.monthMaps[key];
  const start = firstDayOfMonth(year, monthIdx0);
  const end = lastDayOfMonth(year, monthIdx0);

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const day = d.getDate();
    if (map[day]) continue;

    const title = `📅 ${weekdayGerman(d)}, ${germanDateStr(d)}`;
    const body = [
      '— Abmeldungen für diesen Tag —',
      '(Einträge werden automatisch ergänzt.)'
    ].join('\n');

    const m = await channel.send({
      embeds: [ new EmbedBuilder().setTitle(title).setDescription(body).setColor(0x2f3136) ]
    });
    map[day] = m.id;
  }
  saveState(state);
}

async function appendToDay(channel, dateObj, line, state) {
  const year = dateObj.getFullYear();
  const monthIdx0 = dateObj.getMonth();
  const key = `${year}-${(monthIdx0+1).toString().padStart(2,'0')}`;
  if (!state.monthMaps[key]) {
    await ensureMonthOverview(channel, year, monthIdx0, state);
  }
  const day = dateObj.getDate();
  const msgId = state.monthMaps[key][day];
  if (!msgId) {
    await ensureMonthOverview(channel, year, monthIdx0, state);
  }
  const msg = await channel.messages.fetch(state.monthMaps[key][day]);
  const embed = EmbedBuilder.from(msg.embeds[0] ?? new EmbedBuilder().setColor(0x2f3136));
  const oldDesc = embed.data.description ?? '';
  const newDesc = oldDesc.includes('— Abmeldungen für diesen Tag —')
    ? oldDesc + '\n' + line
    : (oldDesc + '\n' + line).trim();
  embed.setDescription(newDesc);
  await msg.edit({ embeds: [embed] });
}

// ---------- Bot-Events ----------
client.once('ready', async () => {
  console.log(`Eingeloggt als ${client.user.tag}`);

  try {
    const abmeldeChannel = await client.channels.fetch(ABMELDE_CHANNEL_ID);
    const uebersichtChannel = await client.channels.fetch(UEBERSICHT_CHANNEL_ID);

    if (!abmeldeChannel || !uebersichtChannel) {
      console.log('❌ Channel-IDs ungültig oder fehlende Rechte.');
      return;
    }

    // Panel direkt platzieren (immer unten halten)
    await sendOrReplacePanel(abmeldeChannel, loadState());

    // Monatsübersicht für aktuellen Monat sicherstellen
    const now = new Date();
    await ensureMonthOverview(uebersichtChannel, now.getFullYear(), now.getMonth(), loadState());

    console.log('✅ Kanäle aus .env geladen und initialisiert.');
  } catch (e) {
    console.error('Fehler beim Initialisieren:', e);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isButton() && interaction.customId === PANEL_BUTTON_ID) {
    return interaction.showModal(buildModal());
  }

  if (interaction.isModalSubmit() && interaction.customId === MODAL_ID) {
    const zeitStr = interaction.fields.getTextInputValue(FIELD_ZEITRAUM)?.trim();
    const grundStr = interaction.fields.getTextInputValue(FIELD_GRUND)?.trim();

    if (!zeitStr || /unbestimmt|unbefristet|unendlich/i.test(zeitStr)) {
      return interaction.reply({ content: 'Bitte einen **konkreten** Abmeldezeitraum angeben (kein „unbestimmt“).', ephemeral: true });
    }

    let parsed;
    try {
      parsed = parseZeitraum(zeitStr);
    } catch {
      return interaction.reply({
        content: 'Ungültiges Zeitraum-Format. Beispiele:\n• `17.11.2025`\n• `17.11.2025 09:00 - 17.11.2025 16:00`\n• `17.11.2025 - 20.11.2025`\n• `17.11.2025 09:00 - 16:00`',
        ephemeral: true
      });
    }

    const memberMention = `<@${interaction.user.id}>`;
    const niceRange = parsed.hasTimes
      ? `${germanDateStr(parsed.start)} ${pad(parsed.start.getHours())}:${pad(parsed.start.getMinutes())} - ${germanDateStr(parsed.end)} ${pad(parsed.end.getHours())}:${pad(parsed.end.getMinutes())}`
      : (parsed.start.toDateString() === parsed.end.toDateString()
          ? `${germanDateStr(parsed.start)} (ganztägig)`
          : `${germanDateStr(parsed.start)} - ${germanDateStr(parsed.end)} (ganztägig)`);

    try {
      const abmeldeChannel = await client.channels.fetch(ABMELDE_CHANNEL_ID);
      const uebersichtChannel = await client.channels.fetch(UEBERSICHT_CHANNEL_ID);

      const entry = [
        '• **Name:** ' + memberMention,
        '• **Zeitraum:** ' + niceRange,
        '• **Grund:** ' + (grundStr || '—')
      ].join('\n');

      await abmeldeChannel.send(entry);

      // Panel neu senden, damit es unten bleibt
      await sendOrReplacePanel(abmeldeChannel, loadState());

      // In Übersicht pro Tag eintragen
      const startDay = new Date(parsed.start.getFullYear(), parsed.start.getMonth(), parsed.start.getDate());
      const endDay = new Date(parsed.end.getFullYear(), parsed.end.getMonth(), parsed.end.getDate());

      for (const day of eachDayInclusive(startDay, endDay)) {
        let zeitTag = 'ganztägig';
        if (parsed.hasTimes) {
          const from = new Date(day); from.setHours(0,0,0,0);
          const to = new Date(day); to.setHours(23,59,59,999);
          const s = new Date(Math.max(from.getTime(), parsed.start.getTime()));
          const e = new Date(Math.min(to.getTime(), parsed.end.getTime()));
          if (s <= e) {
            const ss = `${pad(s.getHours())}:${pad(s.getMinutes())}`;
            const ee = `${pad(e.getHours())}:${pad(e.getMinutes())}`;
            zeitTag = (ss === '00:00' && ee === '23:59') ? 'ganztägig' : `${ss}–${ee}`;
          }
        }
        const line = `• ${memberMention} — ${zeitTag} (Grund: ${grundStr || '—'})`;
        await ensureMonthOverview(uebersichtChannel, day.getFullYear(), day.getMonth(), loadState());
        await appendToDay(uebersichtChannel, day, line, loadState());
      }

      await interaction.reply({ content: 'Abwesenheit eingetragen. Danke!', ephemeral: true });
    } catch (e) {
      console.error(e);
      return interaction.reply({ content: 'Fehler beim Eintragen. Bitte probiere es erneut.', ephemeral: true });
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
