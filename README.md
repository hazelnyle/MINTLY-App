# MINTLY Cloud Edition (starter)

This package adds a Supabase-backed foundation for:
- Email/password registration and login
- Personal and household spaces
- Cloud-backed transactions and essentials
- Role-based household access (owner/admin/editor/viewer)
- Realtime refresh for database changes (can be enabled as a follow-up)
- A basic offline write queue for new transactions and essentials
- Household invitation through a server-side Edge Function

## Important status

This is an integration-ready starter, **not a live connected or production-certified service**. You must create a Supabase project, run the SQL, configure `config.js`, deploy the Edge Function, and test access controls before real users enter financial information.

The browser app uses the Supabase publishable/anon key only. Never place a `service_role` key in `config.js`.

## 1. Create Supabase project

1. Create a project at https://supabase.com/
2. In Project Settings → API, copy the Project URL and publishable key (or legacy anon key).
3. Put them in `config.js`.
4. In Authentication → URL Configuration, add your deployed website URL to Site URL and Redirect URLs.
5. For early testing, you may disable email confirmation, but turn it on before launch and configure SMTP.

## 2. Create database

Open Supabase SQL Editor and run `supabase/schema.sql`.

The current starter schema is at `schema.sql` in the repository root. Run it in the Supabase SQL Editor for a new project. For an existing project, do not rerun destructive SQL. Apply the additive migrations in `supabase/migrations/` in date order using the Supabase SQL Editor. The 20261124 migration adds currency fields; the 20261125 migration adds transaction dates (backfilled from each record's original entry date) and owner-only household deletion. These migrations preserve existing transaction records. Test with two separate accounts before launch.

## 3. Household invitations

The `invite-member` Edge Function is included under `supabase/functions/invite-member`.

Deploy it with Supabase CLI and set secrets:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `APP_ORIGIN` (the deployed app URL)

Then deploy:
`supabase functions deploy invite-member`

The function invites an email via Supabase Auth and adds them to the selected space. Do not expose the service-role key in frontend code.

## 4. Run locally

ES modules generally need a local web server, not `file://`. From this folder run:
`python -m http.server 8080`
Then visit `http://localhost:8080`.

You can also upload the folder to GitHub and enable GitHub Pages. Configure Supabase Auth redirect URLs to match the Pages URL.

## 5. Offline and recovery notes

The starter queues newly added transactions and essentials in browser localStorage while offline and retries when the connection returns. This is a basic best-effort queue, not a complete conflict-resolution system. The current queue does not yet cover edits/deletions, and clearing browser data can erase unsynced changes. Show users a pending-sync status and avoid treating a queued change as cloud-confirmed.

## 6. Before public launch: required work

- Add robust retry/idempotency and offline support for edits/deletes.
- Add conflict resolution and per-record sync metadata.
- Add password reset, email verification, account deletion and data export.
- Add invitation acceptance UX and invitation expiry/revocation.
- Add audit logs and stronger role management.
- Enable database backups / point-in-time recovery on an appropriate plan.
- Add rate limits, abuse protection, monitoring and error reporting.
- Review RLS with adversarial tests for cross-household and cross-user access.
- Add privacy policy, terms, retention policy and incident response.
- Perform independent security review before storing real financial data.

## Currency

The starter displays USD as a presentation default. Before launch, add a per-space currency setting and never aggregate unlike currencies without explicit conversion.
