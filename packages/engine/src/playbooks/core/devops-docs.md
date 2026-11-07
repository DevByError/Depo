## Definition of done
- README.md: what the project is, requirements with versions, setup, how to run, how to test, environment variables, folder layout, default demo accounts (if seeded) and troubleshooting. Every command in it was run and works.
- One command starts everything: run.cmd for Windows and run.sh for macOS and Linux. They check prerequisites, create the virtual environment or install packages when missing, apply migrations, seed when the database is empty, and start the services. They are safe to run twice.
- .env.example lists every variable with a comment and a safe placeholder; real .env files are git-ignored.
- Dockerfiles are multi-stage, run as a non-root user, have a .dockerignore and a health check; docker-compose.yml starts the database with a health check and the apps depend on it being healthy.
- CI (GitHub Actions) installs, lints, type-checks and tests on push and pull request, with dependency caching and read-only permissions.
- API documentation points to the live OpenAPI docs; a CHANGELOG records what was added.

## Checklist
- Read the real files (package.json scripts, pyproject, compose, settings) before writing about them.
- Windows first: batch syntax in run.cmd (call for activation scripts, start for parallel processes), LF line endings for .sh files (.gitattributes).
- Bind local development ports to 127.0.0.1 in compose; use named volumes for data.
- Pin image tags and action versions (no latest).
- Put architecture notes and diagram links in docs/.

## Avoid
- Documented commands that were never run; outdated ports or paths.
- Secrets in compose files, Dockerfiles or CI logs.
- Scripts that need manual steps in the middle or interactive input.
