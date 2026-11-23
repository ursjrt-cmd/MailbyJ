-- AERO.IST Mail Platform — Supabase SQL setup
-- Run this entire file once in Supabase Dashboard > SQL Editor.
-- Keep the Supabase service-role/secret key only on your Render server.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text not null default 'AERO.IST User',
  signature text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.mailboxes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  email text not null unique,
  display_name text not null default '',
  domain text not null,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  constraint mailboxes_email_lowercase check (email = lower(email)),
  constraint mailboxes_domain_lowercase check (domain = lower(domain))
);

create index if not exists mailboxes_owner_idx on public.mailboxes(owner_id);
create unique index if not exists mailboxes_id_owner_unique on public.mailboxes(id, owner_id);

create table if not exists public.mail_messages (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  mailbox_id uuid not null references public.mailboxes(id) on delete cascade,
  provider_email_id text,
  message_id text,
  thread_id text,
  direction text not null default 'inbound' check (direction in ('inbound','outbound')),
  folder text not null default 'inbox' check (folder in ('inbox','sent','drafts','archive','spam','trash')),
  from_email text not null default '',
  from_name text not null default '',
  to_recipients jsonb not null default '[]'::jsonb,
  cc_recipients jsonb not null default '[]'::jsonb,
  bcc_recipients jsonb not null default '[]'::jsonb,
  subject text not null default '',
  body_text text not null default '',
  body_html text not null default '',
  snippet text not null default '',
  attachments jsonb not null default '[]'::jsonb,
  labels text[] not null default '{}',
  is_read boolean not null default false,
  is_starred boolean not null default false,
  sent_at timestamptz,
  received_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint mail_messages_mailbox_owner_fk foreign key (mailbox_id, owner_id)
    references public.mailboxes(id, owner_id) on delete cascade
);

create unique index if not exists mail_messages_provider_dedupe_idx
  on public.mail_messages(mailbox_id, provider_email_id);
create index if not exists mail_messages_owner_mailbox_folder_created_idx
  on public.mail_messages(owner_id, mailbox_id, folder, created_at desc);
create index if not exists mail_messages_owner_mailbox_starred_idx
  on public.mail_messages(owner_id, mailbox_id, is_starred, created_at desc);
create index if not exists mail_messages_owner_unread_idx
  on public.mail_messages(owner_id, mailbox_id, is_read, created_at desc);

-- Create/update the user's profile after Supabase Auth creates the account.
create or replace function public.handle_new_aero_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    lower(new.email),
    coalesce(nullif(new.raw_user_meta_data ->> 'full_name', ''), split_part(new.email, '@', 1), 'AERO.IST User')
  )
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_aero on auth.users;
create trigger on_auth_user_created_aero
after insert on auth.users
for each row execute procedure public.handle_new_aero_user();

-- Enable RLS on all public tables.
alter table public.profiles enable row level security;
alter table public.mailboxes enable row level security;
alter table public.mail_messages enable row level security;

-- Explicit API grants; RLS policies above scope all authenticated access to the current owner.
grant usage on schema public to authenticated;
grant select, update on public.profiles to authenticated;
grant select on public.mailboxes to authenticated;
grant select, update, delete on public.mail_messages to authenticated;

-- Profiles: users can read and update only their own profile.
drop policy if exists "AERO users read own profile" on public.profiles;
create policy "AERO users read own profile" on public.profiles
  for select to authenticated using (id = (select auth.uid()));
drop policy if exists "AERO users update own profile" on public.profiles;
create policy "AERO users update own profile" on public.profiles
  for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- Mailbox/message API writes are intentionally performed by the trusted server using
-- the service-role/secret key. Authenticated clients only get owner-scoped read access.
drop policy if exists "AERO users read own mailboxes" on public.mailboxes;
create policy "AERO users read own mailboxes" on public.mailboxes
  for select to authenticated using (owner_id = (select auth.uid()));
drop policy if exists "AERO users read own messages" on public.mail_messages;
create policy "AERO users read own messages" on public.mail_messages
  for select to authenticated using (owner_id = (select auth.uid()));
drop policy if exists "AERO users update own messages" on public.mail_messages;
create policy "AERO users update own messages" on public.mail_messages
  for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
drop policy if exists "AERO users delete own messages" on public.mail_messages;
create policy "AERO users delete own messages" on public.mail_messages
  for delete to authenticated using (owner_id = (select auth.uid()));

-- Private attachment bucket. 25 MiB is the server-side bucket cap; the application
-- enforces a smaller configurable total message-attachment limit by default.
insert into storage.buckets (id, name, public, file_size_limit)
values ('mail-attachments', 'mail-attachments', false, 26214400)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

drop policy if exists "AERO users upload own mail attachments" on storage.objects;
create policy "AERO users upload own mail attachments" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'mail-attachments'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
drop policy if exists "AERO users read own mail attachments" on storage.objects;
create policy "AERO users read own mail attachments" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'mail-attachments'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
drop policy if exists "AERO users delete own mail attachments" on storage.objects;
create policy "AERO users delete own mail attachments" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'mail-attachments'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- Helpful view: mailbox-level unread counts (owner policy still applies).
create or replace view public.aero_mailbox_unread_counts
with (security_invoker = true)
as
select owner_id, mailbox_id, count(*)::bigint as unread_count
from public.mail_messages
where folder = 'inbox' and is_read = false
group by owner_id, mailbox_id;

comment on table public.mailboxes is 'AERO.IST email addresses owned by authenticated users.';
comment on table public.mail_messages is 'AERO.IST inbound/outbound messages and drafts.';
comment on column public.mail_messages.attachments is 'Private Supabase Storage paths and attachment metadata; never public URLs.';
