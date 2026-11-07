# Copy this file to .env (Bun reads .env by itself).
PORT=4000
# MySQL or MariaDB, e.g. mysql://app:app@127.0.0.1:3306/__DEPO_SLUG__
# Leave it empty to keep users in memory (handy for a quick try; lost on restart).
DATABASE_URL=
# The web app's address, for CORS when it calls the API directly (its dev proxy needs none).
WEB_ORIGIN=http://localhost:3000
# "production" makes the session cookie Secure (HTTPS only).
NODE_ENV=development
