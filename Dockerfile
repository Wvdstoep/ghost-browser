# Its own image, with Chromium in it.
#
# This is the reason the service is a separate deployment rather than another app on the shared
# runner image: the runner has no browser, and installing one at container start would mean a
# 300 MB download and a system-dependency install on every pod restart. Microsoft's Playwright
# image already has Chromium at exactly the version the npm package expects, on glibc — the
# Alpine/musl route does not launch Chromium at all.
#
# The tag MUST track the playwright version in package.json, and that version MUST be pinned exactly
# — no caret. Caught on the first deploy: `^1.59.1` resolved to 1.59.1 locally and 1.62.1 in the
# build, so the package went looking for a Chromium the base image does not contain and every
# session failed with "Executable doesn't exist at /ms-playwright/chromium_headless_shell-1234".
# The image and the package are one thing; a range pretends they are two.
FROM mcr.microsoft.com/playwright:v1.59.1-noble

# Tailscale, so the browser can exit through a device its OWNER controls.
#
# The pods exit from a Hetzner IP that public databases already flag as a proxy, and Facebook
# refuses a login from it while accepting the same account from a home connection seconds later.
# That is not fixable in the browser; it is fixable by not exiting from here.
#
# The static binaries, not the apt repo: this needs two files, not a systemd unit, an init script
# and a package manager's opinion about how a VPN should start.
ARG TAILSCALE_VERSION=1.78.1
RUN set -eux;     arch="$(dpkg --print-architecture)";     case "$arch" in amd64) ts_arch=amd64 ;; arm64) ts_arch=arm64 ;; *) echo "unsupported $arch" >&2; exit 1 ;; esac;     curl -fsSL "https://pkgs.tailscale.com/stable/tailscale_${TAILSCALE_VERSION}_${ts_arch}.tgz" -o /tmp/ts.tgz;     tar -xzf /tmp/ts.tgz -C /tmp;     mv /tmp/tailscale_${TAILSCALE_VERSION}_${ts_arch}/tailscale /tmp/tailscale_${TAILSCALE_VERSION}_${ts_arch}/tailscaled /usr/local/bin/;     rm -rf /tmp/ts.tgz /tmp/tailscale_${TAILSCALE_VERSION}_${ts_arch};     tailscale version

# ffmpeg — so the browser can encode its OWN screen recordings (the CDP screencast) into a video
# asset. This is what lets GhostBrowser film itself: a live tour of the console becomes an MP4 clip
# that goes straight into an edit. apt here, not a static binary — ffmpeg pulls a web of codecs.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY public ./public
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# The image already ships a non-root `pwuser`; Chromium runs unprivileged and nothing is written
# to disk, so there is nothing to chown beyond the app itself.
RUN chown -R pwuser:pwuser /app
USER pwuser

ENV NODE_ENV=production
EXPOSE 3000
# The browser runs HEADFUL, so it needs a display.
#
# reCAPTCHA Enterprise scores a headless browser as automated before the puzzle is even shown —
# which is why solving Facebook's fire hydrants correctly still returned to the login page. A real
# X display is not something a stealth patch can fake.
#
# The display is started by entrypoint.sh rather than `xvfb-run`: that wrapper failed once here with
# nothing listening and no output at all, which is unfixable without guessing. Eight explicit lines
# print what happened.
CMD ["/usr/local/bin/entrypoint.sh"]
