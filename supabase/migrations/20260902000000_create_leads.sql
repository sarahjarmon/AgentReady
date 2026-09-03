-- Applied manually through Supabase migrations or the SQL editor; never from the browser.
create extension if not exists pgcrypto;

create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  email text not null check (char_length(email) between 3 and 254),
  website_url text not null check (char_length(website_url) between 8 and 2048),
  readiness_score smallint check (readiness_score between 0 and 100),
  visibility_score smallint check (visibility_score between 0 and 100),
  understanding_score smallint check (understanding_score between 0 and 100),
  buyability_score smallint check (buyability_score between 0 and 100),
  audit_status text not null check (audit_status in ('complete', 'limited', 'blocked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  stripe_customer_id text,
  subscription_status text,
  founder_price_locked boolean not null default false,
  constraint leads_email_website_url_key unique (email, website_url)
);

create index if not exists leads_created_at_idx on public.leads (created_at desc);
create index if not exists leads_audit_status_idx on public.leads (audit_status);

create or replace function public.set_leads_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists leads_set_updated_at on public.leads;
create trigger leads_set_updated_at
before update on public.leads
for each row execute function public.set_leads_updated_at();

alter table public.leads enable row level security;
-- No public policies: only the server-side service-role Function writes leads.
