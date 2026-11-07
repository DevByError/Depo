/**
 * Versioned migrations, embedded in code so the compiled sidecar needs no files on disk.
 * Rules: never edit a released migration; add a new one with the next version number.
 * Each migration runs in its own transaction.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "settings_and_events",
    sql: `
      CREATE TABLE settings (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE events (
        id TEXT PRIMARY KEY NOT NULL,
        seq INTEGER NOT NULL,
        ts TEXT NOT NULL,
        project_id TEXT,
        task_id TEXT,
        agent TEXT NOT NULL,
        type TEXT NOT NULL,
        text TEXT NOT NULL,
        details TEXT,
        duration_ms INTEGER,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX events_project_ts ON events (project_id, ts);
      CREATE INDEX events_type_ts ON events (type, ts);
    `,
  },
  {
    version: 2,
    name: "projects_tasks_changes_checkpoints",
    sql: `
      CREATE TABLE projects (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL,
        last_opened_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX projects_root ON projects (root_path);
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        workspace_path TEXT,
        model TEXT,
        summary TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX tasks_project ON tasks (project_id, created_at);
      CREATE TABLE messages (
        id TEXT PRIMARY KEY NOT NULL,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX messages_task ON messages (task_id, created_at);
      CREATE TABLE change_sets (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        task_id TEXT,
        status TEXT NOT NULL,
        title TEXT NOT NULL,
        files TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX change_sets_project ON change_sets (project_id, created_at);
      CREATE TABLE checkpoints (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        change_set_id TEXT,
        label TEXT NOT NULL,
        status TEXT NOT NULL,
        files TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX checkpoints_project ON checkpoints (project_id, created_at);
    `,
  },
  {
    version: 3,
    name: "projects_admin_memory_code_index",
    sql: `
      ALTER TABLE projects ADD COLUMN description TEXT NOT NULL DEFAULT '';
      ALTER TABLE projects ADD COLUMN stack TEXT NOT NULL DEFAULT '';
      ALTER TABLE projects ADD COLUMN origin TEXT NOT NULL DEFAULT 'opened';
      ALTER TABLE projects ADD COLUMN archived_at TEXT;
      CREATE TABLE project_settings (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, key)
      );
      CREATE TABLE memory_facts (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        signature TEXT,
        source TEXT NOT NULL,
        uses INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX memory_facts_project ON memory_facts (project_id, kind);
      CREATE INDEX memory_facts_signature ON memory_facts (signature);
      CREATE TABLE code_files (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        hash TEXT NOT NULL,
        lang TEXT,
        size INTEGER NOT NULL,
        lines INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, path)
      );
      CREATE TABLE code_symbols (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        parent TEXT,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        signature TEXT NOT NULL
      );
      CREATE INDEX code_symbols_path ON code_symbols (project_id, path);
      CREATE INDEX code_symbols_name ON code_symbols (project_id, name);
      CREATE TABLE embeddings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        text_hash TEXT NOT NULL,
        model TEXT NOT NULL,
        dim INTEGER NOT NULL,
        vector BLOB NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX embeddings_path ON embeddings (project_id, path);
    `,
  },
  {
    version: 4,
    name: "agent_team",
    sql: `
      ALTER TABLE tasks ADD COLUMN mode TEXT NOT NULL DEFAULT 'single';
      ALTER TABLE tasks ADD COLUMN plan TEXT;
      CREATE TABLE blackboard (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        section TEXT NOT NULL,
        content TEXT NOT NULL,
        version INTEGER NOT NULL,
        owner TEXT NOT NULL,
        task_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, section)
      );
      CREATE TABLE blackboard_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        section TEXT NOT NULL,
        version INTEGER NOT NULL,
        content TEXT NOT NULL,
        owner TEXT NOT NULL,
        task_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX blackboard_history_section ON blackboard_history (project_id, section, version);
      CREATE TABLE agent_messages (
        id TEXT PRIMARY KEY NOT NULL,
        task_id TEXT NOT NULL,
        from_agent TEXT NOT NULL,
        to_agent TEXT NOT NULL,
        type TEXT NOT NULL,
        summary TEXT NOT NULL,
        artifacts TEXT NOT NULL,
        criteria TEXT NOT NULL,
        confidence REAL NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX agent_messages_task ON agent_messages (task_id, created_at);
    `,
  },
  {
    version: 5,
    name: "skills_mcp_knowledge",
    sql: `
      CREATE TABLE skills (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source TEXT NOT NULL,
        ref TEXT,
        commit_sha TEXT,
        version_id TEXT NOT NULL,
        versions TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        vetting TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE skill_assignments (
        skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
        scope TEXT NOT NULL,
        project_id TEXT NOT NULL DEFAULT '',
        agent TEXT NOT NULL,
        PRIMARY KEY (skill_id, scope, project_id, agent)
      );
      CREATE TABLE mcp_servers (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL UNIQUE,
        transport TEXT NOT NULL,
        command TEXT,
        args TEXT NOT NULL,
        env TEXT NOT NULL,
        url TEXT,
        enabled INTEGER NOT NULL DEFAULT 0,
        auto_approve INTEGER NOT NULL DEFAULT 0,
        vetting TEXT,
        tools TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE knowledge_packs (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL UNIQUE,
        version TEXT NOT NULL,
        kind TEXT NOT NULL,
        source TEXT NOT NULL,
        description TEXT NOT NULL,
        doc_count INTEGER NOT NULL,
        chunk_count INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE knowledge_fts USING fts5(
        text, title, path UNINDEXED, pack_id UNINDEXED, tokenize = 'porter unicode61'
      );
      CREATE TABLE osv_vulns (
        id TEXT NOT NULL,
        ecosystem TEXT NOT NULL,
        package TEXT NOT NULL,
        summary TEXT NOT NULL,
        details TEXT NOT NULL,
        severity TEXT,
        ranges TEXT NOT NULL,
        versions TEXT NOT NULL,
        fixed TEXT,
        aliases TEXT NOT NULL DEFAULT '[]',
        modified TEXT,
        PRIMARY KEY (id, ecosystem, package)
      );
      CREATE INDEX osv_vulns_pkg ON osv_vulns (ecosystem, package);
      CREATE TABLE osv_meta (
        ecosystem TEXT PRIMARY KEY NOT NULL,
        imported_at TEXT NOT NULL,
        count INTEGER NOT NULL,
        source TEXT NOT NULL
      );
    `,
  },
  {
    version: 6,
    name: "agent_lab",
    sql: `
      CREATE TABLE agent_versions (
        id TEXT PRIMARY KEY NOT NULL,
        agent_id TEXT NOT NULL,
        version TEXT NOT NULL,
        manifest TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (agent_id, version)
      );
      CREATE TABLE agent_promotions (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        version_id TEXT,
        reason TEXT NOT NULL,
        at TEXT NOT NULL
      );
      CREATE INDEX agent_promotions_agent ON agent_promotions (agent_id, seq);
      CREATE TABLE agent_eval_suites (
        id TEXT PRIMARY KEY NOT NULL,
        agent_id TEXT NOT NULL,
        name TEXT NOT NULL,
        cases TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (agent_id, name)
      );
      CREATE TABLE agent_eval_runs (
        id TEXT PRIMARY KEY NOT NULL,
        agent_id TEXT NOT NULL,
        version_id TEXT,
        suite_id TEXT NOT NULL,
        score REAL NOT NULL,
        results TEXT NOT NULL,
        model TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX agent_eval_runs_agent ON agent_eval_runs (agent_id, suite_id, created_at);
    `,
  },
  {
    // Time estimates learned on this PC (agents/eta.ts). IF NOT EXISTS keeps it safe to renumber.
    version: 7,
    name: "eta_history",
    sql: `
      CREATE TABLE IF NOT EXISTS eta_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent TEXT NOT NULL,
        kind TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        model TEXT,
        tokens_per_sec REAL,
        attempts INTEGER,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS eta_samples_agent_kind ON eta_samples (agent, kind, id);
      CREATE TABLE IF NOT EXISTS eta_models (
        model TEXT PRIMARY KEY NOT NULL,
        tokens_per_sec REAL,
        ttft_ms REAL,
        calls INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
    `,
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);
