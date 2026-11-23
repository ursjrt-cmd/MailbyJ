# Fix: Supabase says “Unregistered API key”

This is an API-key rejection from Supabase. It is not fixed by changing DNS. Most often the key is from a different Supabase project, the wrong key type was copied, or an older duplicate environment variable is taking precedence.

## 1. Copy URL and keys from one project

1. Open https://supabase.com/dashboard and select the project used by AERO.IST Mail.
2. Copy its Project URL from the project's Connect dialog (format: `https://PROJECT_REF.supabase.co`).
3. Open Project Settings → API Keys.
4. Under Publishable and secret API keys, copy the **Publishable key** (`sb_publishable_...`) and the **Secret key** (`sb_secret_...`). If the project has no new keys yet, use Create new API keys.

The URL, publishable key, and secret key must all come from that exact same project.

## 2. Correct Render environment

In Render → AERO.IST Mail Web Service → Environment, set:

| Variable | Value |
|---|---|
| `SUPABASE_URL` | `https://PROJECT_REF.supabase.co` |
| `SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_...` |
| `SUPABASE_SECRET_KEY` | `sb_secret_...` |

Do not put the secret key in the publishable variable. Never add the secret key to the frontend or GitHub.

Delete stale duplicate values if present, especially `SUPABASE_PUBLISHABLE_KEY` when you intend to use `SUPABASE_ANON_KEY`, or vice versa. This app checks `SUPABASE_PUBLISHABLE_KEY` before `SUPABASE_ANON_KEY`, so a wrong non-empty publishable value will take precedence. Prefer setting only the three variables in the table above.

## 3. Legacy-key option

If you are deliberately using legacy credentials from the same project, set `SUPABASE_ANON_KEY` to that project's legacy **anon/public** key and `SUPABASE_SERVICE_ROLE_KEY` to its legacy **service_role** key. Remove `SUPABASE_PUBLISHABLE_KEY` and `SUPABASE_SECRET_KEY` if they contain stale or unrelated values. The legacy keys remain supported alongside the new keys during migration.

## 4. Save and redeploy

Save the Render environment, trigger a new deployment, then visit:

- `https://mail.aero.ist/api/health`
- `https://mail.aero.ist/api/config`

The diagnostic reports the public key format (`publishable` or `legacy_anon`) without exposing a secret. If the login still says “Unregistered API key”, re-check that the Project URL and Publishable key were copied from the same Supabase project and that no duplicate/stale key variable remains in Render.

## Security

Do not send screenshots containing full API keys, `sb_secret_...`, `service_role`, database passwords, or Resend secrets. The publishable key is designed for browser use, but there is no need to post it publicly.
