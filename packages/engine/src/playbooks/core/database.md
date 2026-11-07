## Definition of done
- Migrations create the whole schema from an empty database and apply cleanly; the migration tool's own command was run (alembic upgrade head, prisma migrate dev, manage.py migrate, drizzle-kit migrate).
- Every table has a primary key, created_at and updated_at in UTC (timestamptz in PostgreSQL), NOT NULL unless a value can truly be missing, foreign keys with an explicit ON DELETE rule, UNIQUE on natural keys (email stored lower-cased or with a unique index on lower(email)), and CHECK constraints for ranges and fixed value sets.
- Indexes exist for every foreign key and for the columns lists filter or sort by; composite index order is equality columns first, then range or sort.
- A seed script creates realistic demo data (and a demo admin when roles exist, with a password read from the environment or printed once), and can run twice without errors.
- schema/ on the blackboard describes each table: columns, types, keys, indexes, relations and the business rules the constraints enforce.

## Checklist
- Model the hard rules in the database: no double booking (unique or exclusion constraint), one owner per record, stock never negative.
- Money as integer cents or numeric(12,2); never floats. Enumerations as CHECK constraints or lookup tables.
- Use transactions for multi-row invariants; SELECT ... FOR UPDATE or optimistic version columns against lost updates.
- Soft delete (deleted_at) only when the stories need restore or audit; add partial indexes WHERE deleted_at IS NULL.
- Read query plans (EXPLAIN ANALYZE) for the main list queries once seed data exists.

## Avoid
- Editing a migration that has already been applied; write a new one.
- Comma-separated lists or JSON blobs for data you filter or join on.
- Missing indexes on foreign keys (PostgreSQL does not create them).
- Real passwords, emails or secrets in seed files.
