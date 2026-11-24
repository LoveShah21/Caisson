#!/usr/bin/env python3
"""Check the exact Ubuntu toolchain used for the pinned guest-kernel build."""

import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys


COMMANDS = (
    "bash", "git", "gpg", "curl", "tar", "xz", "sha256sum", "awk", "grep",
    "sed", "cp", "mkdir", "chmod", "install", "make", "gcc", "g++", "as",
    "ld", "ar", "nm", "objcopy", "objdump", "readelf", "strip", "ranlib",
    "size", "bison", "flex", "bc", "pahole", "openssl", "perl", "python3",
    "ldd", "dpkg-query", "apt-cache",
)
DEVELOPMENT_PACKAGES = (
    "libc6-dev", "linux-libc-dev", "libssl-dev", "libelf-dev", "zlib1g-dev",
)
GCC_INTERNALS = ("cc1", "collect2", "lto-wrapper", "libgcc.a", "liblto_plugin.so")
LOCK = Path(__file__).with_name("toolchain.lock.json")


def run(*args: str) -> str:
    return subprocess.check_output(args, text=True, stderr=subprocess.DEVNULL).strip()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def owner(path: Path) -> str:
    output = run("dpkg-query", "-S", str(path))
    return output.split(": ", 1)[0].split(",", 1)[0]


def archive_checksum(package: str, version: str) -> str:
    paragraphs = run("apt-cache", "show", package).split("\n\n")
    for paragraph in paragraphs:
        fields = dict(
            line.split(": ", 1)
            for line in paragraph.splitlines()
            if ": " in line and not line.startswith(" ")
        )
        if fields.get("Version") == version and re.fullmatch(r"[0-9a-f]{64}", fields.get("SHA256", "")):
            return fields["SHA256"]
    raise RuntimeError(f"no signed apt-index checksum for {package}={version}")


def package_file_digest(package: str) -> str:
    digest = hashlib.sha256()
    for name in sorted(run("dpkg-query", "-L", package).splitlines()):
        path = Path(name)
        if path.is_symlink():
            value = "link:" + os.readlink(path)
        elif path.is_file():
            value = "file:" + sha256(path)
        else:
            continue
        digest.update(f"{name}\0{value}\n".encode())
    return digest.hexdigest()


def record() -> dict:
    os_release = Path("/etc/os-release").read_text()
    if 'ID=ubuntu' not in os_release or 'VERSION_ID="24.04"' not in os_release:
        raise RuntimeError("kernel toolchain lock requires Ubuntu 24.04")
    paths: dict[str, Path] = {}
    for command in COMMANDS:
        found = shutil.which(command)
        if found is None:
            raise RuntimeError(f"missing pinned build tool: {command}")
        paths[command] = Path(found).resolve(strict=True)
    for internal in GCC_INTERNALS:
        flag = "-print-file-name" if internal.endswith((".a", ".so")) else "-print-prog-name"
        found = run("gcc", f"{flag}={internal}")
        path = Path(found).resolve(strict=True)
        if not path.is_file():
            raise RuntimeError(f"missing GCC internal: {internal}")
        paths[f"gcc:{internal}"] = path

    # The loader and shared libraries used by the compiler and build tools
    # are inputs too. Record their owning packages, not only the entrypoints.
    libraries: set[Path] = set()
    for path in set(paths.values()):
        try:
            output = run("ldd", str(path))
        except subprocess.CalledProcessError:
            continue  # Static binaries and archives have no dynamic closure.
        for match in re.findall(r"(?<!\S)/[^\s()]+", output):
            candidate = Path(match).resolve(strict=True)
            if candidate.is_file():
                libraries.add(candidate)

    packages = set(DEVELOPMENT_PACKAGES)
    for path in set(paths.values()) | libraries:
        packages.add(owner(path))
    package_records = {}
    for package in sorted(packages):
        version = run("dpkg-query", "-W", "-f=${Version}", package)
        package_records[package] = {
            "version": version,
            "archiveSha256": archive_checksum(package, version),
            "installedFilesSha256": package_file_digest(package),
        }
    return {
        "distribution": "Ubuntu 24.04 amd64",
        "commands": {name: {"path": str(path), "sha256": sha256(path)} for name, path in sorted(paths.items())},
        "packages": package_records,
    }


def main() -> None:
    observed = record()
    if len(sys.argv) == 2 and sys.argv[1] == "--record":
        LOCK.write_text(json.dumps(observed, indent=2, sort_keys=True) + "\n")
        print(f"recorded {len(observed['commands'])} build files and {len(observed['packages'])} signed-index package checksums")
        return
    if len(sys.argv) != 1:
        raise SystemExit("usage: check-toolchain.py [--record]")
    expected = json.loads(LOCK.read_text())
    if observed != expected:
        raise RuntimeError("kernel build toolchain differs from the checksum-pinned lock")
    print(f"PASS kernel toolchain: {len(observed['commands'])} build files, {len(observed['packages'])} packages")


if __name__ == "__main__":
    main()
