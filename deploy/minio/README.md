# Local MinIO image

`image.env` is the single image reference consumed by Compose, Testcontainers,
and the CI build step. The image is built from the exact MinIO source commit
listed there. It also includes the pinned `mc` source build used only by the
real integration fixture to create a restricted test IAM principal. The
running MinIO service does not invoke `mc`.

## Provenance

On 2026-09-29, the following unavailable upstream distribution paths were
checked from a clean anonymous client:

- Quay returned `401 unauthorized` for the previously pinned image.
- Docker Hub returned `pull access denied` for both the prior tag and the
  current `RELEASE.2025-10-15T17-29-55Z` tag.
- MinIO's release binary and signature download endpoints returned HTTP 410.

The official `https://github.com/minio/minio` repository identifies itself as
`minio/minio`; its release tag `RELEASE.2025-10-15T17-29-55Z` resolves to
`9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a`. The tag is reachable from the
official repository and the release page names that commit. Its commit is an
ancestor of the repository's `master` branch at verification time. The tag is
lightweight, so it has no detached tag signature to verify. This establishes
repository and commit consistency, not a cryptographic release signature.

The release is archived and the project no longer makes a downloadable binary
available, so a release-binary checksum cannot be verified. The image instead
checks out the exact recorded source commit and compares `HEAD` to it during
the build. The Dockerfile pins Go 1.24.8, matching the release's documented
toolchain update. `go build -mod=readonly` requires the checked-out `go.sum`;
downloaded module content is checked against those pinned hashes. This does
not independently pin the availability of the Go module proxy or the Alpine
base image.

The fixture's `mc` build follows the same process. Its source is pinned to
`7394ce0dd2a80935aded936b09fa12cbb3cb8096`, the official `minio/mc`
`RELEASE.2025-08-13T08-35-41Z` commit. It is built with the same pinned Go
version and `-mod=readonly` against the checked-out `go.sum`.

Build it directly when running an integration test outside CI:

```bash
docker compose --env-file deploy/minio/image.env -f deploy/docker-compose.yml build minio
```

This is a local development image. Production object storage uses platform
SSE-KMS and an independently reviewed image supply chain.
