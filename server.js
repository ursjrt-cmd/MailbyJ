import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = Number(process.env.PORT || 10000);
const MAILBOX_DOMAIN = String(process.env.MAILBOX_DOMAIN || 'inbox.aero.ist').trim().toLowerCase().replace(/^@/, '');
const STORAGE_BUCKET = 'mail-attachments';
const MAX_MAILBOXES = Math.min(20, Math.max(1, Number(process.env.MAX_MAILBOXES_PER_USER || 3)));
const MAX_ATTACHMENT_MB = Math.min(25, Math.max(1, Number(process.env.MAX_ATTACHMENT_MB || 20)));
const MAX_ATTACHMENT_BYTES = MAX_ATTACHMENT_MB * 1024 * 1024;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_PUBLIC_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
const hasSupabase = Boolean(SUPABASE_URL && SUPABASE_PUBLIC_KEY && SUPABASE_SERVICE_KEY);
const hasResend = Boolean(process.env.RESEND_API_KEY);

const supabaseAdmin = hasSupabase
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }
    })
  : null;
const supabaseAuth = hasSupabase
  ? createClient(SUPABASE_URL, SUPABASE_PUBLIC_KEY, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }
    })
  : null;
const resend = hasResend ? new Resend(process.env.RESEND_API_KEY) : null;

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
      connectSrc: ["'self'", 'https://*.supabase.co', 'wss://*.supabase.co', 'https://api.resend.com'],
      frameSrc: ["'self'", 'blob:'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));
app.use(express.json({
  limit: `${MAX_ATTACHMENT_MB + 8}mb`,
  verify: (req, _res, buffer) => {
    if (req.originalUrl.split('?')[0] === '/api/webhooks/resend') req.rawBody = Buffer.from(buffer);
  }
}));

const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 500, standardHeaders: 'draft-7', legacyHeaders: false });
const sendLimiter = rateLimit({ windowMs: 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false });
app.use('/api', apiLimiter);

function requireServices(req, res, next) {
  if (!hasSupabase) return res.status(503).json({ error: 'Supabase is not configured. Add SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY.' });
  next();
}

function authRequired(req, res, next) {
  return requireServices(req, res, async () => {
    try {
      const authHeader = req.get('authorization') || '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
      if (!token) return res.status(401).json({ error: 'Please sign in to continue.' });
      const { data, error } = await supabaseAuth.auth.getUser(token);
      if (error || !data?.user) return res.status(401).json({ error: 'Your session is invalid or expired. Please sign in again.' });
      req.user = data.user;
      next();
    } catch (error) {
      console.error('Authentication error:', error.message);
      res.status(401).json({ error: 'Authentication failed.' });
    }
  });
}

function cleanText(value, max = 5000) {
  return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, max);
}
function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}
function isEmail(value) {
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(String(value || ''));
}
function extractEmail(value) {
  const match = String(value || '').match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? normalizeEmail(match[0]) : '';
}
function addressObject(value) {
  const raw = String(value || '').trim();
  const email = extractEmail(raw);
  const name = raw.includes('<') ? raw.slice(0, raw.indexOf('<')).replace(/["']/g, '').trim() : '';
  return email ? { email, name } : null;
}
function recipientList(input) {
  const values = Array.isArray(input) ? input : String(input || '').split(/[;,\n]+/);
  const result = [];
  for (const value of values) {
    const addr = typeof value === 'object' && value?.email ? { email: normalizeEmail(value.email), name: cleanText(value.name, 120) } : addressObject(value);
    if (!addr) continue;
    if (!isEmail(addr.email)) throw new Error(`Invalid email address: ${addr.email}`);
    if (!result.some(item => item.email === addr.email)) result.push(addr);
  }
  if (result.length > 50) throw new Error('A message can have at most 50 recipients in each recipient field.');
  return result;
}
function parseInboundAddresses(input) {
  const values = Array.isArray(input) ? input : [input];
  return values.map(addressObject).filter(Boolean);
}
function toPlainText(html) {
  return String(html || '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n/g, '\n\n').trim();
}
function makeSnippet(text, html) {
  return cleanText(text || toPlainText(html), 280).replace(/\s+/g, ' ');
}
function safeFileName(value) {
  const name = path.basename(String(value || 'attachment')).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 140);
  return name || 'attachment';
}
function jsonError(res, error, status = 400) {
  console.error(error);
  return res.status(status).json({ error: error?.message || 'Something went wrong.' });
}
async function ensureProfile(user) {
  const displayName = cleanText(user.user_metadata?.full_name || user.user_metadata?.name || user.email?.split('@')[0] || 'AERO.IST User', 120);
  const { error } = await supabaseAdmin.from('profiles').upsert({ id: user.id, email: normalizeEmail(user.email), display_name: displayName }, { onConflict: 'id' });
  if (error) throw error;
}
async function getOwnedMailbox(userId, mailboxId) {
  if (!mailboxId) throw new Error('Select a mailbox first.');
  const { data, error } = await supabaseAdmin.from('mailboxes').select('*').eq('id', mailboxId).eq('owner_id', userId).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('Mailbox not found or you do not have access to it.');
  return data;
}
async function getOwnedMessage(userId, messageId) {
  const { data, error } = await supabaseAdmin.from('mail_messages').select('*').eq('id', messageId).eq('owner_id', userId).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('Message not found.');
  return data;
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    app: 'AERO.IST Mail',
    supabase: hasSupabase ? 'configured' : 'missing_configuration',
    resend: hasResend ? 'configured' : 'missing_configuration',
    mailboxDomain: MAILBOX_DOMAIN,
    time: new Date().toISOString()
  });
});
app.get('/api/config', (_req, res) => {
  res.json({ supabaseUrl: SUPABASE_URL || '', supabaseAnonKey: SUPABASE_PUBLIC_KEY || '', mailboxDomain: MAILBOX_DOMAIN, maxAttachmentMB: MAX_ATTACHMENT_MB, appName: 'AERO.IST Mail' });
});

// Resend webhook must receive the exact raw body for signature verification.
app.post('/api/webhooks/resend', async (req, res) => {
  if (!hasSupabase || !hasResend || !process.env.RESEND_WEBHOOK_SECRET) {
    return res.status(503).send('Mail receiving is not configured.');
  }
  try {
    const rawPayload = Buffer.isBuffer(req.rawBody) ? req.rawBody.toString('utf8') : '';
    const event = resend.webhooks.verify({
      payload: rawPayload,
      headers: {
        'svix-id': req.get('svix-id'),
        'svix-timestamp': req.get('svix-timestamp'),
        'svix-signature': req.get('svix-signature')
      },
      secret: process.env.RESEND_WEBHOOK_SECRET
    });
    if (event.type !== 'email.received') return res.status(200).send('Event ignored.');

    const emailId = event.data?.email_id;
    if (!emailId) return res.status(200).send('No receiving email ID.');
    const { data: received, error: receiveError } = await resend.emails.receiving.get(emailId);
    if (receiveError) throw receiveError;

    const eventData = event.data || {};
    const toRecipients = parseInboundAddresses(received?.to || eventData.to);
    const ccRecipients = parseInboundAddresses(received?.cc || eventData.cc);
    const bccRecipients = parseInboundAddresses(received?.bcc || eventData.bcc);
    // Route direct, carbon-copy and blind-carbon-copy recipients to their own mailboxes.
    const recipientEmails = [...new Set([...toRecipients, ...ccRecipients, ...bccRecipients].map(item => item.email))];
    if (!recipientEmails.length) return res.status(200).send('No valid recipients.');

    const { data: boxes, error: boxError } = await supabaseAdmin
      .from('mailboxes').select('id, owner_id, email, display_name').in('email', recipientEmails);
    if (boxError) throw boxError;
    if (!boxes?.length) return res.status(200).send('No matching AERO.IST mailbox.');

    // Avoid duplicate records and orphaned attachment copies when the provider retries a webhook.
    const { data: alreadySaved, error: duplicateError } = await supabaseAdmin
      .from('mail_messages').select('mailbox_id').eq('provider_email_id', emailId).in('mailbox_id', boxes.map(box => box.id));
    if (duplicateError) throw duplicateError;
    const savedMailboxIds = new Set((alreadySaved || []).map(row => row.mailbox_id));
    const boxesToProcess = boxes.filter(box => !savedMailboxIds.has(box.id));
    if (!boxesToProcess.length) return res.status(200).send('Inbound email already saved.');

    let attachmentRows = [];
    let inboundAttachmentBytes = 0;
    try {
      const { data: attachmentResult, error: attachmentError } = await resend.emails.receiving.attachments.list({ emailId });
      if (!attachmentError) {
        const rows = Array.isArray(attachmentResult) ? attachmentResult : (attachmentResult?.data || []);
        for (const item of rows) {
          if (!item.download_url) continue;
          try {
            const fileResponse = await fetch(item.download_url);
            if (!fileResponse.ok) continue;
            const arrayBuffer = await fileResponse.arrayBuffer();
            if (arrayBuffer.byteLength > MAX_ATTACHMENT_BYTES || inboundAttachmentBytes + arrayBuffer.byteLength > MAX_ATTACHMENT_BYTES) continue;
            inboundAttachmentBytes += arrayBuffer.byteLength;
            const bytes = Buffer.from(arrayBuffer);
            const fileName = safeFileName(item.filename || 'attachment');
            // Each received attachment is copied into this mailbox owner's private Storage folder.
            // If several mailboxes receive the same email, each owner gets a separate private copy.
            attachmentRows.push({ source: item, fileName, bytes, contentType: item.content_type || 'application/octet-stream' });
          } catch (fileError) {
            console.warn('Inbound attachment skipped:', fileError.message);
          }
        }
      }
    } catch (attachmentError) {
      console.warn('Could not retrieve inbound attachments:', attachmentError.message);
    }

    const fromAddress = addressObject(received?.from || eventData.from) || { email: 'unknown@unknown.invalid', name: '' };
    const subject = cleanText(received?.subject || eventData.subject || '(no subject)', 998);
    const html = String(received?.html || '');
    const text = String(received?.text || toPlainText(html));
    const createdAt = received?.created_at || eventData.created_at || new Date().toISOString();

    for (const box of boxesToProcess) {
      const storedAttachments = [];
      for (const attachment of attachmentRows) {
        const storagePath = `${box.owner_id}/inbound/${crypto.randomUUID()}_${attachment.fileName}`;
        const { error: uploadError } = await supabaseAdmin.storage.from(STORAGE_BUCKET).upload(storagePath, attachment.bytes, {
          contentType: attachment.contentType, upsert: false
        });
        if (!uploadError) storedAttachments.push({ filename: attachment.fileName, content_type: attachment.contentType, size: attachment.bytes.length, path: storagePath });
        else console.warn('Could not store inbound attachment:', uploadError.message);
      }

      const message = {
        owner_id: box.owner_id,
        mailbox_id: box.id,
        provider_email_id: emailId,
        message_id: cleanText(received?.message_id || eventData.message_id, 998) || null,
        thread_id: cleanText(received?.message_id || eventData.message_id, 998) || emailId,
        direction: 'inbound', folder: 'inbox',
        from_email: fromAddress.email,
        from_name: fromAddress.name,
        to_recipients: toRecipients,
        cc_recipients: ccRecipients,
        bcc_recipients: bccRecipients,
        subject,
        body_text: text,
        body_html: html,
        snippet: makeSnippet(text, html),
        attachments: storedAttachments,
        is_read: false,
        is_starred: false,
        created_at: createdAt,
        received_at: createdAt
      };
      const { error: insertError } = await supabaseAdmin.from('mail_messages').upsert(message, {
        onConflict: 'mailbox_id,provider_email_id', ignoreDuplicates: true
      });
      if (insertError) throw insertError;
    }
    return res.status(200).send('Inbound email saved.');
  } catch (error) {
    console.error('Resend webhook failed:', error);
    return res.status(400).send('Webhook verification or processing failed.');
  }
});

app.get('/api/me', authRequired, async (req, res) => {
  try {
    await ensureProfile(req.user);
    const [{ data: profile, error: profileError }, { data: mailboxes, error: mailboxError }] = await Promise.all([
      supabaseAdmin.from('profiles').select('*').eq('id', req.user.id).maybeSingle(),
      supabaseAdmin.from('mailboxes').select('*').eq('owner_id', req.user.id).order('created_at', { ascending: true })
    ]);
    if (profileError) throw profileError;
    if (mailboxError) throw mailboxError;
    res.json({ user: { id: req.user.id, email: req.user.email }, profile, mailboxes: mailboxes || [] });
  } catch (error) { jsonError(res, error, 500); }
});

app.post('/api/mailboxes', authRequired, async (req, res) => {
  try {
    const localPart = cleanText(req.body?.localPart, 32).toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9._-]{1,28}[a-z0-9])$/.test(localPart) || localPart.includes('..')) {
      return res.status(400).json({ error: 'Choose 3–30 characters using letters, numbers, dots, underscores or hyphens. Start and end with a letter or number.' });
    }
    const { count, error: countError } = await supabaseAdmin.from('mailboxes').select('id', { count: 'exact', head: true }).eq('owner_id', req.user.id);
    if (countError) throw countError;
    if ((count || 0) >= MAX_MAILBOXES) return res.status(403).json({ error: `Your account can create up to ${MAX_MAILBOXES} mailboxes.` });

    const email = `${localPart}@${MAILBOX_DOMAIN}`;
    const displayName = cleanText(req.body?.displayName, 80) || localPart;
    const { data, error } = await supabaseAdmin.from('mailboxes').insert({ owner_id: req.user.id, email, display_name: displayName, domain: MAILBOX_DOMAIN }).select('*').single();
    if (error?.code === '23505') return res.status(409).json({ error: 'That email address is already taken. Try another address.' });
    if (error) throw error;
    res.status(201).json({ mailbox: data });
  } catch (error) { jsonError(res, error, 400); }
});

app.patch('/api/profile', authRequired, async (req, res) => {
  try {
    const display_name = cleanText(req.body?.displayName, 120);
    const signature = cleanText(req.body?.signature, 4000);
    const { data, error } = await supabaseAdmin.from('profiles').upsert({ id: req.user.id, email: normalizeEmail(req.user.email), display_name, signature }, { onConflict: 'id' }).select('*').single();
    if (error) throw error;
    res.json({ profile: data });
  } catch (error) { jsonError(res, error, 400); }
});

app.get('/api/folders/counts', authRequired, async (req, res) => {
  try {
    const mailbox = await getOwnedMailbox(req.user.id, cleanText(req.query.mailboxId, 100));
    const folders = ['inbox', 'sent', 'drafts', 'archive', 'spam', 'trash'];
    const counts = {};
    await Promise.all(folders.map(async folder => {
      const query = supabaseAdmin.from('mail_messages').select('id', { count: 'exact', head: true }).eq('owner_id', req.user.id).eq('mailbox_id', mailbox.id).eq('folder', folder);
      if (folder === 'inbox') query.eq('is_read', false);
      const { count, error } = await query;
      if (error) throw error;
      counts[folder] = count || 0;
    }));
    const { count: starred, error: starredError } = await supabaseAdmin.from('mail_messages').select('id', { count: 'exact', head: true }).eq('owner_id', req.user.id).eq('mailbox_id', mailbox.id).eq('is_starred', true).not('folder', 'in', '(trash,spam)');
    if (starredError) throw starredError;
    counts.starred = starred || 0;
    res.json({ counts });
  } catch (error) { jsonError(res, error, 400); }
});

app.get('/api/messages', authRequired, async (req, res) => {
  try {
    const mailbox = await getOwnedMailbox(req.user.id, cleanText(req.query.mailboxId, 100));
    const folder = cleanText(req.query.folder || 'inbox', 30).toLowerCase();
    const allowedFolders = ['inbox', 'sent', 'drafts', 'archive', 'spam', 'trash', 'starred', 'all'];
    if (!allowedFolders.includes(folder)) return res.status(400).json({ error: 'Unknown folder.' });
    let query = supabaseAdmin.from('mail_messages').select('id, mailbox_id, direction, folder, from_email, from_name, to_recipients, cc_recipients, subject, snippet, is_read, is_starred, attachments, created_at, sent_at, received_at')
      .eq('owner_id', req.user.id).eq('mailbox_id', mailbox.id).order('created_at', { ascending: false }).limit(200);
    if (folder === 'starred') query = query.eq('is_starred', true).not('folder', 'in', '(trash,spam)');
    else if (folder !== 'all') query = query.eq('folder', folder);
    const { data, error } = await query;
    if (error) throw error;
    let rows = data || [];
    const q = cleanText(req.query.q, 180).toLowerCase();
    if (q) rows = rows.filter(m => [m.from_email, m.from_name, m.subject, m.snippet, ...(m.to_recipients || []).map(r => r.email)].join(' ').toLowerCase().includes(q));
    if (req.query.unread === 'true') rows = rows.filter(m => !m.is_read);
    res.json({ messages: rows, mailbox });
  } catch (error) { jsonError(res, error, 400); }
});

app.get('/api/messages/:id', authRequired, async (req, res) => {
  try {
    const message = await getOwnedMessage(req.user.id, req.params.id);
    if (message.folder === 'inbox' && !message.is_read) {
      await supabaseAdmin.from('mail_messages').update({ is_read: true }).eq('id', message.id).eq('owner_id', req.user.id);
      message.is_read = true;
    }
    res.json({ message });
  } catch (error) { jsonError(res, error, 404); }
});

app.post('/api/messages/:id/action', authRequired, async (req, res) => {
  try {
    const message = await getOwnedMessage(req.user.id, req.params.id);
    const action = cleanText(req.body?.action, 30);
    let changes = {};
    if (action === 'star') changes = { is_starred: true };
    else if (action === 'unstar') changes = { is_starred: false };
    else if (action === 'read') changes = { is_read: true };
    else if (action === 'unread') changes = { is_read: false };
    else if (action === 'archive') changes = { folder: 'archive' };
    else if (action === 'trash') changes = { folder: 'trash' };
    else if (action === 'spam') changes = { folder: 'spam' };
    else if (action === 'restore') changes = { folder: message.direction === 'inbound' ? 'inbox' : 'sent' };
    else if (action === 'discard_draft') {
      if (message.folder !== 'drafts') return res.status(400).json({ error: 'Only drafts can be discarded directly.' });
      const { error } = await supabaseAdmin.from('mail_messages').delete().eq('id', message.id).eq('owner_id', req.user.id);
      if (error) throw error;
      return res.json({ ok: true, deleted: true });
    }
    else if (action === 'permanent_delete') {
      if (!['trash', 'spam'].includes(message.folder)) return res.status(400).json({ error: 'Move the message to Trash or Spam before permanently deleting it.' });
      const { error } = await supabaseAdmin.from('mail_messages').delete().eq('id', message.id).eq('owner_id', req.user.id);
      if (error) throw error;
      return res.json({ ok: true, deleted: true });
    } else return res.status(400).json({ error: 'Unsupported action.' });
    const { error } = await supabaseAdmin.from('mail_messages').update(changes).eq('id', message.id).eq('owner_id', req.user.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (error) { jsonError(res, error, 400); }
});

app.post('/api/drafts', authRequired, async (req, res) => {
  try {
    const mailbox = await getOwnedMailbox(req.user.id, cleanText(req.body?.mailboxId, 100));
    const to = recipientList(req.body?.to || []);
    const cc = recipientList(req.body?.cc || []);
    const bcc = recipientList(req.body?.bcc || []);
    const subject = cleanText(req.body?.subject, 998);
    const html = String(req.body?.html || '').slice(0, 500000);
    const text = cleanText(req.body?.text || toPlainText(html), 500000);
    const record = {
      owner_id: req.user.id, mailbox_id: mailbox.id, direction: 'outbound', folder: 'drafts',
      from_email: mailbox.email, from_name: mailbox.display_name || '',
      to_recipients: to, cc_recipients: cc, bcc_recipients: bcc,
      subject, body_html: html, body_text: text, snippet: makeSnippet(text, html), is_read: true,
      attachments: Array.isArray(req.body?.attachments) ? req.body.attachments.filter(a => a?.path?.startsWith(`${req.user.id}/`)).slice(0, 20) : []
    };
    const draftId = cleanText(req.body?.id, 100);
    let result;
    if (draftId) {
      const { data: old, error: oldError } = await supabaseAdmin.from('mail_messages').select('id').eq('id', draftId).eq('owner_id', req.user.id).eq('mailbox_id', mailbox.id).eq('folder', 'drafts').maybeSingle();
      if (oldError) throw oldError;
      if (!old) return res.status(404).json({ error: 'Draft not found.' });
      result = await supabaseAdmin.from('mail_messages').update(record).eq('id', draftId).select('id').single();
    } else result = await supabaseAdmin.from('mail_messages').insert(record).select('id').single();
    if (result.error) throw result.error;
    res.json({ ok: true, id: result.data.id });
  } catch (error) { jsonError(res, error, 400); }
});

app.post('/api/send', authRequired, sendLimiter, async (req, res) => {
  if (!hasResend) return res.status(503).json({ error: 'Sending is not configured. Add RESEND_API_KEY.' });
  try {
    const mailbox = await getOwnedMailbox(req.user.id, cleanText(req.body?.mailboxId, 100));
    if (!mailbox.email.endsWith(`@${MAILBOX_DOMAIN}`)) return res.status(403).json({ error: 'This mailbox domain is not enabled for sending.' });
    const to = recipientList(req.body?.to || []);
    const cc = recipientList(req.body?.cc || []);
    const bcc = recipientList(req.body?.bcc || []);
    if (!to.length && !cc.length && !bcc.length) return res.status(400).json({ error: 'Add at least one recipient.' });
    const subject = cleanText(req.body?.subject, 998);
    const html = String(req.body?.html || '').slice(0, 500000);
    const plain = cleanText(req.body?.text || toPlainText(html), 500000);
    if (!subject && !plain) return res.status(400).json({ error: 'Add a subject or message body.' });

    const attachmentPaths = Array.isArray(req.body?.attachments) ? req.body.attachments : [];
    const sendAttachments = [];
    const storedAttachments = [];
    let totalBytes = 0;
    for (const item of attachmentPaths.slice(0, 20)) {
      const storagePath = cleanText(item?.path, 500);
      if (!storagePath.startsWith(`${req.user.id}/`) || storagePath.includes('..')) throw new Error('An attachment does not belong to your account.');
      const { data: file, error: downloadError } = await supabaseAdmin.storage.from(STORAGE_BUCKET).download(storagePath);
      if (downloadError || !file) throw new Error(`Could not access attachment ${cleanText(item?.filename, 100)}.`);
      const buffer = Buffer.from(await file.arrayBuffer());
      totalBytes += buffer.length;
      if (totalBytes > MAX_ATTACHMENT_BYTES) throw new Error(`Attachments exceed the ${MAX_ATTACHMENT_MB} MB total limit.`);
      const filename = safeFileName(item?.filename || storagePath.split('/').pop());
      const contentType = cleanText(item?.content_type || file.type || 'application/octet-stream', 120);
      sendAttachments.push({ filename, content: buffer.toString('base64'), contentType });
      storedAttachments.push({ filename, content_type: contentType, size: buffer.length, path: storagePath });
    }

    const profileResult = await supabaseAdmin.from('profiles').select('display_name, signature').eq('id', req.user.id).maybeSingle();
    const signature = cleanText(profileResult.data?.signature, 4000);
    const finalHtml = `${html}${signature ? `<br><br><div>${signature.replace(/\n/g, '<br>')}</div>` : ''}`;
    const finalText = `${plain}${signature ? `\n\n${signature}` : ''}`;
    const fromName = cleanText(profileResult.data?.display_name || mailbox.display_name || 'AERO.IST User', 120).replace(/[<>\r\n]/g, '');
    const payload = {
      from: `${fromName} <${mailbox.email}>`,
      to: to.map(x => x.email),
      subject: subject || '(no subject)',
      html: finalHtml || undefined,
      text: finalText || undefined
    };
    if (cc.length) payload.cc = cc.map(x => x.email);
    if (bcc.length) payload.bcc = bcc.map(x => x.email);
    if (sendAttachments.length) payload.attachments = sendAttachments;

    const { data: sent, error: sendError } = await resend.emails.send(payload);
    if (sendError) return res.status(502).json({ error: sendError.message || 'The mail provider could not send this message.' });

    const sentRecord = {
      owner_id: req.user.id, mailbox_id: mailbox.id, provider_email_id: sent?.id || null,
      direction: 'outbound', folder: 'sent', from_email: mailbox.email, from_name: fromName,
      to_recipients: to, cc_recipients: cc, bcc_recipients: bcc,
      subject: subject || '(no subject)', body_html: finalHtml, body_text: finalText,
      snippet: makeSnippet(plain, finalHtml), attachments: storedAttachments, is_read: true,
      sent_at: new Date().toISOString(), created_at: new Date().toISOString()
    };
    const { data: stored, error: storeError } = await supabaseAdmin.from('mail_messages').insert(sentRecord).select('id').single();
    if (storeError) {
      console.error('Message sent but could not be saved to Sent:', storeError);
      return res.json({ ok: true, providerId: sent?.id || null, warning: 'Message was sent, but the Sent copy could not be saved. Check the database setup.' });
    }
    if (req.body?.draftId) {
      await supabaseAdmin.from('mail_messages').delete().eq('id', cleanText(req.body.draftId, 100)).eq('owner_id', req.user.id).eq('folder', 'drafts');
    }
    res.json({ ok: true, id: stored.id, providerId: sent?.id || null });
  } catch (error) { jsonError(res, error, 400); }
});

app.get('/api/attachments/signed', authRequired, async (req, res) => {
  try {
    const storagePath = cleanText(req.query.path, 600);
    if (!storagePath.startsWith(`${req.user.id}/`) || storagePath.includes('..')) return res.status(403).json({ error: 'You do not have access to this attachment.' });
    const { data, error } = await supabaseAdmin.storage.from(STORAGE_BUCKET).createSignedUrl(storagePath, 300, { download: true });
    if (error) throw error;
    res.json({ url: data.signedUrl, expiresIn: 300 });
  } catch (error) { jsonError(res, error, 400); }
});

app.get('/api/mailbox-domain', (_req, res) => res.json({ domain: MAILBOX_DOMAIN }));

app.use(express.static(path.join(__dirname, 'public'), { maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`AERO.IST Mail listening on port ${PORT}`);
  console.log(`Supabase: ${hasSupabase ? 'configured' : 'NOT configured'}`);
  console.log(`Resend: ${hasResend ? 'configured' : 'NOT configured'}`);
  console.log(`Mailbox domain: ${MAILBOX_DOMAIN}`);
});
