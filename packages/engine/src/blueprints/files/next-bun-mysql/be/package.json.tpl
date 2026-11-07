{
  "name": "__DEPO_SLUG__-api",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "packageManager": "bun@1.2.0",
  "scripts": {
    "dev": "bun --watch src/index.ts",
    "start": "bun src/index.ts",
    "test": "bun test",
    "typecheck": "tsc --noEmit",
    "db:migrate": "bun src/db/migrate.ts",
    "db:seed": "bun src/db/seed.ts"
  },
  "dependencies": {
    "mysql2": "^3.14.0"
  },
  "devDependencies": {
    "@types/bun": "^1.2.0",
    "typescript": "^5.9.3"
  }
}
