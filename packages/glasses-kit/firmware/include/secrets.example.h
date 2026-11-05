// Copy this file to secrets.h (same folder) and fill it in.
// secrets.h is git-ignored. Never commit real credentials.
//
// Both boards (C3 and CAM) use the same secrets.h.
#pragma once

// Phone hotspot, 2.4 GHz. (iPhone: Settings > Personal Hotspot > "Maximise Compatibility" ON.)
#define WIFI_SSID     "your-hotspot-name"
#define WIFI_PASSWORD "your-hotspot-password"

// The payer Mac running the bridge (`npm run bridge` in packages/glasses-kit).
// Either its IP on the hotspot (macOS: System Settings > Wi-Fi > Details, or `ipconfig getifaddr en0`;
// iPhone hotspots hand out 172.20.10.x) or its Bonjour name ending in ".local"
// (`scutil --get LocalHostName` + ".local"). An IP is the most reliable.
#define BRIDGE_HOST "172.20.10.2"
#define BRIDGE_PORT 8790  // = BRIDGE_HTTP_PORT on the bridge

// Optional shared token. If the bridge runs with BRIDGE_DEVICE_TOKEN=<same value>, devices
// without it are rejected. Leave "" to disable (the bridge then logs a warning).
#define BRIDGE_DEVICE_TOKEN ""
