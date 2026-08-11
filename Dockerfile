FROM node:22-slim AS build

WORKDIR /app

COPY package*.json ./

RUN npm ci

COPY tsconfig.json eslint.config.js ./
COPY src ./src

RUN npm run build


FROM node:22-slim AS production

WORKDIR /app

COPY package*.json ./

RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY src/database/migrations ./src/database/migrations

EXPOSE 8080

CMD ["node", "dist/server.js"]