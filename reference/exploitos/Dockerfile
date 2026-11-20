# ── Deps ─────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ── Build ─────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Build the Next.js app (outputs to .next/)
RUN npm run build

# ── Runner ────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Next.js standalone output would be ideal but requires next.config.
# For now copy the full build — still lean enough for Railway.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/src ./src
COPY --from=builder /app/public ./public
COPY package.json ./

# traces/ dir must exist at runtime
RUN mkdir -p traces

# Do NOT hardcode PORT — Railway injects it at runtime.
# Next.js start reads $PORT automatically.
EXPOSE 3000

CMD ["node_modules/.bin/next", "start"]
