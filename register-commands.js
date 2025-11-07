import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder, ChannelType } from 'discord.js';

const commands = [
  new SlashCommandBuilder()
    .setName('abmeldungen-setup')
    .setDescription('Richtet die beiden Channels ein und erstellt Monatsübersichten.')
    .addChannelOption(opt =>
      opt.setName('abmelde_channel')
        .setDescription('Channel A: Interaktives Panel + Einträge')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true)
    )
    .addChannelOption(opt =>
      opt.setName('uebersicht_channel')
        .setDescription('Channel B: Tagesübersichten (ein Post pro Tag)')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true)
    )
    .toJSON()
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    await rest.put(
      Routes.applicationGuildCommands((await rest.get(Routes.oauth2CurrentApplication())).id, process.env.GUILD_ID),
      { body: commands }
    );
    console.log('Slash-Commands registriert.');
  } catch (e) {
    console.error(e);
  }
})();
