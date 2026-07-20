# Animus — VSCode Extension

Persistent AI agents in your IDE, powered by [Animus](https://github.com/railstracks/animus).

## Features

- **Sidebar session browser** — see all agents and their active sessions
- **Chat panel** — full conversation interface with streaming responses
- **Multi-agent** — switch between agents configured on your daemon
- **Tool rendering** — tool calls and results displayed inline
- **Attachment support** — images, audio, and files rendered inline (requires Animus 0.2+)

## Requirements

- An Animus daemon running locally or remotely (v0.2+)
- Admin auth token for the daemon

## Getting Started

1. Install the extension (`.vsix` file or from marketplace)
2. Open the Animus sidebar (icon in the activity bar)
3. Click the status bar item or run **Animus: Connect** command
4. Enter your daemon URL and auth token when prompted
5. Browse sessions or create a new one

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `animus.daemonUrl` | `http://localhost:8080` | Animus daemon URL |
| `animus.authToken` | `""` | Admin auth token |
| `animus.agentId` | `""` | Default agent for new sessions |
| `animus.node` | `""` | Node name for workspace tool routing |

## License

Apache-2.0
