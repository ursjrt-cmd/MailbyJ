# AERO.IST Mail Platform

A deployable single-service mail application with an aviation-inspired interface, Supabase Auth + Postgres + private Storage, and Resend for outbound delivery and inbound email webhooks.

This is an application codebase, not a standalone mail-transfer server. Supabase stores accounts, mailbox addresses, message copies, drafts and files. Resend handles delivery to/from the public email network. The domain must be verified and its DNS records must be configured before real external sending and receiving work. The Supabase login/recovery email is the account identity; after signing in, the user creates their separate AERO.IST mailbox address inside the app.

## Included

- Responsive AERO.IST webmail interface for desktop, tablet and mobile
- Supabase email/password sign-up, sign-in, session handling and password-reset email
- Create up to three domain mailboxes per user by default (limit configurable)
- Inbox, Starred, Sent, Drafts, Archive, Spam and Trash folders
- Search recent messages by sender, recipient, subject and preview
- Compose with To, Cc, Bcc, subject, rich-text basics and file attachments
- Save and edit drafts; send real email through Resend
- Receive messages via Resend `email.received` webhook and save them into the matching mailbox
- Reply, forward, mark read/unread, star/unstar, archive, move to spam/trash, restore and permanent deletion from Trash/Spam
- Private attachment storage and time-limited download URLs
- Profile display name and email signature settings
- Light/dark theme, mobile navigation and keyboard shortcuts (`C` compose, `/` search, `Ctrl/Cmd + Enter` send)
- Server health endpoint at `/api/health`

## Architecture

```text
Browser
  ├─ Supabase Auth (public/publishable key)
  └─ AERO.IST Node/Express API on Render
       ├─ verifies each Supabase access token
       ├─ uses the Supabase service-role key on the server only
       ├─ sends outbound mail using Resend API
       └─ receives signed Resend inbound webhooks
            └─ fetches email body/attachments and stores them in Supabase
```

**Never place `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY` or `RESEND_WEBHOOK_SECRET` in browser code or a public repository.** Only the Supabase anon/publishable key is exposed to the browser. The server reads the Supabase secret/service-role key privately and never returns it from `/api/config`.


## Fix: browser shows `Unexpected token 'N', "Not Found" is not valid JSON`

This specific browser error means the page requested `/api/config` and received a plain-text `Not Found` response instead of JSON. It is **not evidence that the Supabase URL or key is wrong**. The frontend is being served, but the matching Express API route is not reaching the browser. The most common cause is deploying the app as a Render **Static Site** or attaching `mail.aero.ist` to a different service.

This project is a full-stack Node.js application. It must run as a Render **Web Service** (Node), not as a Static Site.

### Check the existing Render service

1. Open the Render Dashboard and select the service currently serving `mail.aero.ist`.
2. Check the service type. If it is a **Static Site**, it cannot run `server.js` or this app's `/api/*` endpoints. Create a new service with **New → Web Service** and connect the same GitHub repository.
3. If it already is a **Web Service**, check its Settings and deploy the project folder that contains both `package.json` and `server.js`.
4. Use these settings:

| Render setting | Required value |
|---|---|
| Service type | Web Service |
| Runtime | Node |
| Node version | 20 or newer |
| Root Directory | `aero-mail-platform` if the repository contains this folder; otherwise leave blank if `package.json` is at repository root |
| Build Command | `npm install` |
| Start Command | `npm start` |
| Health Check Path | `/api/health` |

Do not enter `public` as the Root Directory and do not set a Static Site Publish Directory. The server serves files from `public` itself.

5. Add the environment variables from `.env.example` to this **Web Service** (environment variables on a different Render service are not shared automatically).
6. Deploy. In the deploy logs, look for `AERO.IST Mail listening on port ...`.
7. Test the service's `https://YOUR-SERVICE.onrender.com/api/config` URL first. It must return JSON containing `"backend":"node-express"`. Also test `/api/health`.
8. Once both work on the Render hostname, move `mail.aero.ist` from the old Static Site to this Web Service: remove the custom domain from the old service, then add it under the new Web Service's Settings → Custom Domains. Update the Hostinger `mail` CNAME only if Render shows a different target.

If `/api/config` returns valid JSON but reports missing Supabase settings, then configure `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and the server-only `SUPABASE_SECRET_KEY` (or the accepted legacy alternatives), then redeploy. The browser must never contain the server secret.

## 1. Create and configure Supabase

1. Create a Supabase project.
2. Open **SQL Editor** in the Supabase dashboard.
3. Paste the full contents of `schema.sql` and run it once.
4. In **Authentication → URL Configuration**, set the Site URL to `https://mail.aero.ist` (or your actual app URL). Add the same URL to the allowed redirect URLs.
5. In **Authentication → Providers → Email**, enable email/password sign-in. Keep email confirmation enabled for production. The user must confirm their login email before signing in if confirmation is required.
6. Configure a production SMTP sender under **Authentication → SMTP Settings** so account-verification and password-reset emails are reliably delivered; the app's Resend send endpoint does not replace Supabase Auth's own notification transport.
7. Copy the **Project URL** from your project's Connect dialog. Open **Settings → API Keys** and copy the **Publishable key** (`sb_publishable_...`) and **Secret key** (`sb_secret_...`). The app also accepts the legacy `anon` and `service_role` keys if your project still uses those.

The SQL creates the `profiles`, `mailboxes` and `mail_messages` tables, ownership policies, an Auth profile trigger, and a **private** `mail-attachments` Storage bucket with per-user folder policies.

## 2. Configure Resend for real email

1. Create a Resend account and add/verify the domain you will use for mailboxes.
2. For a safer initial configuration, use `inbox.aero.ist` as the mailbox domain. This keeps the existing `aero.ist` MX records untouched and does not overlap with the `mail.aero.ist` web application hostname.
3. In Resend, add `inbox.aero.ist` as a sending domain and enable inbound/receiving for it.
4. Add the exact SPF/DKIM and receiving MX records shown in your Resend dashboard to your DNS provider. DNS values vary by domain/region/account; do not copy guessed records from another domain.
5. In Resend → Webhooks, create a webhook endpoint:

   `https://mail.aero.ist/api/webhooks/resend`

   Subscribe to **`email.received`** and copy its signing secret (`whsec_...`).
6. Wait for domain/DNS verification to complete before testing external delivery.

Resend's inbound webhook notification contains message metadata. The app verifies the webhook signature, then calls Resend's Receiving API to retrieve the email body and attachments before saving them. This is intentional; the webhook payload alone is not the complete message.

### Want addresses ending exactly in `@aero.ist`?

After confirming you do not need the current root-domain MX provider, change:

```env
MAILBOX_DOMAIN=aero.ist
```

Then add/verify `aero.ist` in Resend and replace the root (`@`) MX records with the exact inbound MX record shown by Resend. **This routes all inbound mail for `@aero.ist` to Resend and may stop delivery to any existing email provider currently using that domain.** Do not make this change without planning the migration. The safer default in this package is `inbox.aero.ist`.

## 3. Deploy to Render

1. Upload this folder to a private GitHub repository (or your Git provider).
2. In Render, choose **New → Web Service** and connect the repository.
3. Use these settings:
   - Runtime: **Node**
   - Build command: `npm install`
   - Start command: `npm start`
   - Health check path: `/api/health`
4. Add these environment variables in Render (Environment → Add Environment Variable):

| Key | Value |
|---|---|
| `NODE_ENV` | `production` |
| `APP_URL` | `https://mail.aero.ist` |
| `MAILBOX_DOMAIN` | `inbox.aero.ist` |
| `SUPABASE_URL` | Your Supabase Project URL |
| `SUPABASE_PUBLISHABLE_KEY` | Your Supabase publishable key (`sb_publishable_...`) |
| `SUPABASE_SECRET_KEY` | Your Supabase secret key (`sb_secret_...`), server only |
| `RESEND_API_KEY` | Your Resend API key |
| `RESEND_WEBHOOK_SECRET` | Your Resend webhook signing secret |
| `MAX_MAILBOXES_PER_USER` | `3` |
| `MAX_ATTACHMENT_MB` | `20` |

5. Deploy the service. Confirm `https://mail.aero.ist/api/health` returns JSON with `supabase: "configured"` and `resend: "configured"`.
6. Add `mail.aero.ist` as a custom domain for the Render service and create the exact DNS record Render instructs you to create. The web app hostname is separate from the mailbox subdomain `inbox.aero.ist`, so their DNS records do not collide.

You can also use `render.yaml` as a starting Blueprint. Secret values still need to be entered in the Render dashboard; they are deliberately not included in the repository.

## 4. Test end-to-end

1. Open `https://mail.aero.ist` and create a login account.
2. Confirm the login email if Supabase email confirmation is enabled.
3. Sign in and create a mailbox such as `jaki@inbox.aero.ist`.
4. Send a test message to an external address you control. Confirm it appears in the Sent folder and reaches the destination inbox (also check spam).
5. Reply to that message from the external account.
6. Confirm the Resend webhook receives it and that it appears in the AERO.IST Inbox with its body and any attachments.
7. Test draft saving, starring, archive, Trash, restore and attachment downloads.

## Environment variables

See `.env.example`. For local development, copy it to `.env`, enter real credentials, then run:

```bash
npm install
npm run dev
```

Do not commit `.env`.

## Important implementation boundaries

This version provides a practical webmail core, but it is not a complete replacement for the entire Gmail/Outlook/Zoho infrastructure. In particular:

- It uses Resend's API + receiving webhooks, not a self-hosted SMTP/IMAP/POP server. Users read mail in this web app; they cannot connect the mailbox to desktop/mobile clients over IMAP/POP in this version.
- Mailbox addresses are app-managed addresses on one configured domain. This code does not provision DNS or create independent provider mailboxes automatically.
- Domain verification, MX/SPF/DKIM, reverse DNS and provider account limits must be configured outside the app. Sending is subject to the mail provider's account limits and acceptable-use rules.
- The current search scans up to the latest 200 messages in a folder. Large-scale search, indexing and pagination should be added before operating at high volume.
- Attachment sending is capped by `MAX_ATTACHMENT_MB` (20 MB by default). A separate private bucket policy is applied to files; no attachment is made public.
- This release does not include enterprise compliance/archive retention, end-to-end encryption, spam-model training, advanced rules/filters, calendar, contacts sync, delegated/shared mailboxes, message scheduling, or SMTP/IMAP/POP access.

Before opening public registration, add CAPTCHA/bot protection, abuse monitoring, sending quotas per user, account suspension/admin tooling, bounce/complaint processing, data retention/deletion workflows, backups, monitoring and a tested incident-response process. Configure Supabase Auth rate limits and Resend sending limits. Review your privacy policy and terms before allowing public accounts.

## Troubleshooting

- **Supabase configuration warning**: open `https://mail.aero.ist/api/health` and check `supabaseMissing`. Add each listed variable to the correct Render web service, then choose **Save, rebuild, and deploy**. Recommended keys are `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and server-only `SUPABASE_SECRET_KEY`; legacy `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are also accepted.
- **`Sending is not configured`**: set `RESEND_API_KEY` and make sure the mailbox domain is verified for sending.
- **Mail sends but is not received by the app**: confirm the receiving MX record is correct, receiving is enabled for the domain, the webhook endpoint is public, `email.received` is selected and `RESEND_WEBHOOK_SECRET` matches the webhook.
- **Webhook returns 400**: the signing secret may be wrong, the payload may be altered by a proxy, or the event may not be signed by the configured endpoint. This app verifies the original raw request body.
- **Attachments fail**: confirm `schema.sql` ran successfully, the private `mail-attachments` bucket exists, and the user-owned Storage policies were created.
- **Emails land in spam**: verify SPF/DKIM records and domain reputation; start with low volume and test multiple recipient providers.

## Security notes

- Supabase RLS is enabled for every public application table.
- The browser never receives the service-role/secret key.
- Authenticated API requests are verified against Supabase Auth on the server.
- Mailbox/message operations are scoped to the signed-in owner.
- The inbound Resend webhook is signature-verified using the original raw body.
- Attachment bucket is private; the application generates five-minute signed download URLs after checking the user's folder prefix.
- Incoming HTML is sanitised before it is shown in the reading pane. Remote images are blocked in this first release to reduce tracking-pixel exposure.


## Supabase “Unregistered API key” troubleshooting

See [SUPABASE_KEY_FIX.md](./SUPABASE_KEY_FIX.md) for exact steps to correct a mismatched or wrong-type API key in Render.
