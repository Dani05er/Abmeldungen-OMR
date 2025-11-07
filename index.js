import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  Client, GatewayIntentBits, EmbedBuilder, ButtonBuilder, ButtonStyle,
  ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
  Events, ChannelType
} from 'discord.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATE_PATH = path.join(__dirname, 'state.json');

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return {
      guildId: null,
      abmeldeChannelId: null,
      uebersichtChannelId: null,
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

// ---------- Hilfsfunktionen Datum ----------
const TZ = 'Europe/Berlin'; // rein informativ; wir parsen Strings in DE-Form

function pad(n) { return n.toString().padStart(2, '0'); }
function ymd(date) {
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  return `${y}-${m}-${d}`;
}
function germanDateStr(date) {
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`;
}
function weekdayGerman(date) {
  return ['Sonntag','Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag'][date.getDay()];
}
function firstDayOfMonth(year, monthIdx0) {
  return new Date(year, monthIdx0, 1, 12, 0, 0); // 12:00 vermeidet DST-Kanten
}
function lastDayOfMonth(year, monthIdx0) {
  return new Date(year, monthIdx0 + 1, 0, 12, 0, 0);
}

// Erwartete Eingaben:
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
    // ganztägig, falls keine Zeit
    end = new Date(y, mo-1, d, m[4]?h:23, m[5]?mi:59, 0);
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

  const head = new TextInputBuilder()
    .setCustomId('dummy_header') // “fette, unterstrichene Überschrift”: technisch nicht formatierbar im Feld – wir lösen es im Embed/Titel
    .setLabel('Abwesenheitseintragung')
    .setStyle(TextInputStyle.Short)
    .setValue('— Bitte die Felder unten ausfüllen —')
    .setRequired(false);

  const rowHead = new ActionRowBuilder().addComponents(head);

  const zeitraum = new TextInputBuilder()
    .setCustomId(FIELD_ZEITRAUM)
    .setLabel('Abmeldezeitraum')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('z. B. 17.11.2025 09:00 - 18.11.2025 16:00 (keine „unbestimmte Zeit“) ')
    .setRequired(true);

  const grund = new TextInputBuilder()
    .setCustomId(FIELD_GRUND)
    .setLabel('Grund')
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('z. B. Arzttermin, Urlaub, Schule …')
    .setRequired(true);

  const row1 = new ActionRowBuilder().addComponents(zeitraum);
  const row2 = new ActionRowBuilder().addComponents(grund);

  modal.addComponents(rowHead, row1, row2);
  return modal;
}

async function sendOrReplacePanel(channel, state) {
  // Vorheriges Panel löschen
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
  const key = `${year}-${pad(monthIdx0 + 1)}`;
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

    const m = await channel.send({ embeds: [ new EmbedBuilder().setTitle(title).setDescription(body).setColor(0x2f3136) ] });
    map[day] = m.id;
  }
  saveState(state);
}

async function appendToDay(channel, dateObj, line, state) {
  const year = dateObj.getFullYear();
  const monthIdx0 = dateObj.getMonth();
  const key = `${year}-${pad(monthIdx0 + 1)}`;
  if (!state.monthMaps[key]) {
    await ensureMonthOverview(channel, year, monthIdx0, state);
  }
  const day = dateObj.getDate();
  const messageId = state.monthMaps[key][day];
  if (!messageId) {
    await ensureMonthOverview(channel, year, monthIdx0, state);
  }
  const msg = await channel.messages.fetch(state.monthMaps[key][day]);
  // Beschreibung erweitern
  const embed = EmbedBuilder.from(msg.embeds[0] ?? new EmbedBuilder().setColor(0x2f3136));
  const oldDesc = embed.data.description ?? '';
  const newDesc = oldDesc.includes('— Abmeldungen für diesen Tag —')
    ? oldDesc + '\n' + line
    : (oldDesc + '\n' + line).trim();
  embed.setDescription(newDesc);
  await msg.edit({ embeds: [embed] });
}

// ---------- Bot-Logik ----------
client.once('ready', () => {
  console.log(`Eingeloggt als ${client.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  const state = loadState();

  // /abmeldungen-setup
  if (interaction.isChatInputCommand() && interaction.commandName === 'abmeldungen-setup') {
    const abmeldeChannel = interaction.options.getChannel('abmelde_channel', true);
    const uebersichtChannel = interaction.options.getChannel('uebersicht_channel', true);

    if (abmeldeChannel.type !== ChannelType.GuildText || uebersichtChannel.type !== ChannelType.GuildText) {
      return interaction.reply({ content: 'Bitte nur Textkanäle auswählen.', ephemeral: true });
    }

    state.guildId = interaction.guildId;
    state.abmeldeChannelId = abmeldeChannel.id;
    state.uebersichtChannelId = uebersichtChannel.id;
    saveState(state);

    // Panel senden/ersetzen
    await sendOrReplacePanel(abmeldeChannel, state);

    // Aktuellen Monat anlegen
    const now = new Date();
    await ensureMonthOverview(uebersichtChannel, now.getFullYear(), now.getMonth(), state);

    await interaction.reply({ content: 'Setup abgeschlossen ✅', ephemeral: true });
    return;
  }

  // Button "Abmelden"
  if (interaction.isButton() && interaction.customId === PANEL_BUTTON_ID) {
    const modal = buildModal();
    return interaction.showModal(modal);
  }

  // Modal Submit
  if (interaction.isModalSubmit() && interaction.customId === MODAL_ID) {
    const zeitStr = interaction.fields.getTextInputValue(FIELD_ZEITRAUM)?.trim();
    const grundStr = interaction.fields.getTextInputValue(FIELD_GRUND)?.trim();

    if (!zeitStr || /unbestimmt|unbefristet|unendlich/i.test(zeitStr)) {
      return interaction.reply({ content: 'Bitte einen **konkreten** Abmeldezeitraum angeben (kein „unbestimmt“).', ephemeral: true });
    }

    let parsed;
    try {
      parsed = parseZeitraum(zeitStr);
    } catch (e) {
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

    // Post im Abmelde-Channel
    try {
      const abmeldeChannel = await client.channels.fetch(loadState().abmeldeChannelId);
      const uebersichtChannel = await client.channels.fetch(loadState().uebersichtChannelId);

      if (!abmeldeChannel || !uebersichtChannel) {
        return interaction.reply({ content: 'Kanäle nicht konfiguriert. Bitte /abmeldungen-setup ausführen.', ephemeral: true });
      }

      const entry = [
        '• **Name:** ' + memberMention,
        '• **Zeitraum:** ' + niceRange,
        '• **Grund:** ' + (grundStr || '—')
      ].join('\n');

      await abmeldeChannel.send(entry);

      // Panel neu senden, damit es unten bleibt
      await sendOrReplacePanel(abmeldeChannel, loadState());

      // In Übersicht pro Tag eintragen
      for (const day of eachDayInclusive(new Date(parsed.start.getFullYear(), parsed.start.getMonth(), parsed.start.getDate()), new Date(parsed.end.getFullYear(), parsed.end.getMonth(), parsed.end.getDate()))) {
        let zeitTag = 'ganztägig';
        if (parsed.hasTimes) {
          // Für Tageszeile eingrenzen
          const from = new Date(day); from.setHours(0,0,0,0);
          const to = new Date(day); to.setHours(23,59,59,999);
          const start = new Date(Math.max(from.getTime(), parsed.start.getTime()));
          const end = new Date(Math.min(to.getTime(), parsed.end.getTime()));
          // Wenn Start/Ende am selben Tag mit Zeit
          if (start <= end) {
            const s = `${pad(start.getHours())}:${pad(start.getMinutes())}`;
            const e = `${pad(end.getHours())}:${pad(end.getMinutes())}`;
            zeitTag = (s === '00:00' && e === '23:59') ? 'ganztägig' : `${s}–${e}`;
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

// Optional: beim Start sicherstellen, dass das Panel existiert (wenn konfiguriert)
client.on('ready', async () => {
  const state = loadState();
  if (state.abmeldeChannelId) {
    try {
      const ch = await client.channels.fetch(state.abmeldeChannelId);
      await sendOrReplacePanel(ch, state);
    } catch {}
  }
  // Monatsübersicht für aktuellen Monat anlegen
  if (state.uebersichtChannelId) {
    try {
      const ch = await client.channels.fetch(state.uebersichtChannelId);
      const now = new Date();
      await ensureMonthOverview(ch, now.getFullYear(), now.getMonth(), state);
    } catch {}
  }
});

client.login(process.env.DISCORD_TOKEN);
