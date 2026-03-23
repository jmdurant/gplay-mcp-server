# Google Play MCP Server

An MCP (Model Context Protocol) server that provides Claude Code with direct access to the Google Play Developer API. Handles app management, build uploads, store listings, screenshots, testing tracks, reviews, and more.

## Setup

### 1. Get a Service Account Key

1. Go to [Google Cloud Console](https://console.cloud.google.com/) > APIs & Services > Credentials
2. Create a Service Account (or use existing)
3. Create and download a JSON key for the service account
4. Go to [Google Play Console](https://play.google.com/console/) > Settings > API access
5. Grant your service account access to your apps

### 2. Install

```bash
cd gplay-mcp-server
npm install
npm run build
```

### 3. Configure Claude Code

Add to your project's `.mcp.json` (or copy the one included in this repo):

```json
{
  "mcpServers": {
    "gplay": {
      "command": "node",
      "args": ["${HOME}/gplay-mcp-server/dist/index.js"],
      "env": {
        "HOME": "${USERPROFILE}",
        "GPLAY_SERVICE_ACCOUNT_KEY": "/path/to/service-account.json"
      }
    }
  }
}
```

> The `"HOME": "${USERPROFILE}"` line ensures cross-platform compatibility (Windows sets `USERPROFILE`, macOS/Linux set `HOME`). On macOS/Linux you can remove it.

The server will guide you through setup if credentials are missing or invalid.

Restart Claude Code to pick up the new MCP server.

## Available Tools

### App Management
| Tool | Description |
|---|---|
| `list_apps` | List all apps in Google Play Console |
| `create_app` | Create a new app listing |
| `get_app_details` | Get detailed info about an app |

### Builds & Tracks
| Tool | Description |
|---|---|
| `upload_bundle` | Upload an AAB/APK to a track |
| `build_flutter` | Build a Flutter project and upload to Google Play |
| `list_tracks` | List release tracks and their status |
| `promote_track` | Promote a release between tracks |

### Store Listings
| Tool | Description |
|---|---|
| `get_store_listing` | Get store listing for a language |
| `update_store_listing` | Update store listing text |
| `list_store_listings` | List all store listing languages |

### Screenshots & Images
| Tool | Description |
|---|---|
| `list_images` | List uploaded images by type |
| `upload_image` | Upload a screenshot or graphic |
| `delete_image` | Delete an image |

### Testing
| Tool | Description |
|---|---|
| `list_testers` | List testers on a track |
| `add_testers` | Add testers by email |
| `remove_testers` | Remove testers by email |

### Reviews
| Tool | Description |
|---|---|
| `list_reviews` | List user reviews |
| `reply_to_review` | Reply to a user review |

### Pre-launch
| Tool | Description |
|---|---|
| `preflight_check` | Run pre-launch checks on an app |

### Availability & Pricing
| Tool | Description |
|---|---|
| `get_country_availability` | Get country availability and pricing |
| `convert_region_prices` | Convert prices across regions |

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `GPLAY_SERVICE_ACCOUNT_KEY` | Yes | Path to Google Cloud service account JSON key file |

## Requirements

- Node.js 18+
- Google Cloud service account with Play Developer API access
