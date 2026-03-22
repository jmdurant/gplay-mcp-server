# Google Play MCP Server — Setup

## Prerequisites

1. A Google Play Developer account
2. A Google Cloud service account with Google Play Developer API access
3. Node.js 18+

## Create Service Account

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create or select a project
3. Enable the **Google Play Developer API**
4. Go to IAM & Admin → Service Accounts → Create Service Account
5. Grant appropriate roles (e.g., "Service Account User")
6. Create a JSON key and download it
7. In [Google Play Console](https://play.google.com/console) → Settings → API access
8. Link the Google Cloud project and grant the service account permissions

## Install & Build

```bash
npm install
npm run build
```

## Configure Credentials

### Option 1: Shared `.env` file (Recommended)

Create `~/.env` with your credentials. The `.mcp.json` shell wrapper sources this automatically.

```bash
# ~/.env
GPLAY_SERVICE_ACCOUNT_KEY="/path/to/service-account.json"
```

Recommended key location:
```
macOS/Linux: ~/.config/gplay/service-account.json
Windows:     %USERPROFILE%\.config\gplay\service-account.json
```

Secure both files:
```bash
chmod 600 ~/.env
chmod 600 ~/.config/gplay/service-account.json
```

You can also create a project-level `.env` to override per-project.

### Option 2: Shell profile environment variables

#### macOS / Linux (`~/.zshrc` or `~/.bashrc`)

```bash
export GPLAY_SERVICE_ACCOUNT_KEY="/path/to/service-account.json"
```

#### Windows (PowerShell)

```powershell
$env:GPLAY_SERVICE_ACCOUNT_KEY = "C:\Users\YOU\.config\gplay\service-account.json"
```

#### Windows (CMD — persistent)

```cmd
setx GPLAY_SERVICE_ACCOUNT_KEY "C:\Users\YOU\.config\gplay\service-account.json"
```

## Add to Claude Code

Copy `.mcp.json.example` to your project's `.mcp.json` (or merge into existing):

```json
{
  "mcpServers": {
    "google-play": {
      "command": "bash",
      "args": ["-c", "set -a && source $HOME/.env && source ./.env 2>/dev/null && exec node $HOME/gplay-mcp-server/dist/index.js"]
    }
  }
}
```

How it works:
- `set -a` — auto-exports all sourced variables
- `source $HOME/.env` — loads shared credentials
- `source ./.env 2>/dev/null` — loads project overrides (silent if missing)
- `exec node ...` — launches the server

Restart Claude Code after adding.

## Security

- **Never commit your service account JSON** to any repository
- **Never hardcode credentials** in `.mcp.json` — use the `.env` sourcing pattern
- Secure your files: `chmod 600 ~/.env` and `chmod 600 service-account.json`
- Add `.env` to your global gitignore: `echo ".env" >> ~/.gitignore_global`
- Rotate keys periodically via Google Cloud Console
- Use the principle of least privilege for API permissions
