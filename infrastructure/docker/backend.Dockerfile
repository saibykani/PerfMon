# ---- build ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
COPY collector/package.json collector/
RUN npm ci --workspace backend --include-workspace-root=false --no-audit --no-fund
COPY backend backend
RUN npm run build --workspace backend

# ---- runtime ----
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json* ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
COPY collector/package.json collector/
RUN npm ci --workspace backend --include-workspace-root=false --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/backend/dist backend/dist
WORKDIR /app/backend
RUN addgroup -S perfmon && adduser -S perfmon -G perfmon && mkdir -p /app/storage-data && chown -R perfmon:perfmon /app/storage-data
USER perfmon
EXPOSE 8080 8081
CMD ["node", "dist/index.js"]
