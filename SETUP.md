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
5. Grant it the appropriate roles (e.g., "Service Account User")
6. Create a JSON key and download it
7. In [Google Play Console](https://play.google.com/console) → Settings → API access
8. Link the Google Cloud project and grant the service account permissions

## Environment Variables

Set these in your shell profile:

### macOS / Linux (`~/.zshrc` or `~/.bashrc`)

```bash
export GPLAY_SERVICE_ACCOUNT_KEY="/path/to/service-account.json"
```

Then reload: `source ~/.zshrc`

### Windows (PowerShell)

```powershell
$env:GPLAY_SERVICE_ACCOUNT_KEY = "C:\Users\YOU\.config\gplay\service-account.json"
```

### Windows (CMD)

```cmd
setx GPLAY_SERVICE_ACCOUNT_KEY "C:\Users\YOU\.config\gplay\service-account.json"
```

## Recommended Key Location

```
macOS/Linux: ~/.config/gplay/service-account.json
Windows:     %USERPROFILE%\.config\gplay\service-account.json
```

Restrict permissions: `chmod 600 service-account.json`

## Install & Build

```bash
npm install
npm run build
```

## Add to Claude Code

Copy `.mcp.json.example` to your project's `.mcp.json`:

```bash
cp .mcp.json.example /path/to/your/project/.mcp.json
```

Update the `args` path:

```json
"args": ["/full/path/to/gplay-mcp-server/dist/index.js"]
```

Restart Claude Code.

## Security

- **Never commit your service account JSON** to any repository
- **Never hardcode the file path** in `.mcp.json` — use `${GPLAY_SERVICE_ACCOUNT_KEY}`
- The service account key file should have restricted permissions
- Rotate keys periodically via Google Cloud Console
- Use the principle of least privilege — grant only the permissions needed
