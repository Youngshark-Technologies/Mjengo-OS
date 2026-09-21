# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# MjengoOS marketing website (mjengoos-website/) production image —
# multi-stage, mirroring the root Dockerfile's conventions.
#
#  bun:     oven/bun:1, digest-pinned (INF-3) — only the bun binary is
#           copied into the stages below (no curl|bash installer).
#  deps:    node:20-slim + bun. `bun install --frozen-lockfile` from the
#           site's own package.json + bun.lock. The site is an independent
#           app: no Prisma, no auth, no database — nothing to generate.
#  builder: `next build` under Node (exactly like CI). The three NEXT_PUBLIC_*
#           vars are BUILD args because Next.js inlines them at build time —
#           switching serving modes means rebuilding the image, not re-running
#           it. Defaults are the integrated mode (basePath /website,
#           same-origin "Sign in", empty SITE_URL → dev-fallback origin, so
#           set NEXT_PUBLIC_SITE_URL for any indexed deployment) so the
#           compose stack needs zero overrides.
#           Building requires no secrets — the site has none to dummy out
#           (no DATABASE_URL / NEXTAUTH_* involved).
#  runner:  node:20-slim, non-root `node` user, standalone server.js from
#           .next/standalone + .next/static + public/ (the copies that the
#           root app performs in its build script happen here instead — this
#           app's build script stays a plain `next build`). PORT=3001.
#           The contact-form API appends to data/submissions.json, so
#           /app/data is created writable for the non-root user. A
#           HEALTHCHECK (INF-2) probes the site's served route with node's
#           global fetch — see the comment at the HEALTHCHECK itself.
#
#  BUILD-time env = the three NEXT_PUBLIC_* ARGs above (no secrets).
#  RUNTIME env (docker run / compose): none required. PORT/HOSTNAME are
#  preset; the web app reaches this container as WEBSITE_ORIGIN in its
#  next.config.ts rewrite (http://website:3001 under compose). Optionally
#  set TRUST_PROXY=1 at RUNTIME (see mjengoos-website/.env.example) only
#  when a real appending proxy fronts this container directly.
# ---------------------------------------------------------------------------

# Digest-pinned 2026-09-21 (INF-3): manifest-list digest, multi-arch FROM. Refresh: curl -s https://hub.docker.com/v2/repositories/oven/bun/tags/1 | jq -r .digest
FROM oven/bun:1@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS bun

# Digest-pinned 2026-09-21 (INF-3): manifest-list digest, multi-arch FROM. Refresh: curl -s https://hub.docker.com/v2/repositories/library/node/tags/20-slim | jq -r .digest
FROM node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS deps
WORKDIR /app
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx

# Dependencies first (layer-cache friendly).
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM deps AS builder
WORKDIR /app

# Application source — .dockerignore keeps the context secrets-free
# (.env*, node_modules, .next, data/ never enter an image).
COPY . .

# Integrated mode by default (the web app on :3000 proxies /website/* here):
#   NEXT_PUBLIC_BASE_PATH=/website, "Sign in" → same-origin "/".
# Standalone mode on its own domain instead:
#   docker build --build-arg NEXT_PUBLIC_BASE_PATH= \
#                --build-arg NEXT_PUBLIC_APP_URL=https://app.yourdomain.example \
#                --build-arg NEXT_PUBLIC_SITE_URL=https://yourdomain.example …
# NEXT_PUBLIC_SITE_URL (MW-9) is the canonical public origin baked into
# sitemap.xml / robots.txt / canonicals / OG-Twitter URLs. It must be the
# origin the SITE IS BROWSED AT — in integrated mode that is the app's
# public origin, and the sitemap then lists .../website/<page>. Omitting it
# leaves every absolute URL pointing at the dev fallback localhost:3001.
# Launch gate (#149): a production standalone build (empty
# NEXT_PUBLIC_BASE_PATH) with it empty prints a [site-url] warning in this
# builder stage; the integrated default below stays silent by design.
ARG NEXT_PUBLIC_BASE_PATH=/website
ARG NEXT_PUBLIC_APP_URL=/
ARG NEXT_PUBLIC_SITE_URL=
# Sitemap lastModified (issue #143): the repo's .git never enters the build
# context, so the git-derived date that source builds use is unavailable
# here. Pass the last commit date that touched the site when building from
# a checkout — computed, never hand-edited:
#   --build-arg SITEMAP_LAST_MODIFIED="$(git log -1 --format=%cI -- mjengoos-website)"
# Without it the sitemap omits lastModified rather than invent a date.
# Not NEXT_PUBLIC_*: read server-side at build, not inlined client-side.
ARG SITEMAP_LAST_MODIFIED=
ENV NEXT_TELEMETRY_DISABLED=1 \
    NEXT_PUBLIC_BASE_PATH=${NEXT_PUBLIC_BASE_PATH} \
    NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL} \
    NEXT_PUBLIC_SITE_URL=${NEXT_PUBLIC_SITE_URL} \
    SITEMAP_LAST_MODIFIED=${SITEMAP_LAST_MODIFIED}

# Production build; then place the static assets + public/ inside the
# standalone tree (what the root app's build script does with cp — done
# here so the site's package.json stays untouched).
RUN bun run build \
    && cp -r .next/static .next/standalone/.next/ \
    && cp -r public .next/standalone/

# Digest-pinned 2026-09-21 (INF-3): manifest-list digest, multi-arch FROM. Refresh: curl -s https://hub.docker.com/v2/repositories/library/node/tags/20-slim | jq -r .digest
FROM node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3001 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1

# Next standalone output: server.js, .next/, traced node_modules, public/.
COPY --from=builder --chown=node:node /app/.next/standalone ./

# Runtime state the non-root user must be able to write: the contact-form
# API (POST /api/contact → /website/api/contact) appends here.
RUN mkdir -p /app/data && chown -R node:node /app/data

USER node
EXPOSE 3001

# INF-2: container-level liveness — the site's own served route, probed
# with the runner's Node 20 global fetch (node:20-slim ships no
# curl/wget). /website matches the DEFAULT integrated build
# (NEXT_PUBLIC_BASE_PATH=/website is baked at build time) — the same route
# docker-compose.yml's website healthcheck probes; a standalone-mode build
# (empty base path) must switch the path to '/', exactly like the compose
# comment says. Timing mirrors the compose healthcheck (interval 30s,
# timeout 5s, start_period 30s, retries 3) so the image and the compose
# service report health identically; PORT is read from the container env
# (ENV PORT=3001 above) so a runtime override moves server and probe
# together.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||'3001')+'/website').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "server.js"]
