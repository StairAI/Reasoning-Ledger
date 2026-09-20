-- Privileges for the api-server's runtime account (design §5). Applied by
-- `pnpm db:deploy` after every migration, as the migration account, with
-- {{runtime}} replaced by the quoted role name. Safe to run repeatedly.
--
-- The runtime account reads and writes what the server needs, but records are
-- append-only for it: it can never UPDATE or DELETE trace_records. Content
-- deletions are written only by the operator command, never by the server.

GRANT USAGE ON SCHEMA public TO {{runtime}};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO {{runtime}};
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO {{runtime}};

REVOKE UPDATE, DELETE, TRUNCATE ON "trace_records" FROM {{runtime}};
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "content_deletions" FROM {{runtime}};
REVOKE ALL ON "_prisma_migrations" FROM {{runtime}};
