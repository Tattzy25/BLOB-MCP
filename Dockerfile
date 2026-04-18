# ---- Build stage ----
FROM node:20-alpine AS build

WORKDIR /app

# Install dependencies (including devDependencies for the build)
COPY package.json package-lock.json* ./
RUN npm ci

# Copy source and compile TypeScript
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop devDependencies so we can copy a lean node_modules forward
RUN npm prune --omit=dev

# ---- Runtime stage ----
FROM node:20-alpine AS runtime

# Tini as PID 1 for clean signal handling
RUN apk add --no-cache tini

WORKDIR /app
ENV NODE_ENV=production

# Non-root user
RUN addgroup -S app && adduser -S app -G app

COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --chown=app:app package.json ./

USER app

# Railway / other hosts inject PORT at runtime
EXPOSE 3000

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
