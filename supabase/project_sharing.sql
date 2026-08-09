-- 실험 노트 GUI: 프로젝트 단위 사용자 간 공유 (초대 · 공동 편집)
-- note_records.sql 다음에 실행하세요. 모든 구문은 재실행 가능하게 작성되어 있습니다.

-- ============================================================
-- 1. 멤버십 / 초대 테이블
-- ============================================================
create table if not exists public.exp_note_project_members (
  project_id text not null,
  owner_id uuid not null references auth.users(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'editor', 'viewer')),
  status text not null default 'invited' check (status in ('invited', 'active')),
  project_name text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (project_id, user_id)
);

create index if not exists exp_note_project_members_user_idx
  on public.exp_note_project_members (user_id, status);
create index if not exists exp_note_project_members_owner_idx
  on public.exp_note_project_members (owner_id);

alter table public.exp_note_project_members enable row level security;

grant select on public.exp_note_project_members to authenticated;

drop policy if exists "project_members_select_participants" on public.exp_note_project_members;
create policy "project_members_select_participants"
  on public.exp_note_project_members
  for select
  using (auth.uid() = user_id or auth.uid() = owner_id);

-- 모든 변경은 아래 RPC(security definer)를 통해서만 이루어집니다.

-- ============================================================
-- 2. 멤버십 확인 helper (RLS 재귀 방지를 위해 security definer)
-- ============================================================
create or replace function public.is_exp_note_project_member(p_project_id text, p_user_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.exp_note_project_members
    where project_id = p_project_id
      and user_id = p_user_id
      and status = 'active'
  );
$$;

create or replace function public.is_exp_note_project_editor(p_project_id text, p_user_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.exp_note_project_members
    where project_id = p_project_id
      and user_id = p_user_id
      and status = 'active'
      and role in ('owner', 'editor')
  );
$$;

revoke all on function public.is_exp_note_project_member(text, uuid) from public;
revoke all on function public.is_exp_note_project_editor(text, uuid) from public;
grant execute on function public.is_exp_note_project_member(text, uuid) to authenticated;
grant execute on function public.is_exp_note_project_editor(text, uuid) to authenticated;

-- ============================================================
-- 3. 공유 프로젝트 데이터 테이블 (프로젝트당 하나의 정본, 멤버 전원 공동 편집)
-- ============================================================
create table if not exists public.exp_note_shared_records (
  project_id text not null,
  entity_type text not null,
  entity_id text not null,
  payload jsonb,
  updated_at timestamptz not null,
  deleted_at timestamptz,
  updated_by uuid references auth.users(id),
  client_id text not null,
  server_received_at timestamptz not null default now(),
  primary key (project_id, entity_type, entity_id)
);

create index if not exists exp_note_shared_records_project_idx
  on public.exp_note_shared_records (project_id, updated_at desc);

alter table public.exp_note_shared_records enable row level security;

grant select on public.exp_note_shared_records to authenticated;

drop policy if exists "shared_records_select_members" on public.exp_note_shared_records;
create policy "shared_records_select_members"
  on public.exp_note_shared_records
  for select
  using (public.is_exp_note_project_member(project_id, auth.uid()));

-- insert/update는 아래 RPC를 통해서만 (뷰어 차단, updated_by 신뢰 보장).

create or replace function public.upsert_exp_note_shared_records(p_project_id text, p_records jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if not public.is_exp_note_project_editor(p_project_id, auth.uid()) then
    raise exception '이 프로젝트를 편집할 권한이 없습니다.';
  end if;

  insert into public.exp_note_shared_records (
    project_id,
    entity_type,
    entity_id,
    payload,
    updated_at,
    deleted_at,
    updated_by,
    client_id,
    server_received_at
  )
  select
    p_project_id,
    item.entity_type,
    item.entity_id,
    item.payload,
    item.updated_at,
    item.deleted_at,
    auth.uid(),
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
  on conflict (project_id, entity_type, entity_id) do update
  set
    payload = excluded.payload,
    updated_at = excluded.updated_at,
    deleted_at = excluded.deleted_at,
    updated_by = excluded.updated_by,
    client_id = excluded.client_id,
    server_received_at = now()
  where public.exp_note_shared_records.updated_at <= excluded.updated_at;
end;
$$;

revoke all on function public.upsert_exp_note_shared_records(text, jsonb) from public;
grant execute on function public.upsert_exp_note_shared_records(text, jsonb) to authenticated;

-- Realtime: 공유 프로젝트 실시간 공동 편집
alter table public.exp_note_shared_records replica identity full;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'exp_note_shared_records'
  ) then
    alter publication supabase_realtime add table public.exp_note_shared_records;
  end if;
end
$$;

-- ============================================================
-- 4. 초대 관리 RPC
-- ============================================================

-- 프로젝트를 처음 공유하는 시점에 소유권을 등록하고, 이미 공유 중이면 소유자만 초대 가능.
create or replace function public.invite_exp_note_project_member(
  p_project_id text,
  p_project_name text,
  p_recipient_email text,
  p_role text default 'editor'
)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  target_user_id uuid;
  existing_owner uuid;
begin
  if auth.uid() is null then
    raise exception '클라우드 로그인이 필요합니다.';
  end if;
  if p_project_id is null or length(trim(p_project_id)) = 0 then
    raise exception '프로젝트 정보가 올바르지 않습니다.';
  end if;
  if p_role not in ('editor', 'viewer') then
    raise exception '지원하지 않는 권한입니다.';
  end if;

  select id into target_user_id
  from auth.users
  where lower(email::text) = lower(trim(p_recipient_email))
  limit 1;
  if target_user_id is null then
    raise exception '해당 이메일로 가입한 사용자를 찾을 수 없습니다.';
  end if;
  if target_user_id = auth.uid() then
    raise exception '자기 자신은 초대할 수 없습니다.';
  end if;

  select owner_id into existing_owner
  from public.exp_note_project_members
  where project_id = p_project_id and role = 'owner'
  limit 1;

  if existing_owner is null then
    insert into public.exp_note_project_members (
      project_id, owner_id, user_id, role, status, project_name
    ) values (
      p_project_id, auth.uid(), auth.uid(), 'owner', 'active', coalesce(p_project_name, '')
    );
    existing_owner := auth.uid();
  elsif existing_owner <> auth.uid() then
    raise exception '프로젝트 소유자만 초대할 수 있습니다.';
  end if;

  insert into public.exp_note_project_members (
    project_id, owner_id, user_id, role, status, project_name
  ) values (
    p_project_id, existing_owner, target_user_id, p_role, 'invited', coalesce(p_project_name, '')
  )
  on conflict (project_id, user_id) do update
  set role = excluded.role,
      status = case
        when public.exp_note_project_members.status = 'active' then 'active'
        else 'invited'
      end,
      project_name = excluded.project_name,
      updated_at = now()
  where public.exp_note_project_members.role <> 'owner';
end;
$$;

-- 초대받은 사용자의 수락/거절
create or replace function public.respond_exp_note_project_invite(
  p_project_id text,
  p_accept boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception '클라우드 로그인이 필요합니다.';
  end if;
  if p_accept then
    update public.exp_note_project_members
    set status = 'active', updated_at = now()
    where project_id = p_project_id and user_id = auth.uid() and status = 'invited';
  else
    delete from public.exp_note_project_members
    where project_id = p_project_id and user_id = auth.uid() and role <> 'owner';
  end if;
end;
$$;

-- 소유자가 멤버/초대를 제거하거나, 멤버가 스스로 나가기
create or replace function public.remove_exp_note_project_member(
  p_project_id text,
  p_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  requester_role text;
begin
  if auth.uid() is null then
    raise exception '클라우드 로그인이 필요합니다.';
  end if;

  select role into requester_role
  from public.exp_note_project_members
  where project_id = p_project_id and user_id = auth.uid();

  if requester_role is null then
    raise exception '이 프로젝트의 멤버가 아닙니다.';
  end if;
  if requester_role <> 'owner' and auth.uid() <> p_user_id then
    raise exception '소유자만 다른 멤버를 제거할 수 있습니다.';
  end if;
  if requester_role = 'owner' and auth.uid() = p_user_id then
    raise exception '소유자는 스스로를 제거할 수 없습니다.';
  end if;

  delete from public.exp_note_project_members
  where project_id = p_project_id and user_id = p_user_id and role <> 'owner';
end;
$$;

-- 프로젝트 멤버 목록 (소유자/멤버 모두 조회 가능)
create or replace function public.list_exp_note_project_members(p_project_id text)
returns table (
  user_id uuid,
  email text,
  role text,
  status text,
  created_at timestamptz
)
language sql
security definer
set search_path = public, auth
as $$
  select m.user_id, coalesce(u.email::text, ''), m.role, m.status, m.created_at
  from public.exp_note_project_members m
  join auth.users u on u.id = m.user_id
  where m.project_id = p_project_id
    and (
      exists (
        select 1 from public.exp_note_project_members me
        where me.project_id = p_project_id and me.user_id = auth.uid() and me.status = 'active'
      )
    )
  order by (m.role = 'owner') desc, m.created_at asc;
$$;

-- 내가 속한 모든 공유 프로젝트 (활성 멤버십 전체 — owner 포함)
create or replace function public.list_exp_note_shared_projects()
returns table (
  project_id text,
  role text,
  project_name text
)
language sql
security definer
set search_path = public
stable
as $$
  select project_id, role, project_name
  from public.exp_note_project_members
  where user_id = auth.uid() and status = 'active';
$$;

-- 내가 받은, 아직 응답하지 않은 초대 목록
create or replace function public.list_exp_note_incoming_project_invites()
returns table (
  project_id text,
  project_name text,
  owner_email text,
  role text,
  created_at timestamptz
)
language sql
security definer
set search_path = public, auth
as $$
  select m.project_id, m.project_name, coalesce(o.email::text, ''), m.role, m.created_at
  from public.exp_note_project_members m
  join auth.users o on o.id = m.owner_id
  where m.user_id = auth.uid() and m.status = 'invited'
  order by m.created_at asc;
$$;

revoke all on function public.invite_exp_note_project_member(text, text, text, text) from public;
revoke all on function public.respond_exp_note_project_invite(text, boolean) from public;
revoke all on function public.remove_exp_note_project_member(text, uuid) from public;
revoke all on function public.list_exp_note_project_members(text) from public;
revoke all on function public.list_exp_note_shared_projects() from public;
revoke all on function public.list_exp_note_incoming_project_invites() from public;

grant execute on function public.invite_exp_note_project_member(text, text, text, text) to authenticated;
grant execute on function public.respond_exp_note_project_invite(text, boolean) to authenticated;
grant execute on function public.remove_exp_note_project_member(text, uuid) to authenticated;
grant execute on function public.list_exp_note_project_members(text) to authenticated;
grant execute on function public.list_exp_note_shared_projects() to authenticated;
grant execute on function public.list_exp_note_incoming_project_invites() to authenticated;
