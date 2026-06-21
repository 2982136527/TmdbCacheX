#!/bin/sh
set -e

DATA_DIR="/app/data"

# Symlink config.json
if [ -f "$DATA_DIR/config.json" ]; then
    ln -sf "$DATA_DIR/config.json" /app/config.json
elif [ ! -f /app/config.json ]; then
    cp /app/config.example.json /app/config.json
fi

# Symlink database directory so DB is always created in data volume
mkdir -p "$DATA_DIR/db"
rm -rf /app/prisma/prisma
ln -sf "$DATA_DIR/db" /app/prisma/prisma

# Symlink warmer checkpoint
if [ -f "$DATA_DIR/warmer_checkpoint.json" ]; then
    ln -sf "$DATA_DIR/warmer_checkpoint.json" /app/warmer_checkpoint.json
fi

# Set DATABASE_URL for Prisma
export DATABASE_URL="file:./prisma/dev.db"

# Run database migrations
npx prisma migrate deploy

exec node dist/server.js
