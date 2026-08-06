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

-- 사용자 간 프로토콜 복사·이동
create table if not exists public.exp_note_protocol_transfers (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references auth.users(id) on delete cascade,
  recipient_id uuid not null references auth.users(id) on delete cascade,
  protocol_payload jsonb not null,
  source_project text not null default '',
  source_experiment text not null default '',
  transfer_mode text not null check (transfer_mode in ('copy', 'move')),
  created_at timestamptz not null default now(),
  received_at timestamptz
);

create index if not exists exp_note_protocol_transfers_recipient_idx
  on public.exp_note_protocol_transfers (recipient_id, received_at, created_at);

alter table public.exp_note_protocol_transfers enable row level security;

grant select on public.exp_note_protocol_transfers to authenticated;

drop policy if exists "protocol_transfers_select_participants" on public.exp_note_protocol_transfers;
create policy "protocol_transfers_select_participants"
  on public.exp_note_protocol_transfers
  for select
  using (auth.uid() = sender_id or auth.uid() = recipient_id);

create or replace function public.share_exp_note_protocol(
  p_recipient_email text,
  p_protocol jsonb,
  p_source_project text default '',
  p_source_experiment text default '',
  p_transfer_mode text default 'copy'
)
returns uuid
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  target_user_id uuid;
  transfer_id uuid;
begin
  if auth.uid() is null then
    raise exception '클라우드 로그인이 필요합니다.';
  end if;
  if p_transfer_mode not in ('copy', 'move') then
    raise exception '지원하지 않는 전달 방식입니다.';
  end if;
  if p_protocol is null or jsonb_typeof(p_protocol) <> 'object' then
    raise exception '프로토콜 데이터가 올바르지 않습니다.';
  end if;

  select id into target_user_id
  from auth.users
  where lower(email::text) = lower(trim(p_recipient_email))
  limit 1;

  if target_user_id is null then
    raise exception '해당 이메일로 가입한 사용자를 찾을 수 없습니다.';
  end if;
  if target_user_id = auth.uid() then
    raise exception '자기 자신에게는 공유할 수 없습니다.';
  end if;

  insert into public.exp_note_protocol_transfers (
    sender_id,
    recipient_id,
    protocol_payload,
    source_project,
    source_experiment,
    transfer_mode
  ) values (
    auth.uid(),
    target_user_id,
    p_protocol,
    coalesce(p_source_project, ''),
    coalesce(p_source_experiment, ''),
    p_transfer_mode
  )
  returning id into transfer_id;

  return transfer_id;
end;
$$;

create or replace function public.list_received_exp_note_protocols()
returns table (
  id uuid,
  sender_email text,
  protocol_payload jsonb,
  source_project text,
  source_experiment text,
  transfer_mode text,
  created_at timestamptz
)
language sql
security definer
set search_path = public, auth
as $$
  select
    transfer.id,
    coalesce(sender.email::text, ''),
    transfer.protocol_payload,
    transfer.source_project,
    transfer.source_experiment,
    transfer.transfer_mode,
    transfer.created_at
  from public.exp_note_protocol_transfers transfer
  join auth.users sender on sender.id = transfer.sender_id
  where transfer.recipient_id = auth.uid()
    and transfer.received_at is null
  order by transfer.created_at asc;
$$;

create or replace function public.mark_exp_note_protocols_received(p_transfer_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception '클라우드 로그인이 필요합니다.';
  end if;
  update public.exp_note_protocol_transfers
  set received_at = coalesce(received_at, now())
  where recipient_id = auth.uid()
    and id = any(coalesce(p_transfer_ids, array[]::uuid[]));
end;
$$;

revoke all on function public.share_exp_note_protocol(text, jsonb, text, text, text) from public;
revoke all on function public.list_received_exp_note_protocols() from public;
revoke all on function public.mark_exp_note_protocols_received(uuid[]) from public;
grant execute on function public.share_exp_note_protocol(text, jsonb, text, text, text) to authenticated;
grant execute on function public.list_received_exp_note_protocols() to authenticated;
grant execute on function public.mark_exp_note_protocols_received(uuid[]) to authenticated;
