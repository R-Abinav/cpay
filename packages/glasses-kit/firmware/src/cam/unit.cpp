#include "unit.h"

#include <Preferences.h>
#include <mbedtls/md.h>

#include "config.h"

namespace unit {

static const char *NVS_NS = "cpay";
static const char *AUTH_PREFIX = "cpay/v1/device-auth:";  // = DEVICE_AUTH_PREFIX in hub/src/messages.ts

static char unitId[41] = {0};
static char secret[65] = {0};  // lower-case hex, 32 bytes
static char ap[32] = {0};
static bool ok = false;

bool validUnitId(const char *s) {  // ^[a-z0-9-]{4,40}$
  size_t n = strlen(s);
  if (n < 4 || n > 40) return false;
  for (size_t i = 0; i < n; i++) {
    char c = s[i];
    if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-')) return false;
  }
  return true;
}

bool validHex64(const char *s) {  // ^[0-9a-f]{64}$
  if (strlen(s) != 64) return false;
  for (int i = 0; i < 64; i++) {
    char c = s[i];
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
  }
  return true;
}

static void buildApName() {
  size_t n = strlen(unitId);
  const char *tail = n >= 4 ? unitId + n - 4 : unitId;
  snprintf(ap, sizeof ap, "CPay-Glasses-");
  size_t k = strlen(ap);
  for (const char *p = tail; *p && k < sizeof ap - 1; p++) ap[k++] = toupper((unsigned char)*p);
  ap[k] = 0;
}

bool load() {
  Preferences p;
  if (!p.begin(NVS_NS, true)) {  // namespace doesn't exist yet
    ok = false;
    return false;
  }
  String id = p.getString("unit_id", "");
  String sec = p.getString("unit_secret", "");
  p.end();
  ok = validUnitId(id.c_str()) && validHex64(sec.c_str());
  if (ok) {
    strlcpy(unitId, id.c_str(), sizeof unitId);
    strlcpy(secret, sec.c_str(), sizeof secret);
    buildApName();
  }
  // wipe the String copies of the secret
  for (size_t i = 0; i < sec.length(); i++) sec[i] = 0;
  return ok;
}

bool provisioned() { return ok; }
const char *id() { return unitId; }
const char *apName() { return ap; }
const char *secretHex() { return secret; }

static int hexVal(char c) { return c <= '9' ? c - '0' : c - 'a' + 10; }

static void toHex(const uint8_t *b, size_t n, char *out) {
  static const char *H = "0123456789abcdef";
  for (size_t i = 0; i < n; i++) {
    out[2 * i] = H[b[i] >> 4];
    out[2 * i + 1] = H[b[i] & 15];
  }
  out[2 * n] = 0;
}

// ---- THE ONE PLACE that defines the device-auth HMAC key. Change here if the hub changes.
// key = sha256(unit_secret_bytes), 32 raw bytes. The hub stores only sha256(unit_secret), so it can
// recompute the MAC without ever holding the secret itself.
static bool deriveMacKey(uint8_t key[32]) {
  uint8_t raw[32];
  for (int i = 0; i < 32; i++) raw[i] = (hexVal(secret[2 * i]) << 4) | hexVal(secret[2 * i + 1]);
  int rc = mbedtls_md(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), raw, sizeof raw, key);
  memset(raw, 0, sizeof raw);
  return rc == 0;
}

// mac = hex(HMAC-SHA256(key = deriveMacKey(), msg = "cpay/v1/device-auth:" + nonceHex))
bool authMac(const char *nonceHex, char out[65]) {
  if (!ok || !validHex64(nonceHex)) return false;
  uint8_t key[32], mac[32];
  if (!deriveMacKey(key)) return false;
  const mbedtls_md_info_t *md = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  mbedtls_md_context_t ctx;
  mbedtls_md_init(&ctx);
  bool good = mbedtls_md_setup(&ctx, md, 1) == 0 && mbedtls_md_hmac_starts(&ctx, key, sizeof key) == 0 &&
              mbedtls_md_hmac_update(&ctx, (const uint8_t *)AUTH_PREFIX, strlen(AUTH_PREFIX)) == 0 &&
              mbedtls_md_hmac_update(&ctx, (const uint8_t *)nonceHex, strlen(nonceHex)) == 0 &&
              mbedtls_md_hmac_finish(&ctx, mac) == 0;
  mbedtls_md_free(&ctx);
  memset(key, 0, sizeof key);
  if (good) toHex(mac, sizeof mac, out);
  return good;
}

// ---------------------------------------------------------------- serial console

static void handleLine(char *line, void (*onWifiReset)()) {
  char *cmd = strtok(line, " \t");
  if (!cmd) return;
  if (strcmp(cmd, "PROVISION") == 0) {
    char *id = strtok(nullptr, " \t");
    char *sec = strtok(nullptr, " \t");
    if (!id || !sec || !validUnitId(id) || !validHex64(sec)) {
      Serial.println("ERR PROVISION usage: PROVISION <unitId [a-z0-9-]{4,40}> <secret 64 lower-case hex>");
      if (sec) memset(sec, 0, strlen(sec));
      return;
    }
    Preferences p;
    bool stored = p.begin(NVS_NS, false) && p.putString("unit_id", id) > 0 && p.putString("unit_secret", sec) > 0;
    p.end();
    memset(sec, 0, strlen(sec));
    if (!stored) {
      Serial.println("ERR PROVISION nvs write failed");
      return;
    }
    Serial.printf("OK PROVISIONED %s\n", id);
    Serial.flush();
    delay(300);
    ESP.restart();
  } else if (strcmp(cmd, "WIFIRESET") == 0) {
    if (onWifiReset) onWifiReset();
    Serial.println("OK WIFIRESET");
    Serial.flush();
    delay(300);
    ESP.restart();
  } else if (strcmp(cmd, "INFO") == 0) {
    Serial.printf("INFO unit=%s fw=%s provisioned=%s hub=%s:%d%s\n", ok ? unitId : "-", CPAY_FW_VERSION,
                  ok ? "yes" : "no", HUB_HOST, HUB_PORT, HUB_PATH);
  } else {
    Serial.println("ERR unknown command (PROVISION, WIFIRESET, INFO)");
  }
}

void pollSerial(void (*onWifiReset)()) {
  static char buf[160];
  static size_t len = 0;
  static bool overflow = false;
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\r') continue;
    if (c == '\n') {
      buf[len] = 0;
      if (!overflow) handleLine(buf, onWifiReset);
      else Serial.println("ERR line too long");
      memset(buf, 0, sizeof buf);  // the line may have held a secret
      len = 0;
      overflow = false;
    } else if (len < sizeof buf - 1) {
      buf[len++] = c;
    } else {
      overflow = true;
    }
  }
}

}  // namespace unit
