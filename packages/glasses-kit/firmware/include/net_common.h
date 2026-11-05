// Shared Wi-Fi + bridge-connection helpers for the C3 and CAM firmware.
//
// Transport: each board opens ONE outbound WebSocket to the bridge on the payer Mac:
//   ws://BRIDGE_HOST:BRIDGE_PORT/c3?token=...   (buttons up, OLED text down; JSON text frames)
//   ws://BRIDGE_HOST:BRIDGE_PORT/cam?token=...  (capture requests down; JPEG binary frames up)
// Boards only ever dial out, so nothing on the ESP32 needs to be reachable and no IP discovery
// is needed. The library reconnects every 2 s and heartbeats every 5 s.
#pragma once

#include <Arduino.h>
#include <ESPmDNS.h>
#include <WiFi.h>
#include <WebSocketsClient.h>

#if __has_include("secrets.h")
#include "secrets.h"
#else
#error "Missing include/secrets.h: copy include/secrets.example.h to include/secrets.h and fill it in."
#endif

#ifndef BRIDGE_DEVICE_TOKEN
#define BRIDGE_DEVICE_TOKEN ""
#endif

namespace cpaynet {

static const uint32_t WIFI_RETRY_MS = 15000;      // re-issue WiFi.begin if still down after this
static const uint32_t BRIDGE_RERESOLVE_MS = 20000;  // re-resolve a .local host after this long offline

inline void wifiStart(const char *hostname) {
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setHostname(hostname);
  WiFi.setSleep(false);  // lower latency for button events / frames
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

// Call every loop. Kicks Wi-Fi again if it has been down for a while.
inline void wifiMaintain() {
  static uint32_t downSince = 0;
  if (WiFi.status() == WL_CONNECTED) {
    downSince = 0;
    return;
  }
  uint32_t now = millis();
  if (downSince == 0) downSince = now;
  if (now - downSince > WIFI_RETRY_MS) {
    Serial.println("[wifi] still down, retrying");
    WiFi.disconnect();
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    downSince = now;
  }
}

inline bool endsWith(const String &s, const char *suffix) {
  size_t n = strlen(suffix);
  return s.length() >= n && s.substring(s.length() - n) == suffix;
}

// Returns the host to dial: an IP string as-is, or a ".local" name resolved via mDNS.
inline String resolveBridgeHost(const char *mdnsName) {
  String host = BRIDGE_HOST;
  if (!endsWith(host, ".local")) return host;
  static bool mdnsStarted = false;
  if (!mdnsStarted) mdnsStarted = MDNS.begin(mdnsName);
  String bare = host.substring(0, host.length() - 6);
  IPAddress ip = MDNS.queryHost(bare.c_str(), 2000);
  if (ip == IPAddress(0, 0, 0, 0)) {
    Serial.printf("[bridge] mDNS could not resolve %s\n", host.c_str());
    return String();
  }
  Serial.printf("[bridge] %s -> %s\n", host.c_str(), ip.toString().c_str());
  return ip.toString();
}

inline String bridgePath(const char *role) {
  String p = String("/") + role;
  String token = BRIDGE_DEVICE_TOKEN;
  if (token.length() > 0) p += "?token=" + token;
  return p;
}

// Keeps one WebSocket to the bridge alive across Wi-Fi drops and (for .local hosts) IP changes.
class BridgeLink {
 public:
  BridgeLink(WebSocketsClient &ws, const char *role, const char *mdnsName)
      : ws_(ws), role_(role), mdnsName_(mdnsName) {}

  void loop() {
    bool wifiUp = WiFi.status() == WL_CONNECTED;
    if (!wifiUp) {
      if (started_) {
        ws_.disconnect();
        started_ = false;
      }
      return;
    }
    uint32_t now = millis();
    if (!started_ || (!connected_ && now - offlineSince_ > BRIDGE_RERESOLVE_MS &&
                      endsWith(String(BRIDGE_HOST), ".local"))) {
      if (now - lastAttempt_ < 2000 && lastAttempt_ != 0) return;
      lastAttempt_ = now;
      String host = resolveBridgeHost(mdnsName_);
      if (host.length() == 0) return;
      if (started_) ws_.disconnect();
      Serial.printf("[bridge] dialing ws://%s:%d/%s\n", host.c_str(), BRIDGE_PORT, role_);
      ws_.begin(host, BRIDGE_PORT, bridgePath(role_));
      ws_.setReconnectInterval(2000);
      ws_.enableHeartbeat(5000, 3000, 2);
      started_ = true;
      offlineSince_ = now;
    }
    ws_.loop();
  }

  void setConnected(bool c) {
    connected_ = c;
    if (!c) offlineSince_ = millis();
  }
  bool connected() const { return connected_; }

 private:
  WebSocketsClient &ws_;
  const char *role_;
  const char *mdnsName_;
  bool started_ = false;
  bool connected_ = false;
  uint32_t offlineSince_ = 0;
  uint32_t lastAttempt_ = 0;
};

}  // namespace cpaynet
