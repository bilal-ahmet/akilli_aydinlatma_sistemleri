/*
 * Fener — Akıllı Sokak Aydınlatma · ESP32 firmware
 * ------------------------------------------------------------------
 * HiveMQ Cloud'a TLS (8883) ile bağlanır, zone + device komut
 * topic'lerine subscribe olur, gelen on/off/dim komutunu bir LED'e
 * (PWM ile dim) uygular ve durumunu status topic'ine publish eder.
 *
 * Kütüphaneler (Arduino IDE → Library Manager):
 *   - PubSubClient  (Nick O'Leary)
 *   - ArduinoJson   (Benoit Blanchon, v7)
 *   WiFiClientSecure ESP32 core ile gelir.
 *
 * Kart: herhangi bir ESP32 (esp32 by Espressif, core 3.x önerilir).
 * WiFi + MQTT bilgileri için secrets.h dosyasını oluştur (secrets.example.h'tan kopyala).
 */

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include "secrets.h"

// ── Cihaz kimliği (backend'deki devices tablosuyla eşleşmeli) ──────
// Seed'deki örnek: zone "ataturk-bulvari", cihaz "ataturk-bulvari-001"
#define DEVICE_ID "ataturk-bulvari-001"
#define ZONE_ID   "ataturk-bulvari"

// ── Donanım ───────────────────────────────────────────────────────
#define LED_PIN        2     // çoğu ESP32 kartında dahili LED GPIO2
#define PWM_FREQ       5000  // Hz
#define PWM_RES_BITS   8     // 8-bit → duty 0..255

// ── MQTT topic'leri ───────────────────────────────────────────────
static const char* TOPIC_ZONE_CMD   = "city/lighting/zone/" ZONE_ID "/command";
static const char* TOPIC_DEVICE_CMD  = "city/lighting/device/" DEVICE_ID "/command";
static const char* TOPIC_STATUS      = "city/lighting/device/" DEVICE_ID "/status";

WiFiClientSecure net;
PubSubClient mqtt(net);

// Cihazın güncel durumu
bool    isOn       = false;
uint8_t brightness = 0;   // 0..100

unsigned long lastHeartbeat = 0;
const unsigned long HEARTBEAT_MS = 30000; // 30 sn'de bir "hayattayım" status'u

// ──────────────────────────────────────────────────────────────────
void applyOutput() {
  // Kapalıysa 0, açıksa brightness'a göre PWM duty.
  int duty = 0;
  if (isOn) {
    duty = map(brightness, 0, 100, 0, (1 << PWM_RES_BITS) - 1);
  }
  ledcWrite(LED_PIN, duty); // ESP32 core 3.x: pin üzerinden yazılır
}

void publishStatus(const char* action, const char* status) {
  JsonDocument doc;
  doc["deviceId"] = DEVICE_ID;
  doc["zoneId"]   = ZONE_ID;
  doc["action"]   = action;
  doc["value"]    = isOn ? brightness : 0;
  doc["status"]   = status;       // "ok" | "error"
  doc["rssi"]     = WiFi.RSSI();

  char buf[256];
  size_t n = serializeJson(doc, buf, sizeof(buf));
  mqtt.publish(TOPIC_STATUS, (const uint8_t*)buf, n, false); // QoS 0
  Serial.printf("[status] %s\n", buf);
}

void handleCommand(byte* payload, unsigned int length) {
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, payload, length);
  if (err) {
    Serial.printf("[cmd] JSON hatasi: %s\n", err.c_str());
    publishStatus("dim", "error");
    return;
  }

  const char* action = doc["action"] | "";
  int value = doc["value"] | -1; // dim için 0..100, yoksa -1

  if (strcmp(action, "on") == 0) {
    isOn = true;
    if (brightness == 0) brightness = 100; // kapalıyken açılırsa tam güç
  } else if (strcmp(action, "off") == 0) {
    isOn = false;                          // brightness korunur
  } else if (strcmp(action, "dim") == 0) {
    if (value >= 0 && value <= 100) {
      brightness = value;
      isOn = true;
    }
  } else {
    Serial.printf("[cmd] bilinmeyen action: %s\n", action);
    publishStatus("dim", "error");
    return;
  }

  applyOutput();
  Serial.printf("[cmd] action=%s value=%d → isOn=%d brightness=%d\n",
                action, value, isOn, brightness);
  publishStatus(action, "ok"); // backend bunu alınca komutu "delivered" yapar
}

void onMessage(char* topic, byte* payload, unsigned int length) {
  Serial.printf("[mqtt] msg <- %s\n", topic);
  handleCommand(payload, length);
}

// ──────────────────────────────────────────────────────────────────
void connectWiFi() {
  Serial.printf("[wifi] %s baglaniliyor", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) {
    delay(400);
    Serial.print(".");
  }
  Serial.printf("\n[wifi] OK, IP: %s\n", WiFi.localIP().toString().c_str());
}

void connectMQTT() {
  while (!mqtt.connected()) {
    Serial.print("[mqtt] HiveMQ baglaniliyor... ");
    // clientId benzersiz olmali (HiveMQ Cloud şartı) → DEVICE_ID
    if (mqtt.connect(DEVICE_ID, MQTT_USER, MQTT_PASS)) {
      Serial.println("OK");
      mqtt.subscribe(TOPIC_ZONE_CMD, 1);   // QoS 1
      mqtt.subscribe(TOPIC_DEVICE_CMD, 1);
      Serial.printf("[mqtt] subscribe: %s , %s\n", TOPIC_ZONE_CMD, TOPIC_DEVICE_CMD);
      publishStatus("on", "ok"); // bağlanınca ilk durum
    } else {
      Serial.printf("hata rc=%d, 3sn sonra tekrar\n", mqtt.state());
      delay(3000);
    }
  }
}

void setup() {
  Serial.begin(115200);
  delay(200);

  // PWM çıkışı (ESP32 core 3.x API)
  ledcAttach(LED_PIN, PWM_FREQ, PWM_RES_BITS);
  applyOutput();

  connectWiFi();

  // TLS: hızlı saha testi için sertifika doğrulamasını atla.
  // ÜRETİM İÇİN: net.setCACert(HIVEMQ_ROOT_CA) kullan (bkz. README).
  net.setInsecure();

  mqtt.setServer(MQTT_HOST, MQTT_PORT); // 8883
  mqtt.setBufferSize(512);              // komut payload'ı 256'yı aşabilir
  mqtt.setCallback(onMessage);
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) connectWiFi();
  if (!mqtt.connected()) connectMQTT();
  mqtt.loop();

  // Periyodik heartbeat → dashboard'da last_seen güncel kalsın
  if (millis() - lastHeartbeat > HEARTBEAT_MS) {
    lastHeartbeat = millis();
    publishStatus(isOn ? "dim" : "off", "ok");
  }
}
