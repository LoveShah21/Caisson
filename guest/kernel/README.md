# Verified guest kernel preflight

`build-verified-6.1.167.sh` builds the exact vanilla kernel.org `v6.1.167`
release with the checked-in Firecracker v1.17.0 x86_64 6.1 guest config.
`deploy/runtime-versions.env` pins the tag object, peeled commit, release
archive SHA-256, signing-key fingerprint, and config SHA-256.

The build checks kernel.org's advertised tag object, verifies the same tag
object fetched from the Gitiles mirror linked by kernel.org, and verifies both
the release archive's SHA-256 and Greg Kroah-Hartman's detached signature over
the uncompressed tar. His key comes from kernel.org's Web Key Directory. The
fingerprint is cross-published by [kernel.org](https://www.kernel.org/signature.html)
and [LWN](https://lwn.net/Articles/698109/). A failure at any check stops the
build.

On Ubuntu 24.04 WSL2, install `build-essential`, `bc`, `bison`, `flex`,
`libelf-dev`, `libssl-dev`, and `dwarves` before running:

```sh
bash guest/kernel/build-verified-6.1.167.sh \
  /tmp/caisson-kernel-build /tmp/caisson-vmlinux-6.1.167
python3 guest/kernel/probe-verified-kernel.py \
  /tmp/caisson-vmlinux-6.1.167 /usr/local/bin/firecracker
```

The probe boots a test-only static PID 1 in a Firecracker guest. It checks the
Landlock ABI, allows execute on `/init` only, then proves `/init` executes and
`/denied` fails with `EACCES`. It prints `LANDLOCK_PROBE=PASS` only when both
conditions hold. The probe rootfs is temporary and is not a production base
snapshot.

`toolchain.lock.json` pins the exact Ubuntu 24.04 package version and package
archive SHA-256 for the compiler, binutils, make, parser generators, build
libraries, `bzip2` for the minimal text-tool source archive, and their detected runtime dependency closure (95 packages in this
pin). It also pins the SHA-256 of each installed package's files and 43 executable or compiler-internal
files. The build runs `check-toolchain.py` before source retrieval or compilation
and fails if any value differs. Ubuntu's signed apt package index supplies the
archive checksums. The lock records the WSL2 build's GCC 13.3.0, binutils 2.42,
GNU Make 4.3, Bison 3.8.2, Flex 2.6.4, pahole 1.25, and OpenSSL 3.0.13.
When a rolling Ubuntu index removes an older package revision, verification
may reuse only that revision's checked-in archive checksum; the installed
version, complete installed-file digest, and direct executable hashes must
still match the lock. Creating or updating the lock never uses this fallback
and requires a checksum from the signed apt index.
The packages are referenced by exact checksums rather than vendored, so a
future rebuild still depends on their availability from Ubuntu. A different
toolchain requires a reviewed lock update and new output-image measurement.

The published Firecracker config still contains an Amazon Linux header and
`CONFIG_BUILD_SALT` string. These are inherited config metadata, not the
kernel source or release identity; the build uses the verified vanilla
kernel.org source. The WSL2 build used for this probe produced a `vmlinux`
SHA-256 of `ae7ae29bfe62c946b79472f6125bfa7de9c0c3c4ccbe1bb643f42958f67631d5`.
An independent rebuild after adding the mandatory toolchain lock produced the
same SHA-256 and passed the KVM Landlock probe again.

Vanilla 6.1 does not include the Amazon Linux-only `CONFIG_SYSGENID` and
`CONFIG_PTP_1588_CLOCK_VMCLOCK` options from Firecracker's published config.
The Landlock probe alone does not validate snapshot restore or all M-3 runtime
behavior on this replacement kernel. Those checks remain required before
production adoption.
