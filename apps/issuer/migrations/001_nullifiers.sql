-- cpay-issuer: the issuer's only table (CLAUDE.md invariant 3, docs/STACK.md "Supabase").
-- Run once against Supabase with the DIRECT (non-pooled) URL:
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f apps/issuer/migrations/001_nullifiers.sql
-- Do NOT use `prisma db push` for this table: it would not enable RLS.
begin;

-- Legacy tables created by an earlier `prisma db push` of the old schema:
--   "IssuerKey": the BBS issuer key is an operational secret kept in env (ISSUER_BBS_SECRET_KEY), never in a table.
--   "Nullifier": rows written by the old /enrol path, which never verified with World and had no
--                commitment hash; they can't be trusted, so they are dropped, not migrated.
drop table if exists "IssuerKey";
drop table if exists "Nullifier";

create table if not exists nullifiers (
  nullifier       text not null,   -- normalised decimal of the uint256
  action          text not null,
  commitment_hash text not null,   -- sha256 of the BBS commitment C; allows same-holder re-issue only
  constraint nullifiers_nullifier_action_key unique (nullifier, action)
);

-- RLS on, no policies: the Supabase public API (anon/authenticated keys) can read and write nothing.
-- The issuer connects as the database owner via DATABASE_URL, which bypasses RLS.
alter table nullifiers enable row level security;

commit;
