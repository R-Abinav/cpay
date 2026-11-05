#!/usr/bin/env python3
"""Provision a CPay glasses unit (ESP32-CAM running the `cam` firmware) over serial.

Generates a unit id `cpay-<8 hex>` and a random 32-byte unit secret, writes both into the board's NVS
with `PROVISION <unitId> <secretHex64>`, and waits for `OK PROVISIONED <unitId>`.

The secret is never printed, logged or saved on this computer: it lives only on the device. The hub
learns sha256(secret) once, when the unit first registers (TLS). Lost secret = provision again.

Run with PlatformIO's Python (has pyserial):
    ~/.platformio/penv/bin/python scripts/provision.py --port /dev/cu.usbserial-0001
or  pnpm --filter @cpay/glasses-kit provision --port /dev/cu.usbserial-0001
"""
import argparse
import secrets
import sys
import time

try:
    import serial  # pyserial
except ImportError:
    sys.exit("pyserial missing: run with ~/.platformio/penv/bin/python")


def open_port(port: str, baud: int) -> "serial.Serial":
    s = serial.Serial()
    s.port = port
    s.baudrate = baud
    s.timeout = 0.2
    # DevKit-as-USB-serial wiring: keep DTR/RTS released so opening the port doesn't reset the CAM
    # or hold it in download mode.
    s.dtr = False
    s.rts = False
    s.open()
    return s


def main() -> int:
    ap = argparse.ArgumentParser(description="Provision a CPay glasses unit over serial")
    ap.add_argument("--port", default="/dev/cu.usbserial-0001")
    ap.add_argument("--baud", type=int, default=115200)
    ap.add_argument("--timeout", type=float, default=10.0, help="seconds to wait for the OK")
    args = ap.parse_args()

    unit_id = "cpay-" + secrets.token_hex(4)
    secret = secrets.token_hex(32)

    try:
        s = open_port(args.port, args.baud)
    except serial.SerialException as e:
        print(f"cannot open {args.port}: {e}", file=sys.stderr)
        return 1

    with s:
        time.sleep(0.5)
        s.reset_input_buffer()
        s.write(f"PROVISION {unit_id} {secret}\n".encode("ascii"))
        s.flush()
        secret = None  # drop our only copy

        deadline = time.time() + args.timeout
        buf = b""
        while time.time() < deadline:
            buf += s.read(256)
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                text = line.decode("ascii", "replace").strip()
                if text == f"OK PROVISIONED {unit_id}":
                    print(f"provisioned unit {unit_id} (the board reboots now)")
                    return 0
                if text.startswith("ERR"):
                    print(f"device refused: {text}", file=sys.stderr)
                    return 1
    print(
        "no OK from the device. Is the `cam` firmware running (IO0 not grounded, RST pressed)"
        f" and is {args.port} the right port?",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
