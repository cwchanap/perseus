# Perseus API

A lightweight HTTP API built with [Hono](https://hono.dev/) and Bun.

## Development

```bash
# From the root of the monorepo
bun run dev --filter=@perseus/api

# Or from this directory
bun run dev
```

The API will start on `http://localhost:3000`

## Available Endpoints

- `GET /` - API information and version
- `GET /health` - Health check endpoint
- `GET /api/hello?name=World` - Example API route

## Building

```bash
# From the root
bun run build --filter=@perseus/api

# Or from this directory
bun run build
```

## Production

```bash
# Build first
bun run build

# Then start
bun run start
```

## Scripts

- `dev` - Start development server with hot reload
- `build` - Build for production
- `start` - Start production server
- `check` - TypeScript type checking
- `lint` - Run Prettier and ESLint

## Tech Stack

- **Runtime**: Bun
- **Framework**: Hono
- **Language**: TypeScript
