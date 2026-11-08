Build "Skill Finder": a website where people describe what they want their AI agent to do, find matching Agent Skills from GitHub, read them, and download them to install.

An Agent Skill is a folder with a SKILL.md file: YAML front matter between two --- lines with "name" and "description", then Markdown instructions. The folder can also hold scripts, examples and templates. Claude Code loads skills from ~/.claude/skills/<skill-name>/.

Use the Next.js + Bun + MySQL starting project that is already here: fe/ is the Next.js site (port 3000), be/ is the Bun + TypeScript API (port 4000), with sign up, sign in, sign out, sessions, bun run db:migrate, bun run db:seed and bun test. Keep its structure and style: routes in be/src/app.ts, one folder per area, the Store interface with a MySQL store and a memory store that behave the same, new tables at the end of be/src/db/schema.sql (CREATE TABLE IF NOT EXISTS), and the theme tokens in fe/app/globals.css.

The app is built in 4 messages. This is part 1: the data, search with demo skills, and the skill page. Later parts add GitHub scanning, Sign in with GitHub and favorites. Do only part 1 now, but create all four tables now so later parts need no schema change.

## Database (add to schema.sql)
- skills: id, source ('demo' or 'github'), repo (owner/name, up to 200 chars), path (the skill folder inside the repo, '' for the root), name, description, keywords (TEXT), stars, license (nullable), default_branch, repo_updated_at (nullable), html_url, skill_md (MEDIUMTEXT, at most 100 KB), file_count, has_scripts, found_at, updated_at. Unique key on (repo, path). FULLTEXT index on (name, description, keywords).
- scans: id, kind ('scheduled', 'manual', 'repo', 'deep'), status ('running', 'done', 'failed'), started_at, finished_at, found, added, message, user_id (nullable).
- favorites: user_id, skill_id, created_at; primary key (user_id, skill_id); both foreign keys ON DELETE CASCADE.
- github_accounts: user_id (primary key, foreign key to users), github_id (unique), login, avatar_url, token_encrypted, created_at.
Add the methods you need to the Store interface and to both stores.

## Demo skills (bun run db:seed)
Seed 15 demo skills with source 'demo', repos under the owner "demo-skills", and a realistic SKILL.md each, on different topics: filling PDF forms, Excel reports, git commit messages, code review checklist, changelog writer, SQL query helper, API documentation, unit test writer, React components, accessibility audit, Dockerfiles, image resizing (with scripts/resize.py), meeting notes, translation, brand guidelines. Give 6 of them 2 to 5 extra files (scripts, examples, templates). Write every skill's files into the skill cache folder (below) so everything works offline. Keep the existing demo users.

## Search API
GET /api/skills/search?q=&sort=best|stars|updated&scripts=1&offset=0&limit=20 returns { items, total }. Each item: id, name, description, repo, path, stars, license, updatedAt, hasScripts, fileCount, source, score, matched (the query words it contains).
- MySQL store: MATCH ... AGAINST in natural language mode, with extra weight when a word is in the name. Memory store: the same idea with simple word counts, so tests and a quick try behave alike.
- An empty q returns the most-starred skills. limit is at most 50. Words shorter than 2 letters are ignored.

## Skill API (query parameters, so the existing route table works)
- GET /api/skill?id= : the skill with skillMd, files [{ path, size, isText }] and safety (below).
- GET /api/skill/file?id=&path= : one text file, at most 200 KB. Refuse binary files and any path with .. or outside the skill's folder.
- GET /api/skill/download?id= : a ZIP of the skill folder with one top folder named after the skill (use the fflate package).
Skill files live in be/.data/skills/<id>/<skill-name>/ (add be/.data/ to .gitignore). Never run or import anything from there; only read it.

Safety, worked out from the files: the number of files, the scripts (.sh, .ps1, .bat, .py, .js, .ts) by name, and plain warnings when a script downloads things (curl, wget, Invoke-WebRequest, fetch, requests), deletes things (rm -rf, Remove-Item, del /s) or asks for admin rights (sudo). When there is no license: "No license: check before you reuse it."

## Front end
A header on every page: the "Skill Finder" logo linking home, a search box (not on the home page), Sign in and Create account, and when signed in the user's name with Sign out.
- / : a big search box labelled "What should your agent be able to do?", 6 example chips (for example "fill PDF forms", "write commit messages"), and results as cards: name, description, repo, stars, last update, license, a "Has scripts" tag, a "Demo" tag for demo skills, and the matched words highlighted. Sort (Best match, Most stars, Recently updated), a "Has scripts" filter and "Load more". Search on Enter and 300 ms after typing stops. Keep q, sort and the filter in the URL so a search can be shared. Loading skeletons, an empty state with tips, and an error state with Retry.
- /skills/[id] : name, description, a repo link (GitHub, new tab), stars, license, last update; the SKILL.md rendered as Markdown (react-markdown, no raw HTML); the file list, where clicking a text file shows it in a read-only code view; the safety panel; and an "Install" box with a Download ZIP button and copy buttons for two install commands, one for Windows PowerShell and one for macOS/Linux, that download the ZIP into ~/.claude/skills/ and unzip it there. Build the commands from window.location.origin.
- It must work and look right on phones (390 px), tablets (820 px) and desktops (1440 px): no sideways scrolling, tap targets at least 40 px, a label on every input, visible keyboard focus, AA contrast.

## Tests (bun test, no network)
Front matter parsing (normal, quoted values, CRLF line endings, missing fields fall back to the folder name), search ranking (a name match beats a description match, sort by stars, the scripts filter, an empty query), the file route refusing .., the ZIP having one top folder, and the safety warnings.

Done means: the tests pass, migrate and seed work, both apps run, the home page lists the demo skills, and a skill page shows its SKILL.md, its files and a working ZIP download.
