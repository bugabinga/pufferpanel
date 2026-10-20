###
# Builder container
###
FROM --platform=$BUILDPLATFORM docker.io/library/node:26.10.0-alpine AS node

WORKDIR /build
COPY client .

RUN rm -rf /build/*/node_modules/ && \
    rm -rf /build/*/dist/

RUN npm install --global --allow-scripts=yarn yarn@1.22.22 && \
    yarn install --frozen-lockfile && \
    yarn test && \
    yarn lint && \
    yarn build

FROM --platform=$BUILDPLATFORM docker.io/tonistiigi/xx:1.10.0 AS xx

FROM --platform=$BUILDPLATFORM docker.io/library/golang:1.27.3-alpine AS builder

ARG TARGETPLATFORM
ARG BUILDPLATFORM

RUN apk add clang lld bash
COPY --from=xx / /

ARG tags
ARG version=devel
ARG sha=devel
ENV CGO_ENABLED=1
ENV CGO_CFLAGS="-D_LARGEFILE64_SOURCE"

RUN mkdir /pufferpanel

WORKDIR /build/pufferpanel

COPY go.mod go.sum ./
RUN xx-go mod download && xx-go mod verify

COPY . .

RUN CGO_ENABLED=0 go tool swag init --pd --md . -o web/swagger -g web/loader.go

COPY --from=node /build/frontend/dist /build/pufferpanel/client/frontend/dist

ARG curseforgeKey=''

RUN xx-apk add musl-dev gcc
RUN xx-go build -buildvcs=false -tags "$tags" -ldflags "-X 'github.com/pufferpanel/pufferpanel/v3/config.curseforgeKey=$curseforgeKey' -X 'github.com/pufferpanel/pufferpanel/v3.Hash=$sha' -X 'github.com/pufferpanel/pufferpanel/v3.Version=$version'" -o /pufferpanel/pufferpanel github.com/pufferpanel/pufferpanel/v3/cmd
RUN xx-verify /pufferpanel/pufferpanel

# Lifecycle tests download glibc-based game runtimes.
FROM --platform=$BUILDPLATFORM docker.io/library/golang:1.27.3 AS tests

ARG TARGETPLATFORM
ARG BUILDPLATFORM

WORKDIR /build/pufferpanel
COPY --from=builder /go/pkg/mod /go/pkg/mod
COPY --from=builder /build/pufferpanel .
COPY --from=builder /pufferpanel /pufferpanel
RUN if [ "$BUILDPLATFORM" = "$TARGETPLATFORM" ]; then go test ./...; fi

###
# Generate final image
###

FROM docker.io/library/alpine:3.23

EXPOSE 8080 5657
RUN mkdir -p /etc/pufferpanel && \
    mkdir -p /var/lib/pufferpanel /var/lib/pufferpanel/servers /var/lib/pufferpanel/binaries /var/lib/pufferpanel/cache && \
    mkdir -p /var/log/pufferpanel

ENV GIN_MODE=release \
    PUFFER_PLATFORM="docker" \
    PUFFER_DOCKER_ROOT="" \
    PUFFER_DOCKER_DISALLOWHOST=true

COPY --from=tests --chmod=755 /pufferpanel /pufferpanel/bin
COPY --from=builder --chmod=755 /build/pufferpanel/entrypoint.sh /pufferpanel/bin/entrypoint.sh
COPY --from=builder --chmod=755 /build/pufferpanel/config.docker.json /etc/pufferpanel/config.json

VOLUME /etc/pufferpanel
VOLUME /var/lib/pufferpanel
VOLUME /var/log/pufferpanel

WORKDIR /var/lib/pufferpanel

ENTRYPOINT ["sh", "/pufferpanel/bin/entrypoint.sh"]