-- 실험 노트 GUI: 항목별 동기화와 최신 수정 우선(LWW) 정책

create table if not exists public.exp_note_records (
  user_id uuid not null references auth.users(id) on delete cascade,
  entity_type text not null,
  entity_id text not null,
  payload jsonb,
  updated_at timestamptz not null,
  deleted_at timestamptz,
  client_id text not null,
  server_received_at timestamptz not null default now(),
  primary key (user_id, entity_type, entity_id)
);

create index if not exists exp_note_records_user_updated_idx
  on public.exp_note_records (user_id, updated_at desc);

alter table public.exp_note_records enable row level security;

grant select, insert, update on public.exp_note_records
  to authenticated;

drop policy if exists "exp_note_records_select_own" on public.exp_note_records;
create policy "exp_note_records_select_own"
  on public.exp_note_records
  for select
  using (auth.uid() = user_id);

drop policy if exists "exp_note_records_insert_own" on public.exp_note_records;
create policy "exp_note_records_insert_own"
  on public.exp_note_records
  for insert
  with check (auth.uid() = user_id);

drop policy if exists "exp_note_records_update_own" on public.exp_note_records;
create policy "exp_note_records_update_own"
  on public.exp_note_records
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create or replace function public.upsert_exp_note_records(p_records jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  insert into public.exp_note_records (
    user_id,
    entity_type,
    entity_id,
    payload,
    updated_at,
    deleted_at,
    client_id,
    server_received_at
  )
  select
    auth.uid(),
    item.entity_type,
    item.entity_id,
    item.payload,
    item.updated_at,
    item.deleted_at,
    item.client_id,
    now()
  from jsonb_to_recordset(coalesce(p_records, '[]'::jsonb)) as item(
    entity_type text,
    entity_id text,
    payload jsonb,
    updated_at timestamptz,
    deleted_at timestamptz,
    client_id text
  )
  on conflict (user_id, entity_type, entity_id) do update
  set
    payload = excluded.payload,
    updated_at = excluded.updated_at,
    deleted_at = excluded.deleted_at,
    client_id = excluded.client_id,
    server_received_at = now()
  where public.exp_note_records.updated_at <= excluded.updated_at;
end;
$$;

grant execute on function public.upsert_exp_note_records(jsonb) to authenticated;

-- Realtime: 다기기 실시간 동기화
alter table public.exp_note_records replica identity full;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'exp_note_records'
  ) then
    alter publication supabase_realtime add table public.exp_note_records;
  end if;
end
$$;
