# Earworm production image.
# Build:  docker build -t earworm .
# Run:    docker run -p 8080:8080 -v earworm-data:/data --env-file .env earworm

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    DATABASE_PATH=/data/earworm.db
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/shared ./shared
# The SQLite database lives on a mounted volume so it survives redeploys.
VOLUME /data
EXPOSE 8080
CMD ["node_modules/.bin/tsx", "server/index.ts", "--prod"]
