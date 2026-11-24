#!/usr/bin/env python3
"""Boot a test-only PID 1 and verify Landlock execute denial in the pinned guest."""

import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time


def firecracker_request(socket_path: Path, method: str, path: str, body: dict) -> None:
    payload = json.dumps(body, separators=(",", ":")).encode()
    with socket.socket(socket.AF_UNIX) as connection:
        connection.settimeout(5)
        connection.connect(str(socket_path))
        connection.sendall(
            f"{method} {path} HTTP/1.1\r\nHost: localhost\r\n"
            f"Content-Type: application/json\r\nContent-Length: {len(payload)}\r\n"
            "Connection: close\r\n\r\n".encode()
            + payload
        )
        response = bytearray()
        while b"\r\n\r\n" not in response:
            chunk = connection.recv(65536)
            if not chunk:
                break
            response.extend(chunk)
    status = response.split(b"\r\n", 1)[0]
    if b" 204 " not in status and b" 200 " not in status:
        raise RuntimeError(f"Firecracker API {path}: {response.decode(errors='replace')}")


def main() -> int:
    if len(sys.argv) != 3:
        raise SystemExit("usage: probe-verified-kernel.py VMLINUX FIRECRACKER_BIN")
    kernel = Path(sys.argv[1]).resolve(strict=True)
    firecracker = Path(sys.argv[2]).resolve(strict=True)
    source = Path(__file__).with_name("probe-landlock.c")
    with tempfile.TemporaryDirectory(prefix="caisson-landlock-kvm-") as raw_work:
        work = Path(raw_work)
        root = work / "root"
        root.mkdir()
        subprocess.run(["gcc", "-static", "-O2", "-Wall", "-Wextra", str(source), "-o", str(root / "init")], check=True)
        shutil.copyfile(root / "init", root / "denied")
        os.chmod(root / "init", 0o755)
        os.chmod(root / "denied", 0o755)
        image = work / "probe.ext4"
        subprocess.run(["truncate", "-s", "64M", str(image)], check=True)
        subprocess.run(["mkfs.ext4", "-q", "-F", "-d", str(root), str(image)], check=True)

        api = work / "firecracker.sock"
        log = work / "serial.log"
        with log.open("wb") as output:
            process = subprocess.Popen([str(firecracker), "--api-sock", str(api)], stdout=output, stderr=subprocess.STDOUT)
            try:
                deadline = time.monotonic() + 10
                while not api.exists() and time.monotonic() < deadline:
                    if process.poll() is not None:
                        raise RuntimeError("Firecracker exited before its API socket became ready")
                    time.sleep(0.05)
                if not api.exists():
                    raise TimeoutError("Firecracker API socket did not appear")
                firecracker_request(api, "PUT", "/machine-config", {"vcpu_count": 1, "mem_size_mib": 128})
                firecracker_request(api, "PUT", "/boot-source", {
                    "kernel_image_path": str(kernel),
                    "boot_args": "console=ttyS0 reboot=k panic=1 pci=off root=/dev/vda rw init=/init",
                })
                firecracker_request(api, "PUT", "/drives/rootfs", {
                    "drive_id": "rootfs", "path_on_host": str(image),
                    "is_root_device": True, "is_read_only": False,
                })
                firecracker_request(api, "PUT", "/actions", {"action_type": "InstanceStart"})
                deadline = time.monotonic() + 25
                while time.monotonic() < deadline:
                    serial = log.read_text(errors="replace")
                    if "LANDLOCK_PROBE=PASS" in serial:
                        print("\n".join(line for line in serial.splitlines() if line.startswith("LANDLOCK_")))
                        return 0
                    if "LANDLOCK_PROBE=FAIL" in serial or "LANDLOCK_PROBE=UNAVAILABLE" in serial:
                        raise RuntimeError("guest Landlock probe failed:\n" + serial[-5000:])
                    if process.poll() is not None:
                        break
                    time.sleep(0.1)
                serial = log.read_text(errors="replace")
                diagnostics = "\n".join(line for line in serial.splitlines() if "LANDLOCK_" in line)
                raise TimeoutError(
                    "guest Landlock probe did not finish; diagnostics:\n"
                    + diagnostics
                    + "\nboot tail:\n"
                    + serial[-2500:]
                )
            finally:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()


if __name__ == "__main__":
    raise SystemExit(main())
