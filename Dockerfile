# ---- Stage 1: Builder ----
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY prisma/ ./prisma/
RUN npx prisma generate

COPY src/ ./src/
COPY public/ ./public/
RUN npm run build

# ---- Stage 2: Runtime ----
FROM node:20-alpine

RUN apk add --no-cache openssl

WORKDIR /app

COPY --from=builder /app/dist/ ./dist/
COPY --from=builder /app/public/ ./public/
COPY --from=builder /app/prisma/ ./prisma/
COPY --from=builder /app/node_modules/ ./node_modules/
COPY package.json config.example.json ./

RUN mkdir -p data prisma/prisma

COPY entrypoint.sh .
RUN chmod +x entrypoint.sh

EXPOSE 3333
VOLUME ["/app/data"]

ENTRYPOINT ["/app/entrypoint.sh"]
