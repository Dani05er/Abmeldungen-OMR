import 'dotenv/config';
import { REST, Routes } from 'discord.js';

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

const commands = []; // absichtlich leer

(async () => {
  try {
    const app = await rest.get(Routes.oauth2CurrentApplication());
    await rest.put(
      Routes.applicationGuildCommands(app.id, process.env.GUILD_ID),
      { body: commands }
    );
    console.log('Slash-Commands geleert (keine Commands registriert).');
  } catch (e) {
    console.error('Fehler beim Registrieren der Commands:', e);
  }
})();
