# Copy this file to .env and change the values. Never commit .env.
APP_ENV=development

# At least 32 random characters. Make one with:
#   python -c "import secrets; print(secrets.token_urlsafe(48))"
# Left empty in development, the app keeps a generated one in data/.dev-secret.
JWT_SECRET=
TOKEN_MINUTES=60

# SQLite by default (a file in data/). For PostgreSQL: pip install "psycopg[binary]", then
# DATABASE_URL=postgresql://app:password@localhost:5432/app
DATABASE_URL=sqlite:///data/app.db

# Web apps allowed to call the API from a browser, comma separated.
CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
LOG_LEVEL=INFO

# Failed sign-ins allowed per email and address within the window (seconds).
LOGIN_ATTEMPTS=5
LOGIN_WINDOW_SECONDS=300

# The first admin, created by: python -m app.seed
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=
