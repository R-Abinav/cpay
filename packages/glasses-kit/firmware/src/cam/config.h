// Build-time config for the CPay glasses firmware (`cam` env). Override with -D flags in platformio.ini.
#pragma once

#ifndef CPAY_FW_VERSION
#define CPAY_FW_VERSION "dev"
#endif

// ---- hub (wss://HUB_HOST:HUB_PORT/HUB_PATH)
#ifndef HUB_HOST
#define HUB_HOST "cpay-hub.onrender.com"
#endif
#ifndef HUB_PORT
#define HUB_PORT 443
#endif
#ifndef HUB_TLS
#define HUB_TLS 1
#endif
#ifndef HUB_PIN
#define HUB_PIN 0
#endif
#ifndef HUB_PATH
#define HUB_PATH "/device"
#endif
static_assert(sizeof(HUB_HOST) > 1, "HUB_HOST is empty (cam-local: set CPAY_HUB_HOST=<laptop ip>)");

// ---- OLED (SSD1306 128x64)
#ifndef PIN_OLED_SDA
#define PIN_OLED_SDA 15
#endif
#ifndef PIN_OLED_SCL
#define PIN_OLED_SCL 14
#endif

// ---- camera
#ifndef CAM_JPEG_QUALITY
// frame2jpg (software JPEG) quality: 1-100, HIGHER = better. 70 keeps QR modules crisp at QVGA (~8-15 KB).
#define CAM_JPEG_QUALITY 70
#endif

// ---- timings (ms)
static const uint32_t WIFI_FAIL_PORTAL_MS = 30000;  // saved network down this long -> reopen the portal
static const uint32_t WIFI_PORTAL_TIMEOUT_S = 180;  // portal closes after this, then we retry the saved network
static const uint32_t HUB_RECONNECT_MS = 2000;
// OLED shows CONNECTING this long after the hub link starts or drops (a slow first auth, a database retry on
// the hub), then NO HUB until auth_ok.
static const uint32_t HUB_CONNECTING_MS = 10000;
static const uint32_t STATUS_EVERY_MS = 5000;
// Local privacy backstop: stop the camera this long after the last stream{on}, in case a stream{off}
// is ever lost. The hub is the real limit: it sends stream{off} 15 s (LIMITS.streamMaxMs) after the
// phone's last scan{on} refresh, but sends stream{on} only once per scan (refreshes aren't forwarded),
// so this must stay longer than any realistic scan.
static const uint32_t STREAM_FAILSAFE_MS = 60000;
