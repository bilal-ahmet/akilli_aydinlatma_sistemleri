/*
 * Fener — Akıllı Sokak Aydınlatma · ESP32 firmware (MAC tabanlı, Meven şeması)
 * ------------------------------------------------------------------
 * Cihaz açılışta kendi MAC'ini okur (iki noktasız), HiveMQ Cloud'a TLS (8883)
 * ile bağlanır ve şu topic'leri kullanır:
 *   subscribe: Meven:<MAC>/cmd , Meven:<ZONE_SLUG>/cmd , Meven:all/cmd
 *   publish  : Meven:<MAC>/data
 *
 * ZONE_SLUG secrets.h'ten gelir ve dashboard'daki zone slug'ı ile birebir aynı
 * olmalıdır. Backend bölge komutunu tek publish ile bu topic'e atar.
 *
 * Komut payload : { "action": "on|off|dim", "value": 0-100 }
 * Veri payload  : { deviceId, brightness, relayStatus, temperature, rssi, status }
 *
 * Kütüphaneler: PubSubClient, ArduinoJson (v7). WiFiClientSecure ESP32 core'da.
 * WiFi + MQTT bilgileri için secrets.h (secrets.example.h'tan kopyala).
 */

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include "secrets.h"

// ── Donanım ───────────────────────────────────────────────────────
#define LED_PIN        2     // dahili LED
#define PWM_FREQ       5000
#define PWM_RES_BITS   8     // duty 0..255

WiFiClientSecure net;
PubSubClient mqtt(net);

String DEVICE_MAC;     // "A842E3123456"
String T_CMD;          // Meven:<MAC>/cmd
String T_ZONE;         // Meven:<ZONE_SLUG>/cmd
String T_ALL = "Meven:all/cmd";
String T_DATA;         // Meven:<MAC>/data

bool    isOn       = false;
uint8_t brightness = 0;

unsigned long lastHeartbeat = 0;
const unsigned long HEARTBEAT_MS = 30000;

// ──────────────────────────────────────────────────────────────────
String readMac() {
  String m = WiFi.macAddress(); // "A8:42:E3:12:34:56"
  m.replace(":", "");
  m.toUpperCase();
  return m;
}

int readTemperature() {
  // Gerçek sensör yoksa örnek değer. Buraya DS18B20/NTC okuması eklenebilir.
  return 40;
}

void applyOutput() {
  int duty = isOn ? map(brightness, 0, 100, 0, (1 << PWM_RES_BITS) - 1) : 0;
  ledcWrite(LED_PIN, duty);
}

void publishData(const char* status) {
  JsonDocument doc;
  doc["deviceId"]    = DEVICE_MAC;
  doc["brightness"]  = isOn ? brightness : 0;
  doc["relayStatus"] = isOn ? "on" : "off";
  doc["temperature"] = readTemperature();
  doc["rssi"]        = WiFi.RSSI();
  doc["status"]      = status; // "ok" | "error"

  char buf[256];
  size_t n = serializeJson(doc, buf, sizeof(buf));
  mqtt.publish(T_DATA.c_str(), (const uint8_t*)buf, n, false); // QoS 0
  Serial.printf("[data] %s\n", buf);
}

void handleCommand(byte* payload, unsigned int length) {
  JsonDocument doc;
  if (deserializeJson(doc, payload, length)) {
    publishData("error");
    return;
  }
  const char* action = doc["action"] | "";
  int value = doc["value"] | -1;

  if (strcmp(action, "on") == 0) {
    isOn = true;
    if (brightness == 0) brightness = 100;
  } else if (strcmp(action, "off") == 0) {
    isOn = false;
  } else if (strcmp(action, "dim") == 0) {
    if (value >= 0 && value <= 100) { brightness = value; isOn = true; }
  } else {
    publishData("error");
    return;
  }

  applyOutput();
  Serial.printf("[cmd] action=%s value=%d -> isOn=%d brightness=%d\n", action, value, isOn, brightness);
  publishData("ok");
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
  while (WiFi.status() != WL_CONNECTED) { delay(400); Serial.print("."); }
  Serial.printf("\n[wifi] OK, IP: %s\n", WiFi.localIP().toString().c_str());
}

void connectMQTT() {
  while (!mqtt.connected()) {
    Serial.print("[mqtt] HiveMQ baglaniliyor... ");
    if (mqtt.connect(DEVICE_MAC.c_str(), MQTT_USER, MQTT_PASS)) {
      Serial.println("OK");
      mqtt.subscribe(T_CMD.c_str(), 1);
      mqtt.subscribe(T_ZONE.c_str(), 1);
      mqtt.subscribe(T_ALL.c_str(), 1);
      Serial.printf("[mqtt] subscribe: %s , %s , %s\n",
                    T_CMD.c_str(), T_ZONE.c_str(), T_ALL.c_str());
      publishData("ok");
    } else {
      Serial.printf("hata rc=%d, 3sn sonra tekrar\n", mqtt.state());
      delay(3000);
    }
  }
}

void setup() {
  Serial.begin(115200);
  delay(200);

  ledcAttach(LED_PIN, PWM_FREQ, PWM_RES_BITS);
  applyOutput();

  connectWiFi();

  DEVICE_MAC = readMac();
  T_CMD  = "Meven:" + DEVICE_MAC + "/cmd";
  T_ZONE = "Meven:" + String(ZONE_SLUG) + "/cmd";
  T_DATA = "Meven:" + DEVICE_MAC + "/data";
  Serial.printf("[id] MAC: %s , bolge: %s\n", DEVICE_MAC.c_str(), ZONE_SLUG);

  // TLS: hızlı test için doğrulama atla. Üretimde net.setCACert(...) kullan.
  net.setInsecure();

  mqtt.setServer(MQTT_HOST, MQTT_PORT); // 8883
  mqtt.setBufferSize(512);
  mqtt.setCallback(onMessage);
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) connectWiFi();
  if (!mqtt.connected()) connectMQTT();
  mqtt.loop();

  if (millis() - lastHeartbeat > HEARTBEAT_MS) {
    lastHeartbeat = millis();
    publishData("ok");
  }
}
