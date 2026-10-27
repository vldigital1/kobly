// Dashboard do cliente (rota dashboard): números de WhatsApp, fluxos e vendas de um período (7, 30 ou 90 dias),
// comparados com o período anterior, a série por dia e as atividades mais recentes. Só leitura.
const RECUP = ['Abandono de carrinho', 'Pix Gerado', 'Boleto Gerado', 'Compra Recusada', 'Depósito Solicitado'];

export function createDashboard({ pool }) {
  async function overview(orgId, days) {
    const d = [7, 30, 90].includes(Number(days)) ? Number(days) : 30;
    const q = (sql, params = []) => pool.query(sql, [orgId, d, ...params]).then((r) => r.rows);
    // contagem no período atual (cur) e no anterior (prev), para a variação %
    const pair = (table, col, extra = '') => q(`select
        count(*) filter (where ${col} >= now() - make_interval(days => $2))::int as cur,
        count(*) filter (where ${col} < now() - make_interval(days => $2) and ${col} >= now() - make_interval(days => $2 * 2))::int as prev
      from public.${table} where organization_id = $1 and ${col} >= now() - make_interval(days => $2 * 2) ${extra}`).then((r) => r[0]);

    const [leads, enviadas, recebidas, emails, vendas, recup, fluxos, emFluxo, conexoes, serie, eventos, topFluxos, atividade] = await Promise.all([
      pair('leads', 'created_at'),
      pair('whatsapp_outbound_messages', 'created_at'),
      pair('whatsapp_inbound_messages', 'received_at'),
      pair('email_events', '"timestamp"', `and channel = 'email' and status = 'enviado'`),
      q(`select count(*) filter (where created_at >= now() - make_interval(days => $2))::int as cur,
            count(*) filter (where created_at < now() - make_interval(days => $2))::int as prev,
            coalesce(sum(valor_produto) filter (where created_at >= now() - make_interval(days => $2)), 0)::float as valor,
            coalesce(sum(valor_produto) filter (where created_at < now() - make_interval(days => $2)), 0)::float as valor_prev
          from public.webhook_events where organization_id = $1 and tipo_evento = 'Compra Aprovada' and created_at >= now() - make_interval(days => $2 * 2)`).then((r) => r[0]),
      q(`select count(*)::int as n, coalesce(sum(amount), 0)::float as valor from public.flow_sales where organization_id = $1 and created_at >= now() - make_interval(days => $2)`).then((r) => r[0]),
      q(`select count(distinct c.id)::int as n from public.campaigns c join public.campaign_flows f on f.campaign_id = c.id
          join public.flow_graph_versions v on v.flow_id = f.id and v.is_active where c.organization_id = $1 and c.status_campanha = 'Ativa' and $2 > 0`).then((r) => r[0].n),
      q(`select count(*)::int as n from public.flow_executions where organization_id = $1 and status in ('running','waiting') and $2 > 0`).then((r) => r[0].n),
      q(`select (select count(*) from public.whatsapp_uazapi_instances where organization_id = $1 and status = 'connected')::int
            + (select count(*) from public.whatsapp_accounts where organization_id = $1 and status = 'connected')::int as n, $2::int as _`).then((r) => r[0].n),
      q(`select to_char(dia, 'YYYY-MM-DD') as dia,
            (select count(*) from public.leads l where l.organization_id = $1 and l.created_at >= dia and l.created_at < dia + interval '1 day')::int as leads,
            (select count(*) from public.whatsapp_outbound_messages m where m.organization_id = $1 and m.created_at >= dia and m.created_at < dia + interval '1 day')::int as enviadas,
            (select count(*) from public.whatsapp_inbound_messages m where m.organization_id = $1 and m.received_at >= dia and m.received_at < dia + interval '1 day')::int as recebidas,
            (select count(*) from public.webhook_events w where w.organization_id = $1 and w.tipo_evento = 'Compra Aprovada' and w.created_at >= dia and w.created_at < dia + interval '1 day')::int as vendas
          from generate_series(date_trunc('day', now()) - make_interval(days => $2 - 1), date_trunc('day', now()), interval '1 day') as dia order by dia`),
      q(`select tipo_evento::text as tipo, count(*)::int as n from public.webhook_events where organization_id = $1 and created_at >= now() - make_interval(days => $2) group by 1 order by 2 desc`),
      q(`select c.id, c.nome, c.status_campanha as status,
            (select count(*) from public.flow_executions e where e.campaign_id = c.id and e.started_at >= now() - make_interval(days => $2))::int as leads,
            (select count(*) from public.flow_executions e where e.campaign_id = c.id and e.status in ('running','waiting'))::int as agora,
            (select count(*) from public.flow_sales s where s.campaign_id = c.id and s.created_at >= now() - make_interval(days => $2))::int as vendas,
            (select coalesce(sum(amount), 0) from public.flow_sales s where s.campaign_id = c.id and s.created_at >= now() - make_interval(days => $2))::float as valor
          from public.campaigns c join public.campaign_flows f on f.campaign_id = c.id join public.flow_graph_versions v on v.flow_id = f.id and v.is_active
          where c.organization_id = $1 order by leads desc, c.nome limit 6`),
      q(`select * from (
            (select 'evento' as tipo, w.tipo_evento::text as titulo, coalesce(w.nome_comprador, w.email::text, w.telefone, '') as quem, w.valor_produto::float as valor, w.created_at as em
              from public.webhook_events w where w.organization_id = $1 order by w.created_at desc limit 8)
            union all
            (select 'resposta', 'Respondeu no WhatsApp', coalesce(l.nome, m.from_phone), null, m.received_at
              from public.whatsapp_inbound_messages m left join public.leads l on l.id = m.lead_id where m.organization_id = $1 order by m.received_at desc limit 6)
            union all
            (select 'venda', 'Venda recuperada pelo fluxo', coalesce(l.nome, ''), s.amount::float, s.created_at
              from public.flow_sales s left join public.leads l on l.id = s.lead_id where s.organization_id = $1 order by s.created_at desc limit 6)
          ) x where $2 > 0 order by em desc limit 12`),
    ]);
    const recuperacao = eventos.filter((e) => RECUP.includes(e.tipo)).reduce((a, e) => a + e.n, 0);
    return { days: d, leads, enviadas, recebidas, emails, vendas, recuperadas: recup, fluxos_ativos: fluxos, leads_em_fluxo: emFluxo, conexoes,
      oportunidades: recuperacao, serie, eventos, top_fluxos: topFluxos, atividade };
  }
  // Painel do Administrador da Kobly: a plataforma inteira (todas as empresas).
  async function admin(body) {
    const d = [7, 30, 90].includes(Number(body.days)) ? Number(body.days) : 30;
    const one = (sql) => pool.query(sql, [d]).then((r) => r.rows[0]);
    const many = (sql) => pool.query(sql, [d]).then((r) => r.rows);
    const [totais, serie, servidores, top] = await Promise.all([
      one(`select (select count(*) from public.organizations)::int as empresas,
          (select count(*) from public.organizations where created_at >= now() - make_interval(days => $1))::int as empresas_novas,
          (select count(*) from public.profiles)::int as usuarios,
          (select count(distinct organization_id) from public.whatsapp_outbound_messages where created_at >= now() - make_interval(days => $1))::int as empresas_ativas,
          (select count(*) from public.whatsapp_uazapi_instances where status = 'connected')::int + (select count(*) from public.whatsapp_accounts where status = 'connected')::int as numeros,
          (select count(*) from public.whatsapp_outbound_messages where created_at >= now() - make_interval(days => $1))::int as mensagens,
          (select count(*) from public.whatsapp_inbound_messages where received_at >= now() - make_interval(days => $1))::int as respostas,
          (select count(*) from public.leads where created_at >= now() - make_interval(days => $1))::int as leads,
          (select count(*) from public.flow_executions where status in ('running','waiting'))::int as em_fluxo,
          (select count(*) from public.flow_sales where created_at >= now() - make_interval(days => $1))::int as vendas,
          (select coalesce(sum(amount), 0) from public.flow_sales where created_at >= now() - make_interval(days => $1))::float as vendas_valor`),
      many(`select to_char(dia, 'YYYY-MM-DD') as dia,
          (select count(*) from public.organizations o where o.created_at >= dia and o.created_at < dia + interval '1 day')::int as empresas,
          (select count(*) from public.whatsapp_outbound_messages m where m.created_at >= dia and m.created_at < dia + interval '1 day')::int as mensagens,
          (select count(*) from public.leads l where l.created_at >= dia and l.created_at < dia + interval '1 day')::int as leads
        from generate_series(date_trunc('day', now()) - make_interval(days => $1 - 1), date_trunc('day', now()), interval '1 day') as dia order by dia`),
      many(`select s.label, s.capacity, s.active, (select count(*) from public.whatsapp_uazapi_instances i where i.server_id = s.id)::int as usados,
          (select count(*) from public.whatsapp_uazapi_instances i where i.server_id = s.id and i.status = 'connected')::int as conectados
        from public.uazapi_servers s where $1 > 0 order by s.created_at`),
      many(`select o.id, o.nome,
          (select count(*) from public.whatsapp_outbound_messages m where m.organization_id = o.id and m.created_at >= now() - make_interval(days => $1))::int as mensagens,
          (select count(*) from public.leads l where l.organization_id = o.id and l.created_at >= now() - make_interval(days => $1))::int as leads,
          (select coalesce(sum(amount), 0) from public.flow_sales s where s.organization_id = o.id and s.created_at >= now() - make_interval(days => $1))::float as vendas
        from public.organizations o order by mensagens desc, leads desc limit 8`),
    ]);
    return { days: d, totais, serie, servidores, top };
  }

  return {
    admin,
    async handle(ctx, user, body) {
      if (body.action === 'overview') return overview(ctx.orgId, body.days);
      const { AuthError } = await import('../auth.js');
      throw new AuthError(400, 'bad_action', 'Ação desconhecida.');
    },
  };
}
