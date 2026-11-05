// GC2145 camera: RGB565 QVGA capture, software JPEG. Frames live only in RAM and are freed right after use.
#pragma once
#include <Arduino.h>

namespace camera {

bool begin();  // false -> CAMERA ERROR (logged); the rest of the firmware keeps running
bool ready();

// Grabs the newest frame, encodes it as JPEG and hands it to `send`. The JPEG buffer and the frame
// buffer are always released before returning. Returns the JPEG size, or 0 on failure.
size_t captureJpeg(bool (*send)(uint8_t *jpg, size_t len));

}  // namespace camera
