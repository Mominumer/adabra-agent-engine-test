# The overnight runner's session and tunnel image. Built by the operator, from a reviewed checkout, and used by digest:
#
#   docker build -t adabra-night:dev night/image
#   docker image inspect adabra-night:dev --format '{{.Id}}'
#
# Building needs the network. Running does not: nothing here is fetched at run time, and nothing in the image can be changed by a
# session. The base image is the digest of node:26-slim. The CLI is one exact release, checked against the published signed manifest:
# signing key fingerprint -> signature on the manifest -> checksum in the manifest -> the binary. The two checksums below are also
# pinned here, so a re-published release fails the build. Moving to a new release means changing all three values together.
#
# git and gnupg come from Debian's signed repositories at build time, at whatever version is current, so the built image's digest is
# what pins them.
FROM node@sha256:e4db4c914bf8ad241bd24804fc25d272d89bad97e68cdc8a1414862790a02c39 AS fetch
ARG CLAUDE_VERSION=2.1.316
ARG CLAUDE_SHA256_LINUX_ARM64=55cdb8e162d190432696ea54010e0fca2e18d06fa7a7127fd563b9ffd4f22624
ARG CLAUDE_SHA256_LINUX_X64=fd13c70000fec3f2116dfbcbb6121210b4a29328bf0e46210a59dd594a67d824
ARG CLAUDE_SIGNER_FINGERPRINT=31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE
WORKDIR /fetch
RUN set -eu; \
    apt-get update -qq; \
    apt-get install -qq -y --no-install-recommends ca-certificates curl gnupg >/dev/null; \
    case "$(dpkg --print-architecture)" in \
      arm64) platform=linux-arm64; sum=$CLAUDE_SHA256_LINUX_ARM64 ;; \
      amd64) platform=linux-x64; sum=$CLAUDE_SHA256_LINUX_X64 ;; \
      *) echo 'unsupported architecture' >&2; exit 1 ;; \
    esac; \
    base=https://downloads.claude.ai/claude-code-releases/$CLAUDE_VERSION; \
    curl -fsSL https://downloads.claude.ai/keys/claude-code.asc -o key.asc; \
    curl -fsSLO "$base/manifest.json"; \
    curl -fsSLO "$base/manifest.json.sig"; \
    export GNUPGHOME=/fetch/gnupg; \
    install -d -m 700 "$GNUPGHOME"; \
    gpg --batch --quiet --import key.asc; \
    gpg --batch --status-fd 1 --verify manifest.json.sig manifest.json >status.txt 2>/dev/null; \
    awk '$2 == "VALIDSIG" { print $NF }' status.txt | grep -qx "$CLAUDE_SIGNER_FINGERPRINT"; \
    node -e 'const m = JSON.parse(require("fs").readFileSync("manifest.json", "utf8")); const [version, platform, sum] = process.argv.slice(1); if (m.version !== version || m.platforms?.[platform]?.checksum !== sum) process.exit(1);' "$CLAUDE_VERSION" "$platform" "$sum"; \
    curl -fsSL "$base/$platform/claude" -o claude; \
    printf '%s  claude\n' "$sum" | sha256sum -c --quiet -; \
    install -m 755 claude /claude

FROM node@sha256:e4db4c914bf8ad241bd24804fc25d272d89bad97e68cdc8a1414862790a02c39
RUN set -eu; \
    apt-get update -qq; \
    apt-get install -qq -y --no-install-recommends git >/dev/null; \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/*; \
    find / -xdev -type f -perm /6000 -exec chmod a-s {} +; \
    install -d -o 0 -g 0 -m 755 /opt/adabra-night /opt/adabra-night/bin /etc/claude-code; \
    install -d -o 1001 -g 1001 -m 755 /sock
COPY --from=fetch /claude /opt/adabra-night/bin/claude
COPY tunnel.cjs shim.cjs entry.sh export.sh night-v1.md /opt/adabra-night/
COPY managed-settings.json /etc/claude-code/managed-settings.json
RUN set -eu; \
    chown -R 0:0 /opt/adabra-night /etc/claude-code; \
    chmod 755 /opt/adabra-night/bin/claude /opt/adabra-night/entry.sh /opt/adabra-night/export.sh; \
    chmod 644 /opt/adabra-night/tunnel.cjs /opt/adabra-night/shim.cjs /opt/adabra-night/night-v1.md /etc/claude-code/managed-settings.json

# Fixed here so the runner passes nothing but the credential, and a pull request changes none of it until the image is rebuilt.
ENV PATH=/opt/adabra-night/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    HOME=/tmp/home \
    CLAUDE_CONFIG_DIR=/tmp/claude \
    HTTPS_PROXY=http://127.0.0.1:8080 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    DISABLE_TELEMETRY=1 \
    DISABLE_ERROR_REPORTING=1 \
    DISABLE_AUTOUPDATER=1 \
    DISABLE_UPDATES=1 \
    ENABLE_CLAUDEAI_MCP_SERVERS=false \
    CLAUDE_CODE_DISABLE_CLAUDE_MDS=1 \
    CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 \
    CLAUDE_CODE_MAX_RETRIES=4 \
    CI=true \
    NPM_CONFIG_UPDATE_NOTIFIER=false
USER 1000:1000
WORKDIR /work
ENTRYPOINT []
CMD ["/opt/adabra-night/entry.sh"]
