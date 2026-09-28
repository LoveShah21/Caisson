ARG GO_VERSION=1.24.8
FROM golang:${GO_VERSION}-alpine3.22 AS build

ARG MINIO_COMMIT

RUN apk add --no-cache ca-certificates git
RUN git init /src \
    && git -C /src remote add origin https://github.com/minio/minio.git \
    && git -C /src fetch --depth=1 origin "${MINIO_COMMIT}" \
    && git -C /src checkout --detach FETCH_HEAD \
    && test "$(git -C /src rev-parse HEAD)" = "${MINIO_COMMIT}"

WORKDIR /src
# -mod=readonly rejects a go.mod/go.sum update. Go verifies downloaded module
# content against the hashes pinned in the checked-out go.sum.
RUN CGO_ENABLED=0 go build -mod=readonly -trimpath -buildvcs=false -o /out/minio .

FROM alpine:3.22

RUN addgroup -S minio && adduser -S -G minio minio && mkdir /data && chown minio:minio /data
COPY --from=build /out/minio /usr/local/bin/minio

USER minio:minio
ENTRYPOINT ["/usr/local/bin/minio"]
