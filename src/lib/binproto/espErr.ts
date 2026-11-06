/**
 * ESP-IDF `esp_err_t` → ad (`esp_err_to_name` karşılığı). OTA hata mesajında
 * (`OTA_MESSAGE` = ERROR) `ota.last_message`'a yazılır, örn. 0x7002 →
 * "ESP_ERR_HTTP_CONNECT".
 *
 * Firmware ekibinin `esp_err_names.py` tablosunun alt kümesi: OTA sırasında
 * görülebilecek genel, OTA, HTTP istemcisi, ESP-TLS ve HTTPS OTA hataları.
 * Tablo gelirse buradan tamamlanır. Bilinmeyen kod ESP-IDF'teki gibi
 * "UNKNOWN ERROR" olur; teşhis için yanına hex kod eklenir.
 */
const ESP_ERR_NAMES: Readonly<Record<number, string>> = {
  0: "ESP_OK",
  [-1]: "ESP_FAIL",
  0x101: "ESP_ERR_NO_MEM",
  0x102: "ESP_ERR_INVALID_ARG",
  0x103: "ESP_ERR_INVALID_STATE",
  0x104: "ESP_ERR_INVALID_SIZE",
  0x105: "ESP_ERR_NOT_FOUND",
  0x106: "ESP_ERR_NOT_SUPPORTED",
  0x107: "ESP_ERR_TIMEOUT",
  0x108: "ESP_ERR_INVALID_RESPONSE",
  0x109: "ESP_ERR_INVALID_CRC",
  0x10a: "ESP_ERR_INVALID_VERSION",
  0x10b: "ESP_ERR_INVALID_MAC",
  0x10c: "ESP_ERR_NOT_FINISHED",
  0x10d: "ESP_ERR_NOT_ALLOWED",
  // OTA (esp_ota_ops.h)
  0x1501: "ESP_ERR_OTA_PARTITION_CONFLICT",
  0x1502: "ESP_ERR_OTA_SELECT_INFO_INVALID",
  0x1503: "ESP_ERR_OTA_VALIDATE_FAILED",
  0x1504: "ESP_ERR_OTA_SMALL_SEC_VER",
  0x1505: "ESP_ERR_OTA_ROLLBACK_FAILED",
  0x1506: "ESP_ERR_OTA_ROLLBACK_INVALID_STATE",
  // HTTP istemcisi (esp_http_client.h)
  0x7001: "ESP_ERR_HTTP_MAX_REDIRECT",
  0x7002: "ESP_ERR_HTTP_CONNECT",
  0x7003: "ESP_ERR_HTTP_WRITE_DATA",
  0x7004: "ESP_ERR_HTTP_FETCH_HEADER",
  0x7005: "ESP_ERR_HTTP_INVALID_TRANSPORT",
  0x7006: "ESP_ERR_HTTP_CONNECTING",
  0x7007: "ESP_ERR_HTTP_EAGAIN",
  0x7008: "ESP_ERR_HTTP_CONNECTION_CLOSED",
  // ESP-TLS (esp_tls_errors.h)
  0x8001: "ESP_ERR_ESP_TLS_CANNOT_RESOLVE_HOSTNAME",
  0x8002: "ESP_ERR_ESP_TLS_CANNOT_CREATE_SOCKET",
  0x8003: "ESP_ERR_ESP_TLS_UNSUPPORTED_PROTOCOL_FAMILY",
  0x8004: "ESP_ERR_ESP_TLS_FAILED_CONNECT_TO_HOST",
  0x8005: "ESP_ERR_ESP_TLS_SOCKET_SETOPT_FAILED",
  0x8006: "ESP_ERR_ESP_TLS_CONNECTION_TIMEOUT",
  // HTTPS OTA (esp_https_ota.h)
  0x9001: "ESP_ERR_HTTPS_OTA_IN_PROGRESS",
};

export function espErrToName(code: number): string {
  const name = ESP_ERR_NAMES[code];
  if (name) return name;
  const hex = code < 0 ? `-0x${(-code).toString(16)}` : `0x${code.toString(16)}`;
  return `UNKNOWN ERROR (${hex.toUpperCase().replace("0X", "0x")})`;
}
