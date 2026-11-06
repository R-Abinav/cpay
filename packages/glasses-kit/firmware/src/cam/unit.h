// Unit identity: unit_id + unit_secret in NVS (Preferences namespace "cpay"), written once by
// scripts/provision.py over serial. The secret never leaves the device except in the one-time
// hub `register` reply (TLS), and is never printed.
#pragma once
#include <Arduino.h>

namespace unit {

// Loads from NVS. False if the unit was never provisioned (or the stored values are invalid).
bool load();
bool provisioned();
const char *id();
// "CPay-Glasses-XXXX" (last 4 chars of the unit id, upper case).
const char *apName();
// Lower-case hex of the 32-byte secret, only for the hub `register` message.
const char *secretHex();

// Device-auth MAC for the hub challenge: lower-case hex HMAC-SHA256 (64 chars + NUL into out).
bool authMac(const char *nonceHex, char out[65]);

// Hub endpoint. Default from build flags (HUB_HOST/HUB_PORT/HUB_TLS/HUB_PATH, i.e. the Render hub);
// overridable without reflashing: serial `HUB ws://<ip>:8790/device` (saved in NVS), `HUB DEFAULT` to clear.
struct HubEndpoint {
  bool tls;
  char host[64];
  uint16_t port;
  char path[32];
};
const HubEndpoint &hub();

// Non-blocking serial console. Commands (one per line, 115200):
//   PROVISION <unitId> <secretHex64>  -> "OK PROVISIONED <unitId>", then reboot
//   WIFIRESET                         -> "OK WIFIRESET", clears saved Wi-Fi, reboot
//   INFO                              -> unit id + fw version (never the secret)
// `onWifiReset` is called before the reboot for WIFIRESET.
void pollSerial(void (*onWifiReset)());

bool validUnitId(const char *s);
bool validHex64(const char *s);

}  // namespace unit
