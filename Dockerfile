# MJG-019 — MjengoOS production image.
# Multi-stage: deps -> build -> slim runtime.
# NOTE: docker is unavailable in the development sandbox; image build is
# validated by review against the local scripts ("build"/"start" in
# package.json) and must be exercised in the deployment environment
# (docs/DEPLOYMENT.md).

FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY prisma ./prisma
RUN bun install --frozen-lockfile

FROM oven/bun:1 AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# DATABASE_URL is a runtime concern; a placeholder keeps prisma generate happy.
ENV DATABASE_URL=file:./db/build-placeholder.db
RUN bunx prisma generate && bun run build

FROM oven/bun:1-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
# Runtime configuration (mount or pass -e):
#   DATABASE_URL=file:/data/mjengo.db   (SQLite file; mount a volume at /data)
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/public ./public
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/docker-entrypoint.sh ./docker-entrypoint.sh
# NOTE: no db/ in the image — data lives in the mounted volume (see VOLUME).
RUN chmod +x ./docker-entrypoint.sh && mkdir -p /data
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["./docker-entrypoint.sh"]
