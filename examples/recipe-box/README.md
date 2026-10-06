# Recipe Box

Save, cook and share recipes. Paste a recipe, scale it for the number of people at the table, then follow along in cook mode with step timers and the screen kept awake.

## Layout

- `apps/web` - Next.js 15 (app router) front end
- `apps/api` - Hono API on Node, Drizzle + Postgres, Google sign-in
- `apps/jobs` - background worker (thumbnails, weekly digest email)
- `infra` - local Postgres and MinIO (S3) via docker compose

## Getting started

```sh
docker compose -f infra/docker-compose.yml up -d
cp apps/api/.env.example apps/api/.env
npm install
npm run dev
```

The web app runs on :3000 and the API on :8787.
