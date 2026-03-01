#include <Arduino_Modulino.h>
#include <Arduino_RouterBridge.h>
#include <stdio.h>

ModulinoMovement movement;

constexpr uint32_t SAMPLE_INTERVAL_US = 33333;  // 30 Hz
constexpr float ACC_SCALE = 1000.0f;            // g -> milli-g
constexpr float GYRO_SCALE = 10.0f;             // dps -> deci-dps
constexpr uint8_t PIEZO_PIN_A = 2;
constexpr uint32_t PIEZO_DEBOUNCE_US = 10000;

// Very aggressive batching to amortize per-RPC overhead on the host/router path.
constexpr uint8_t BATCH_SAMPLES = 40;
constexpr uint32_t BATCH_FLUSH_MS = 700;
constexpr size_t PAYLOAD_MAX = 4096;

volatile uint32_t lastTrigA = 0;
volatile uint32_t lastHitMicros = 0;
volatile bool hitPending = false;

struct ImuSample {
  int16_t ax;
  int16_t ay;
  int16_t az;
  int16_t gx;
  int16_t gy;
  int16_t gz;
  uint32_t seq;
  uint8_t hit;
};

ImuSample batch[BATCH_SAMPLES];
uint8_t batchCount = 0;
char payload[PAYLOAD_MAX];

void onPiezoHitA() {
  const uint32_t nowUs = micros();
  if ((uint32_t)(nowUs - lastTrigA) < PIEZO_DEBOUNCE_US) {
    return;
  }

  lastTrigA = nowUs;
  lastHitMicros = nowUs;
  hitPending = true;
}

bool flushBatch() {
  if (batchCount == 0) {
    return false;
  }

  size_t pos = 0;
  for (uint8_t i = 0; i < batchCount; i++) {
    int n = snprintf(payload + pos, PAYLOAD_MAX - pos, "%d,%d,%d,%d,%d,%d,%lu,%u",
                     batch[i].ax, batch[i].ay, batch[i].az,
                     batch[i].gx, batch[i].gy, batch[i].gz,
                     static_cast<unsigned long>(batch[i].seq),
                     static_cast<unsigned>(batch[i].hit));

    if (n <= 0 || static_cast<size_t>(n) >= (PAYLOAD_MAX - pos)) {
      batchCount = 0;
      return false;
    }

    pos += static_cast<size_t>(n);
    if (i + 1 < batchCount) {
      if (pos + 1 >= PAYLOAD_MAX) {
        batchCount = 0;
        return false;
      }
      payload[pos++] = ';';
    }
  }

  // Ensure C-string termination before notify.
  if (pos >= PAYLOAD_MAX) {
    batchCount = 0;
    return false;
  }
  payload[pos] = '\0';

  Bridge.notify("imu_batch", payload);
  batchCount = 0;
  return true;
}

void setup() {
  Serial.begin(115200);
  Bridge.begin();

  pinMode(PIEZO_PIN_A, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(PIEZO_PIN_A), onPiezoHitA, FALLING);

  Modulino.begin(Wire1);
  Wire1.setClock(400000);  // override Modulino default 100kHz

  while (!movement.begin()) {
    delay(1000);
  }
}

void loop() {
  static uint32_t nextSampleUs = 0;
  static uint32_t lastBatchFlushMs = 0;
  static uint32_t lastStatsMs = 0;

  static uint32_t sampleCount = 0;
  static uint32_t batchSentCount = 0;
  static uint32_t updateFailCount = 0;
  static uint32_t sampleSeq = 0;

  const uint32_t nowUs = micros();
  if (nextSampleUs == 0) {
    nextSampleUs = nowUs + SAMPLE_INTERVAL_US;
  }

  if ((int32_t)(nowUs - nextSampleUs) >= 0) {
    nextSampleUs += SAMPLE_INTERVAL_US;

    if (movement.update()) {
      ImuSample s;
      s.ax = static_cast<int16_t>(movement.getX() * ACC_SCALE);
      s.ay = static_cast<int16_t>(movement.getY() * ACC_SCALE);
      s.az = static_cast<int16_t>(movement.getZ() * ACC_SCALE);
      s.gx = static_cast<int16_t>(movement.getRoll() * GYRO_SCALE);
      s.gy = static_cast<int16_t>(movement.getPitch() * GYRO_SCALE);
      s.gz = static_cast<int16_t>(movement.getYaw() * GYRO_SCALE);
      s.seq = sampleSeq++;
      s.hit = 0;

      uint32_t hitTsUs = 0;
      noInterrupts();
      if (hitPending) {
        hitPending = false;
        hitTsUs = lastHitMicros;
        s.hit = 1;
      }
      interrupts();

      if (s.hit == 1) {
        Serial.print("HIT: ");
        Serial.println(hitTsUs / 1000000.0f, 3);
      }

      batch[batchCount++] = s;
      sampleCount++;

      if (batchCount >= BATCH_SAMPLES) {
        if (flushBatch()) {
          batchSentCount++;
          lastBatchFlushMs = millis();
        }
      }
    } else {
      updateFailCount++;
    }
  }

  const uint32_t nowMs = millis();
  if (batchCount > 0 && (nowMs - lastBatchFlushMs) >= BATCH_FLUSH_MS) {
    if (flushBatch()) {
      batchSentCount++;
      lastBatchFlushMs = nowMs;
    }
  }

  if ((nowMs - lastStatsMs) >= 1000) {
    Serial.print("stm samples/s=");
    Serial.print(sampleCount);
    Serial.print(" batches/s=");
    Serial.print(batchSentCount);
    Serial.print(" update_fail/s=");
    Serial.println(updateFailCount);

    sampleCount = 0;
    batchSentCount = 0;
    updateFailCount = 0;
    lastStatsMs = nowMs;
  }
}
