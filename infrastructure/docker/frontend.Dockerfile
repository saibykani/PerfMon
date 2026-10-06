FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
COPY collector/package.json collector/
RUN npm ci --workspace frontend --include-workspace-root=false --no-audit --no-fund
COPY frontend frontend
RUN npm run build --workspace frontend

FROM nginx:1.27-alpine
COPY infrastructure/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/frontend/dist /usr/share/nginx/html
EXPOSE 80
