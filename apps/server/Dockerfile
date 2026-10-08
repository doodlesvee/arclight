# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS base
WORKDIR /repo

# ffprobe/ffmpeg (scan-time metadata + poster frames) must exist in *every*
# stage that can run the server — including `deps`, which is what the dev
# compose override runs from. Installing it only in the runtime stage meant
# posters and video metadata silently no-op'd in dev mode.
#
# pg_dump backs up the database. It comes from the PGDG repo rather than
# Debian's own, because bookworm ships postgresql-client-15 and pg_dump
# refuses outright to dump a newer server than itself — and the database here
# is Postgres 17.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg ca-certificates curl gnupg \
  && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    | gpg --dearmor -o /usr/share/keyrings/pgdg.gpg \
  && echo "deb [signed-by=/usr/share/keyrings/pgdg.gpg] http://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
    > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update && apt-get install -y --no-install-recommends postgresql-client-17 \
  && rm -rf /var/lib/apt/lists/*

# ---- deps: install workspace dependencies once, shared by later stages ----
FROM base AS deps
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci

# ---- build web: produces apps/web/dist ----
FROM deps AS build-web
COPY apps/web apps/web
RUN npm run build --workspace apps/web

# ---- build server: produces apps/server/dist ----
FROM deps AS build-server
COPY apps/server apps/server
RUN npm run build --workspace apps/server

# ---- prod-deps: server's production dependencies only (no devDependencies) ----
FROM base AS prod-deps
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
RUN npm ci --omit=dev --workspace apps/server --include-workspace-root=false

# ---- runtime: slim image with only production deps + built output ----
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Runtime starts from a clean base rather than `base`, so it needs its own
# copy — see the note there about why every server-running stage needs this,
# and why postgresql-client comes from PGDG rather than Debian.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg ca-certificates curl gnupg \
  && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    | gpg --dearmor -o /usr/share/keyrings/pgdg.gpg \
  && echo "deb [signed-by=/usr/share/keyrings/pgdg.gpg] http://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
    > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update && apt-get install -y --no-install-recommends postgresql-client-17 \
  && rm -rf /var/lib/apt/lists/*

COPY apps/server/package.json ./package.json
COPY --from=prod-deps /repo/node_modules ./node_modules
COPY --from=build-server /repo/apps/server/dist ./dist
COPY --from=build-web /repo/apps/web/dist ./web-dist

EXPOSE 3000
CMD ["node", "dist/app.js"]
