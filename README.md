# AERO MAIL — Free-stack edition for `@aero.ist`

Aero Mail Free is a custom-domain **webmail application** designed to run without a VPS:

- **GitHub** stores the source code.
- **Render Static Sites** serves the web interface over HTTPS for free.
- **Supabase** provides user authentication, PostgreSQL message storage, private attachments and Edge Functions.
- **Resend** sends outbound email through an HTTPS API (free plan currently lists 3,000 emails/month and a 100/day limit).
- **Cloudflare Email Routing + a Worker** receives inbound mail and streams it to a protected Supabase Edge Function.

This is designed for an initial, low-volume webmail service. It does **not** run a conventional SMTP/IMAP/POP mailbox server. Users read mail in the Aero Mail website; they cannot connect `@aero.ist` to Outlook, Apple Mail or Thunderbird using IMAP/POP. For full standards-based mail hosting, use a real mail server/provider later.

## 1. Create the free accounts

Create accounts at:

- GitHub: <https://github.com/signup>
- Supabase: <https://supabase.com/dashboard>
- Render: <https://dashboard.render.com/register>
- Cloudflare: <https://dash.cloudflare.com/sign-up>
- Resend: <https://resend.com/signup>

The domain `aero.ist` must be yours and you must be able to change its nameservers and DNS records.

## 2. Put this project on GitHub

1. Download the Aero Mail Free ZIP.
2. In GitHub, create a new **private** repository named `aero-mail`.
3. Upload the extracted project files and folders to the repository root (not the ZIP file itself).
4. Commit the files to the `main` branch.
5. Keep `public/config.js` with placeholders until you create your Supabase project. Its two browser values are public by design. Never place secrets there.

You can also use Git locally:

```bash
git init
git add .
git commit -m "Initial Aero Mail free stack"
git branch -M main
git remote add origin https://github.com/YOUR-ACCOUNT/aero-mail.git
git push -u origin main
```

## 3. Create your Supabase project and database

1. Create a Supabase project using the Free plan.
2. Choose a strong database password and save it in your password manager.
3. Open **SQL Editor → New query**.
4. Copy the complete contents of `supabase/schema.sql` and run it.
5. Open **Project Settings → API** and copy the Project URL and publishable/anon key.
6. Edit `public/config.js` in your GitHub repository (the current build reads `SUPABASE_PUBLISHABLE_KEY`; `SUPABASE_ANON_KEY` remains supported for older setups):

```js
window.AERO_CONFIG = {
  SUPABASE_URL: "https://YOUR-PROJECT-REF.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "YOUR_PUBLIC_PUBLISHABLE_OR_ANON_KEY",
  MAIL_DOMAIN: "aero.ist",
  AUTH_REDIRECT_URL: "https://mail.aero.ist/"
};
```

The publishable/anon key is intended for the browser; database access is protected by Row Level Security. Use the newer `sb_publishable_...` key when your Supabase dashboard offers it; the legacy anon key also works. The app rejects secret/service-role keys and gives a clear configuration message when the API key is malformed. **Never put the `sb_secret_` key, `service_role` key, Resend API key, or Cloudflare secret in `public/config.js`.**

Supabase Free currently includes 500 MB database storage and 1 GB file storage, and pauses free projects after one week of inactivity. Check the live quota before opening signups broadly: <https://supabase.com/pricing>.

## 4. Configure outbound email with Resend

1. Create a Resend account.
2. Go to **Domains → Add Domain** and add `aero.ist`.
3. Resend will show the exact DNS records required to authenticate your domain. Add those exact DKIM/SPF records at your DNS host. Do not invent or copy another domain's DKIM key.
4. Wait until Resend shows the domain as verified.
5. Create a Resend API key with sending permission. Keep it private.
6. In Supabase **Authentication → URL Configuration**, set the **Site URL** to `https://mail.aero.ist`. Add `https://mail.aero.ist/**` and your temporary `https://YOUR-RENDER-SITE.onrender.com/**` to **Redirect URLs**. The app explicitly requests `https://mail.aero.ist/` for signup confirmation and password-reset redirects.
7. Open Supabase **Authentication → SMTP Settings** and enable custom SMTP for signup confirmation and password recovery. Resend's published SMTP settings are: host `smtp.resend.com`, port `465`, username `resend`, password your Resend API key; use a sender address such as `no-reply@aero.ist` that belongs to your verified domain. See <https://resend.com/features/smtp-service> and <https://supabase.com/docs/guides/auth/auth-smtp>.

8. In **Authentication → Email Templates → Confirm signup**, make sure the confirmation button uses Supabase's generated confirmation URL, for example `<a href="{{ .ConfirmationURL }}">Confirm my Aero Mail account</a>`. Do not hard-code `http://localhost`, an old `webmail.aero.ist` host, or a custom callback route that this static site does not provide. The browser client explicitly sends `emailRedirectTo: https://mail.aero.ist/`.

**Important:** if the site still displays **“Unregistered API key”**, open **Project Settings → API Keys** and copy the Project URL and the **Publishable key** (`sb_publishable_...`) from the same Supabase project into `public/config.js`. The legacy `anon` key is also accepted. This error means the Supabase API gateway does not recognize the key sent to that project URL; changing the login form or password cannot repair a mismatched/incorrect key. Never put an `sb_secret_` or `service_role` key in browser code.

The send-email function uses the Resend HTTPS API, so it does not need SMTP ports on Render. Resend's current Free plan lists 3,000 emails/month, up to 100/day and 3 custom domains; provider eligibility, account review, and sending policies still apply: <https://resend.com/pricing>.

## 5. Deploy Supabase Edge Functions

Install the Supabase CLI in this project and log in on your computer. From the project root:

```bash
npm install --save-dev supabase
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
```

Supabase automatically injects the project URL and server-side runtime keys into Edge Functions. This code supports the newer `SUPABASE_PUBLISHABLE_KEYS` / `SUPABASE_SECRET_KEYS` environment variables (the default key in each JSON object) and legacy `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` fallbacks. You do not need to paste these keys into function secrets. The secret/service-role key is never added to browser files or GitHub. Generate a long random ingest secret (at least 32 random bytes). Example command:

```bash
openssl rand -hex 32
```

Set the application secrets server-side (replace the placeholders in your terminal):

```bash
npx supabase secrets set RESEND_API_KEY=re_xxxxxxxxx MAIL_DOMAIN=aero.ist AERO_INGEST_SECRET=PASTE_RANDOM_SECRET
```

Deploy both functions:

```bash
npx supabase functions deploy send-email
npx supabase functions deploy email-ingest --no-verify-jwt
```

`send-email` requires a logged-in Supabase user JWT. `email-ingest` has JWT verification disabled only because Cloudflare calls it server-to-server; it verifies the private `AERO_INGEST_SECRET` header instead.

## 6. Configure Cloudflare inbound email

Cloudflare Email Routing supports inbound forwarding to Workers on its Free and Paid plans. The worker in `cloudflare-worker/` uses the routing email handler, not an SMTP daemon.

1. Add `aero.ist` to Cloudflare and change the nameservers at your domain registrar to the exact Cloudflare nameservers shown for your zone.
2. In Cloudflare, enable **Email Routing** for `aero.ist`. Let Cloudflare add its required MX and related DNS records. Do not delete those MX records after enabling routing.
3. Install Node.js on your computer if required, then deploy the worker:

```bash
cd cloudflare-worker
npm install
npx wrangler login
npx wrangler secret put SUPABASE_INGEST_URL
```

For `SUPABASE_INGEST_URL`, enter:

```text
https://YOUR-PROJECT-REF.supabase.co/functions/v1/email-ingest
```

Set the same ingest secret that you set in Supabase:

```bash
npx wrangler secret put AERO_INGEST_SECRET
```

Then deploy:

```bash
npx wrangler deploy
```

The `wrangler.toml` declares `*@aero.ist` as a catch-all address. With Wrangler 4.113.0 or later, deployment manages the Cloudflare Email Routing catch-all rule and routes it to this Worker. Review the planned rule changes in the CLI output. Do not enable a second catch-all rule that conflicts with this one.

Cloudflare's official routing documentation: <https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/>. The Worker receives the raw MIME stream and sends it to the Supabase ingest function: <https://developers.cloudflare.com/email-service/api/route-emails/email-handler/>.

## 7. Deploy the website free on Render

1. Sign in to Render.
2. Choose **New → Static Site**.
3. Connect GitHub and select your `aero-mail` repository.
4. Set:
   - Branch: `main`
   - Build command: leave empty
   - Publish directory: `public`
5. Click **Create Static Site**.
6. When it finishes, test the generated `*.onrender.com` address.
7. In Render → Settings → Custom Domains, add `mail.aero.ist`.
8. At Cloudflare DNS, add the exact CNAME/target Render shows. Keep the proxy mode as instructed by Render during verification. Render provides free managed TLS for static sites and redeploys when you push changes to GitHub.

Render's official static-site docs: <https://render.com/docs/static-sites>.

## 8. DNS checklist for `aero.ist`

DNS values differ by account, so use the live values shown in each dashboard. Do not guess MX, DKIM, verification TXT, or CNAME targets.

| DNS item | Purpose | Where to get exact value |
|---|---|---|
| Cloudflare MX records at `@` | Receive mail for `@aero.ist` | Cloudflare Email Routing setup |
| Cloudflare Worker catch-all `*@aero.ist` | Send all inbound messages to app ingest | `wrangler.toml` and Wrangler deploy |
| Resend DKIM record(s) | Authenticate outbound messages | Resend → Domains → `aero.ist` |
| Resend SPF TXT record | Authorize outbound sending | Resend → Domains → `aero.ist` |
| DMARC TXT at `_dmarc` | Publish domain policy/reporting | Start with `v=DMARC1; p=none; rua=mailto:dmarc@aero.ist` only if that mailbox exists and can receive reports |
| `mail` CNAME | Open the web app | Render → Custom Domains |

**Important SPF note:** a domain should have one SPF TXT record. If Cloudflare/other mail senders already publish SPF, merge authorized senders into one valid record using the exact Resend instructions. Do not add two separate SPF records.

## 9. Create your first Aero address and test it

1. Open `https://mail.aero.ist` (or the temporary Render URL before custom-domain setup).
2. Choose **Create account**.
3. Enter a recovery email you control, a strong password, your display name and a local part such as `hello`.
4. Verify the recovery email if Supabase email confirmation is enabled, then sign in.
5. The app creates `hello@aero.ist` in Supabase.
6. Send a test message to an external address. The sender must use the verified `aero.ist` domain and remain within Resend quotas.
7. Reply to `hello@aero.ist` from the external account. Cloudflare Email Routing should deliver it to the Worker, which stores it in the Supabase inbox.

## What this free edition supports

- Supabase sign-up, sign-in, recovery email and password reset flow.
- One `@aero.ist` webmail address per Supabase user.
- Send messages with To/Cc, subject, text and up to five small attachments (8 MB each; 12 MB total for outbound; inbound raw message limit 14 MB).
- Receive emails into the web inbox using Cloudflare Email Routing and its Worker.
- Inbox, Sent, Starred, Drafts (folder is reserved for future draft-saving), Archive, Spam and Trash views; read/unread, star, archive and trash actions.
- Private Supabase Storage attachments with signed download links.
- Mobile-responsive Aero aerospace-inspired web UI.

## Important limits and production considerations

- **Not an IMAP/POP mailbox server:** addresses work through this Aero Mail website only. This is not a drop-in replacement for a traditional mailbox host with IMAP/POP/SMTP credentials.
- **Free tiers are not an uptime guarantee:** Render static sites are free, but Supabase Free projects can pause after one week inactive and have small database/storage quotas. Render free *web services* (not used by this static-site architecture) sleep after 15 minutes and cannot send outbound SMTP on ports 25, 465 or 587. See <https://render.com/docs/free>.
- **Sending limits:** Resend currently lists 3,000 emails/month and 100/day on Free. It may also apply account/domain verification and abuse-prevention controls.
- **Inbound is not filtered like a full mail server:** Cloudflare performs sender authentication checks, but this starter has no advanced spam quarantine, antivirus scanning, mailbox aliases/admin console, mail retention controls, or IMAP protocol support. Do not use it for sensitive or regulated communications without a security review.
- **Email addresses are limited to one per authenticated recovery account** in this starter. The SQL prevents users from claiming an address that is already taken.
- **Storage and backups:** Supabase Free is a small starter tier. Export data, keep off-site backups, and check limits before inviting more users.

## Troubleshooting

- **Signup fails:** verify Supabase URL/key in `public/config.js`; check Auth URL configuration and SMTP settings.
- **Cannot create address:** ensure `supabase/schema.sql` ran completely and the user is signed in.
- **Send fails:** verify `RESEND_API_KEY`, `aero.ist` domain verification, sender identity, daily/monthly quota, and Edge Function logs.
- **Incoming mail does not appear:** verify Cloudflare nameservers, Email Routing MX records, active `*@aero.ist` catch-all Worker route, Wrangler secrets, Supabase `email-ingest` logs and mailbox spelling.
- **Attachment fails:** check Supabase Storage bucket and 8 MB file limit; retry with a smaller file.
- **Website does not connect:** confirm Render static-site publish directory is `public` and `public/config.js` contains the correct public Supabase URL and anon/publishable key.

Never send passwords, API keys, service-role credentials, database passwords or Cloudflare secrets in chat or commit them to GitHub.
