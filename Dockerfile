# syntax=docker/dockerfile:1

# ---- build: full toolchain, produces dist/index.js ----
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN npm run build

# ---- runtime: production dependencies and dist only, non-root ----
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# The image ships no credentials. MCP_SERVER_KEYS (required) and PORT/HOST/LOG_LEVEL come in at run time;
# mail tokens arrive per request in X-Mail-Token.
USER node
EXPOSE 3000

# Node itself asks /healthz, so the image needs no curl or wget.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js", "--http"]
