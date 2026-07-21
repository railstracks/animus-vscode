# Animus — VSCode Extension

<p align="center">
  <strong>Persistent AI agents in your IDE</strong>
</p>

Animus is a VSCode extension that connects to an [Animus](https://github.com/railstracks/animus) daemon, bringing persistent, multi-provider AI agents directly into your development workflow.

**What is Animus?** [Animus](https://animus.steadyfort.com) is an open-source agent framework that provides persistent AI agents with memory, tool execution, and multi-provider LLM support. The agent isn't the model — swap GPT → GLM → Ollama and agent continuity, knowledge, and memories persist. Learn more at [animus.steadyfort.com](https://animus.steadyfort.com) or browse the source at [github.com/railstracks/animus](https://github.com/railstracks/animus).

The extension is a thin client — all intelligence, memory, and tool execution lives in the Animus daemon. The extension handles connection, session browsing, chat, and streaming.

## Features

### 🤖 Multi-Agent Sessions
Browse active sessions across all your agents. Create new sessions with full control over provider, model, and reasoning settings.

### 💬 Streaming Chat
Full conversation interface with token-by-token streaming. Thinking blocks, tool calls, and file attachments render inline.

### ⚙️ Per-Message Overrides
Change provider, model, or reasoning level mid-conversation via a collapsible settings panel. No need to start a new session to switch models.

### 🔌 Connect Anywhere
Works with local daemons (`localhost`) or remote servers. Your agent's memory and tools persist regardless of where you connect from.

## Getting Started

### Prerequisites

- An [Animus](https://github.com/railstracks/animus) daemon (v0.1+) running locally or remotely — [installation guide](https://github.com/railstracks/animus#getting-started)
- Admin auth token for the daemon

### Installation

**From Marketplace:**
Search for "Animus" in the VSCode Extensions panel, or install from the [marketplace page](https://marketplace.visualstudio.com/vscode).

**From VSIX:**
```bash
code --install-extension animus-0.0.1.vsix
```

**From source:**
```bash
git clone https://github.com/railstracks/animus-vscode
cd animus-vscode
npm install
npm run compile
# Press F5 in VSCode to launch an Extension Development Host
```

### Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `animus.daemonUrl` | `http://localhost:8080` | Animus daemon URL |
| `animus.authToken` | `""` | Admin auth token |
| `animus.agentId` | `""` | Default agent for new sessions |
| `animus.node` | `""` | Node name for workspace tool routing |

1. Open the Animus sidebar (activity bar icon)
2. Click **Connect** or run `Animus: Connect` from the command palette
3. Enter your daemon URL and auth token
4. Browse sessions or start a new conversation

## Architecture

```
VSCode Extension → WebSocket → Animus Daemon → LLM Provider
                                  ↓
                              Tools (shell, file, project, ...)
                              Memory & Session Persistence
```

The extension communicates with the daemon via HTTP REST and WebSocket. The daemon handles LLM inference, tool execution, session management, and memory persistence.

## Links

- **Website:** [animus.steadyfort.com](https://animus.steadyfort.com)
- **Animus source:** [github.com/railstracks/animus](https://github.com/railstracks/animus)
- **Extension source:** [github.com/railstracks/animus-vscode](https://github.com/railstracks/animus-vscode)
- **Discord:** [Join the community](https://discord.gg/ruRk76M93n)

## License

[Apache-2.0](LICENSE)
