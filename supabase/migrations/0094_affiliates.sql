-- Programa de afiliados da Kobly: quem indica pelo link ganha comissão recorrente sobre cada pagamento de plano
-- das contas que indicou. Padrão 10% (ajustável por afiliado no painel do Administrador).
-- * affiliate_settings: regras gerais (uma linha)
-- * affiliates: o afiliado (um por usuário), código do link, comissão própria, chave Pix
-- * affiliate_clicks: cliques no link
-- * affiliate_referrals: quem se cadastrou pelo link (a conta da empresa é ligada depois, no onboarding)
-- * affiliate_commissions: uma por pagamento confirmado (transactions) da conta indicada — gerada pelo banco
-- * affiliate_payouts: saques pedidos/pagos
-- Tudo só pelo serviço (as telas leem pela rota /functions/v1/affiliates).

create table public.affiliate_settings (
  id boolean primary key default true check (id),
  default_pct numeric(5,2) not null default 10 check (default_pct between 0 and 100),
  min_payout numeric(10,2) not null default 50,
  hold_days int not null default 7 check (hold_days between 0 and 90),   -- dias até a comissão ficar disponível (reembolsos)
  cookie_days int not null default 60 check (cookie_days between 1 and 365),
  platform_org_id uuid references public.organizations(id) on delete set null,   -- conta da Kobly que roda os fluxos de boas-vindas
  referral_campaign_id uuid references public.campaigns(id) on delete set null,  -- fluxo para quem se cadastra pelo link
  affiliate_campaign_id uuid references public.campaigns(id) on delete set null, -- fluxo para quem vira afiliado
  terms text,
  updated_at timestamptz not null default now()
);
insert into public.affiliate_settings (id) values (true) on conflict do nothing;

create table public.affiliates (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null unique,
  profile_id uuid references public.profiles(id) on delete set null,
  code text not null unique check (code ~ '^[a-z0-9-]{3,30}$'),
  nome text,
  email text,
  whatsapp text,
  commission_pct numeric(5,2) check (commission_pct is null or commission_pct between 0 and 100), -- null = padrão
  status text not null default 'ativo' check (status in ('ativo', 'pausado', 'bloqueado')),
  pix_tipo text check (pix_tipo in ('cpf', 'cnpj', 'email', 'telefone', 'aleatoria')),
  pix_chave text,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.affiliate_clicks (
  id bigserial primary key,
  affiliate_id uuid not null references public.affiliates(id) on delete cascade,
  ip_hash text,
  landing text,
  created_at timestamptz not null default now()
);
create index idx_affiliate_clicks on public.affiliate_clicks (affiliate_id, created_at desc);

create table public.affiliate_referrals (
  id uuid primary key default gen_random_uuid(),
  affiliate_id uuid not null references public.affiliates(id) on delete cascade,
  auth_user_id uuid not null unique,
  email text,
  nome text,
  whatsapp text,
  organization_id uuid references public.organizations(id) on delete set null,
  created_at timestamptz not null default now()
);
create index idx_affiliate_referrals on public.affiliate_referrals (affiliate_id, created_at desc);

alter table public.organizations add column if not exists referred_by_affiliate_id uuid references public.affiliates(id) on delete set null;

create table public.affiliate_commissions (
  id uuid primary key default gen_random_uuid(),
  affiliate_id uuid not null references public.affiliates(id) on delete cascade,
  organization_id uuid references public.organizations(id) on delete set null,
  transaction_id uuid not null unique references public.transactions(id) on delete cascade,
  base_value numeric(10,2) not null,
  pct numeric(5,2) not null,
  amount numeric(10,2) not null,
  status text not null default 'pendente' check (status in ('pendente', 'disponivel', 'paga', 'cancelada')),
  available_at timestamptz not null,
  payout_id uuid,
  created_at timestamptz not null default now()
);
create index idx_affiliate_commissions on public.affiliate_commissions (affiliate_id, created_at desc);

create table public.affiliate_payouts (
  id uuid primary key default gen_random_uuid(),
  affiliate_id uuid not null references public.affiliates(id) on delete cascade,
  amount numeric(10,2) not null check (amount > 0),
  status text not null default 'solicitado' check (status in ('solicitado', 'pago', 'recusado')),
  pix_tipo text,
  pix_chave text,
  note text,
  requested_at timestamptz not null default now(),
  paid_at timestamptz
);
create index idx_affiliate_payouts on public.affiliate_payouts (affiliate_id, requested_at desc);
alter table public.affiliate_commissions add constraint affiliate_commissions_payout_fk foreign key (payout_id) references public.affiliate_payouts(id) on delete set null;

-- Afiliado de uma conta: o que já está na conta ou o cadastro (pelo link) do dono/fundador da conta.
create or replace function public.affiliate_of_org(p_org uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v uuid;
begin
  select referred_by_affiliate_id into v from public.organizations where id = p_org;
  if v is not null then return v; end if;
  select r.affiliate_id into v from public.affiliate_referrals r
    join public.profiles p on p.auth_id = r.auth_user_id
    join public.organizations o on o.id = p_org
   where p.organization_id = p_org or p.id = o.user_fundador_id
   order by r.created_at limit 1;
  if v is not null then
    update public.organizations set referred_by_affiliate_id = v where id = p_org and referred_by_affiliate_id is null;
    update public.affiliate_referrals r set organization_id = p_org
      from public.profiles p where p.auth_id = r.auth_user_id and r.affiliate_id = v and r.organization_id is null
       and (p.organization_id = p_org or p.id = (select user_fundador_id from public.organizations where id = p_org));
  end if;
  return v;
end;
$$;

-- Pagamento de plano confirmado → comissão do afiliado (uma por transação; recorrente porque cada mês é uma transação).
-- Pagamento estornado/cancelado → comissão ainda não paga é cancelada.
create or replace function public.tg_affiliate_commission()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_aff uuid; v_pct numeric; v_hold int; v_status text;
begin
  if new.organization_id is null or coalesce(new.valor_pago, 0) <= 0 then return new; end if;
  if new.status_pagamento::text = 'Pago' then
    v_aff := public.affiliate_of_org(new.organization_id);
    if v_aff is null then return new; end if;
    select a.status, coalesce(a.commission_pct, s.default_pct), s.hold_days into v_status, v_pct, v_hold
      from public.affiliates a cross join public.affiliate_settings s where a.id = v_aff;
    if v_status is distinct from 'ativo' or coalesce(v_pct, 0) <= 0 then return new; end if;
    insert into public.affiliate_commissions (affiliate_id, organization_id, transaction_id, base_value, pct, amount, available_at)
    values (v_aff, new.organization_id, new.id, new.valor_pago, v_pct, round(new.valor_pago * v_pct / 100, 2), now() + make_interval(days => v_hold))
    on conflict (transaction_id) do nothing;
  elsif tg_op = 'UPDATE' and old.status_pagamento::text = 'Pago' then
    update public.affiliate_commissions set status = 'cancelada' where transaction_id = new.id and status in ('pendente', 'disponivel');
  end if;
  return new;
end;
$$;
create trigger affiliate_commission after insert or update of status_pagamento, valor_pago on public.transactions
  for each row execute function public.tg_affiliate_commission();

alter table public.affiliate_settings enable row level security;
alter table public.affiliates enable row level security;
alter table public.affiliate_clicks enable row level security;
alter table public.affiliate_referrals enable row level security;
alter table public.affiliate_commissions enable row level security;
alter table public.affiliate_payouts enable row level security;
revoke all on public.affiliate_settings, public.affiliates, public.affiliate_clicks, public.affiliate_referrals, public.affiliate_commissions, public.affiliate_payouts from authenticated, anon, public;
revoke all on function public.affiliate_of_org(uuid) from public, anon, authenticated;
