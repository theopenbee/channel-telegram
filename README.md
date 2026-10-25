# openbee Telegram channel

Telegram channel for openbee, built on [`@theopenbee/channel-sdk`](https://www.npmjs.com/package/@theopenbee/channel-sdk). It replaces the Telegram channel that used to be built into openbee and keeps its config, session keys and authorized users.

## Behaviour

- Long polling, so openbee needs no public address. A webhook left on the bot is removed at startup.
- Every message the bot receives is handled: private chats, and in groups whatever Telegram delivers (with Group Privacy on, only commands and replies to the bot).
- One openbee session per chat and user (`telegram:<chat_id>:<user_id>`); each forum topic gets its own session (`telegram:<chat_id>:<topic_id>:<user_id>`). Replies and proactive messages stay in the topic.
- `auth_code` set: users must send `/auth <code>` once before the bot answers them. Others get a hint at most once a minute. Authorized users are stored in the plugin data directory; the list kept by the built-in channel (`~/.openbee/telegram/authorized_users.json`) is imported on first start.
- Photos, documents, audio, voice notes, videos, video notes and stickers up to `max_media_size` bytes are downloaded into openbee's media directory; captions become the message text. The Bot API itself only serves files up to 20 MB.
- Replies longer than 4096 characters are split, preferring line breaks. Text is sent first, then the file. Images Telegram refuses as photos are sent as documents.
- When a group is upgraded to a supergroup, openbee moves its pending and scheduled tasks to the new chat id.
- The bot menu gets a `/clear` command.
- `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` in openbee's environment are honoured.

## Create the bot

1. Talk to [@BotFather](https://t.me/BotFather), send `/newbot` and copy the token.
2. Optional, for groups: `/setprivacy` → **Disable** lets the bot see every group message. Remove and re-add the bot to a group after changing it.

## Install

```sh
openbee plugin install @theopenbee/channel-telegram
```

Or from a local checkout:

```sh
git clone https://github.com/theopenbee/channel-telegram.git
cd channel-telegram
npm install
openbee plugin install "$(pwd)"
```

Then enable it with `openbee config`, or add it to `config.yaml` and restart openbee. A config written for the built-in channel works unchanged:

```yaml
bee:
  platforms:
    telegram:
      enabled: true
      bot_name: OpenBee
      token: "<bot token>"
      auth_code: "<code users send with /auth>"
```

| Key | Default | |
|---|---|---|
| `token` | | Bot token from @BotFather. Required. |
| `auth_code` | empty | Code for `/auth`; empty lets everyone use the bot. `openbee config` suggests a random one. |
| `max_media_size` | `52428800` | Largest attachment, in bytes, downloaded or sent. |
| `api_base_url` | `https://api.telegram.org` | Bot API server, for a self-hosted server or a reverse proxy. |

## Development

```sh
npm install
npm test
```

`npm install` also builds `dist/`; run `npm run build` after changing `src/`.
