-- Creates (or updates) the application role and databases. Idempotent.
-- Run through `npm run db:bootstrap`, which supplies the values via environment variables
-- so the application password never appears on the command line.
\set ON_ERROR_STOP on
\getenv app_user QA_APP_USER
\getenv app_password QA_APP_PASSWORD
\getenv app_db QA_APP_DB
\getenv test_db QA_TEST_DB

SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', :'app_user', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_user') \gexec

SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', :'app_user', :'app_password') \gexec

SELECT format('CREATE DATABASE %I OWNER %I ENCODING %L', :'app_db', :'app_user', 'UTF8')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'app_db') \gexec

SELECT format('CREATE DATABASE %I OWNER %I ENCODING %L', :'test_db', :'app_user', 'UTF8')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'test_db') \gexec

\echo 'Role and databases are ready.'
