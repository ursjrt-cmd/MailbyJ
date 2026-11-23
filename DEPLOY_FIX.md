# AERO.IST Mail — Render API 404 Fix

Your screenshot showed `Unexpected token 'N', "Not Found" is not valid JSON`. That means the browser fetched `/api/config`, but the server returned plain text `Not Found`. The page is visible, but the backend API is not connected to the same Render service. Adding Supabase keys alone will not fix this.

## Correct Render service type

This project is a full-stack Node.js/Express application. It must be deployed as a **Web Service**, not a **Static Site**.

1. Open Render Dashboard and inspect the service currently attached to `mail.aero.ist`.
2. If the service type is **Static Site**, create another service: **New → Web Service**, then connect the GitHub repository containing this project. If it is already a Web Service, edit its settings and verify the project root.
3. Configure it as follows:

| Setting | Value |
|---|---|
| Runtime | Node |
| Node version | 20 or newer |
| Root Directory | `aero-mail-platform` only if that folder contains `package.json` in your GitHub repository; otherwise leave blank |
| Build Command | `npm install` |
| Start Command | `npm start` |
| Health Check Path | `/api/health` |

Do not set a Static Site Publish Directory. Do not use `public` as the Root Directory. The Express server serves the `public` folder itself.

4. Add the app's environment variables to this Web Service (they are not shared automatically between Render services): `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `APP_URL`, and `MAILBOX_DOMAIN`. Use actual secret values from your own dashboards. Keep `SUPABASE_SECRET_KEY`, `RESEND_API_KEY`, and `RESEND_WEBHOOK_SECRET` private.
5. Deploy. In Render's logs, confirm that the service prints `AERO.IST Mail listening on port ...`.
6. Test `https://YOUR-SERVICE.onrender.com/api/config`. It must return JSON containing `"backend":"node-express"`; `/api/health` should also return JSON.
7. After those URLs work, move the custom domain `mail.aero.ist` from the old Static Site to the new Web Service: remove the domain from the old service, then add it in the new Web Service's **Settings → Custom Domains**. Copy the DNS target Render shows. Update Hostinger's `mail` CNAME only if Render gives a different target.
8. Open `https://mail.aero.ist/api/config`. Once JSON appears, remaining Supabase configuration errors can be fixed using the `supabaseMissing` list.

## What the updated source changes

- Detects a plain-text or HTML `Not Found` response instead of throwing an unreadable JSON parsing error.
- Explains the likely Render service-type/routing issue on the startup screen.
- Returns JSON for unknown `/api/*` routes when the Express backend is running.
- Exposes a non-secret `backend: node-express` marker from `/api/config` and `/api/health`.
- Binds Express to `0.0.0.0` and Render's `PORT`.

The source update does not change Render settings automatically. You must deploy the updated code to the Web Service and attach the domain to that service.
