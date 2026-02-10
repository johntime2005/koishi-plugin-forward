# koishi-plugin-forward

A message forwarding plugin for Koishi, supporting cross-platform relay rules.

## Features

- **Cross-platform**: Forward messages between different platforms (e.g., OneBot, Discord, Telegram).
- **Flexible Config**: Configure rules via database (persistent) or config file.
- **Robust**: Handles missing channel objects and weird ID structures (e.g., QQ private chats).
- **Two-way Relay**: Supports temporary two-way communication for forwarded messages.

## Usage

### Configuration

```yaml
plugins:
  forward:
    mode: database # or 'config'
    replyTimeout: 3600000 # 1 hour
    rules: # Only for mode: config
      - source: 'onebot:123456'
        target: 'discord:987654321'
        selfId: 'your_bot_id'
        guildId: 'your_guild_id'
```

### Commands

- `forward.add <channel>`: Add a forwarding target for the current channel.
- `forward.remove <channel>`: Remove a forwarding target.
- `forward.clear`: Clear all targets for the current channel.
- `forward.list`: List all forwarding targets.

## License

MIT
