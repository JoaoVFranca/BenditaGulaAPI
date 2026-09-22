FROM node:24-bookworm-slim AS frontend-build
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM node:24-bookworm-slim AS backend-build
WORKDIR /build/backend
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 STATIC_DIR=/app/public
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=backend-build /build/backend/dist/ ./dist/
COPY --from=frontend-build /build/frontend/dist/ ./public/
COPY migrations/ ./migrations/
USER node
EXPOSE 3000
CMD ["sh", "-c", "node dist/migrate.js && exec node dist/server.js"]
