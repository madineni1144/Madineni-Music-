'use strict';

const fs = require('node:fs');
const path = require('node:path');

function loadEnvironment() {
  // Existing systemd environment variables always take precedence.
  const candidates = process.env.ENV_FILE
    ? [process.env.ENV_FILE]
    : ['/opt/musicapp/app/config/.env',
       path.join(__dirname, '../config/.env'),
       path.join(__dirname, '../.env')];
  for (const filename of candidates) {
    if (fs.existsSync(filename)) require('dotenv').config({path: filename});
  }
}

function integer(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= max ? parsed : fallback;
}

function directory(env, key, deployed, relative) {
  return path.resolve(env[key] || (fs.existsSync(deployed) ? deployed : path.join(__dirname, relative)));
}

function getConfig(env = process.env) {
  const bounded = env.SONGS_PAGINATION_ENABLED === 'true';
  // Native iOS source is not in this repo yet. Keep its existing response
  // contract until that client is confirmed to follow pagination.
  const songsMaxLimit = bounded ? 500 : 1000000;
  return {
    port: integer(env.PORT, 3000, 65535),
    host: env.HOST || '0.0.0.0',
    frontendDir: directory(env, 'FRONTEND_DIR', '/opt/musicapp/app/frontend', '../frontend'),
    musicDir: directory(env, 'MUSIC_DIR', '/opt/musicapp/music/Songs', '../music/Songs'),
    coversDir: directory(env, 'COVERS_DIR', '/opt/musicapp/covers', '../covers'),
    publicUrl: env.PUBLIC_URL || 'https://madinenimusic.madineni.xyz',
    corsOrigins: (env.CORS_ORIGINS || 'https://madinenimusic.madineni.xyz').split(',').map(s => s.trim()).filter(Boolean),
    trustProxy: env.TRUST_PROXY === 'false' ? false : (env.TRUST_PROXY || 'loopback').split(',').map(s => s.trim()),
    apiRateLimit: integer(env.API_RATE_LIMIT, 600),
    lyricsRateLimit: integer(env.LYRICS_RATE_LIMIT, 60),
    songsDefaultLimit: bounded ? 50 : 1000000,
    songsMaxLimit,
    musicCacheMaxAge: env.MUSIC_CACHE_MAX_AGE || '0',
    db: {
      host: env.DB_HOST, port: env.DB_PORT, database: env.DB_NAME,
      user: env.DB_USER, password: env.DB_PASSWORD,
      max: 10, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000,
    },
  };
}

module.exports = {loadEnvironment, getConfig};
