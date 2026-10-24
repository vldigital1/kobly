// Rota POST /functions/v1/team: equipe da empresa (Configurações → Equipe).
// Quem administra a empresa convida pessoas por e-mail como 'admin' (configura tudo) ou 'atendente'
// (só Chats ao vivo, Leads e Pipeline — a trava fica no servidor, em functions/index.js). O convidado
// recebe o link para definir a senha. O dono (fundador) é sempre admin e não pode ser removido.
import { AuthError } from '../auth.js';

const UUID = /^[0-9a-f-]{36}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ROLES = ['admin', 'atendente'];
const INVITE_TTL = 7 * 24 * 3600;

export function createTeam({ pool, auth, mailer }) {
  async function caller(ctx, user) {
    const p = (await pool.query(`select id, nome, team_role, organization_id from public.profiles where auth_id = $1`, [user.id])).rows[0];
    if (!p) throw new AuthError(403, 'forbidden', 'Sem perfil.');
    return p;
  }
  // Administra a equipe: admin da própria empresa, ou Gestor/Administrador da Kobly com acesso a ela.
  async function requireManager(ctx, user) {
    const p = await caller(ctx, user);
    const own = p.organization_id === ctx.orgId && p.team_role === 'admin' && ctx.role === 'Cliente';
    if (!own && ctx.role !== 'Gestor' && ctx.role !== 'Administrador') throw new AuthError(403, 'forbidden', 'Só quem administra a empresa pode mexer na equipe.');
    return p;
  }
  async function memberOf(orgId, profileId) {
    if (!UUID.test(String(profileId || ''))) throw new AuthError(422, 'validation_failed', 'Pessoa inválida.');
    const m = (await pool.query(`select p.id, p.auth_id, p.team_role, (o.user_fundador_id = p.id) as dono from public.profiles p join public.organizations o on o.id = p.organization_id
      where p.id = $1 and p.organization_id = $2`, [profileId, orgId])).rows[0];
    if (!m) throw new AuthError(404, 'not_found', 'Pessoa não encontrada nesta empresa.');
    return m;
  }
  async function sendInvite(orgId, userId, email, nome, by) {
    const org = (await pool.query(`select nome from public.organizations where id = $1`, [orgId])).rows[0];
    const token = await auth.createOneTimeToken(userId, 'recovery', INVITE_TTL);
    const mail = await mailer.sendInvite(email, token, null, { nome: nome || '', conta: org ? org.nome : '', convidadoPor: by || '' });
    // sem provedor de e-mail, quem convida recebe o link para repassar; com e-mail enviado, o link não volta
    return { emailed: !!mail.sent, ...(mail.sent ? {} : { access_link: mailer.inviteLink(null, token) }) };
  }

  async function handle(ctx, user, body) {
    const orgId = ctx.orgId;
    switch (body.action) {
      case 'list': {
        const me = await caller(ctx, user);
        const { rows } = await pool.query(`
          select p.id, p.nome, p.email::text as email, p.team_role, p.tipo_user_geral as tipo, p.ultimo_login, p.created_at,
                 (o.user_fundador_id = p.id) as dono, (u.last_sign_in_at is null) as convite_pendente
            from public.profiles p join public.organizations o on o.id = p.organization_id left join auth.users u on u.id = p.auth_id
           where p.organization_id = $1 order by (o.user_fundador_id = p.id) desc, p.created_at`, [orgId]);
        const canManage = (me.organization_id === orgId && me.team_role === 'admin' && ctx.role === 'Cliente') || ctx.role === 'Gestor' || ctx.role === 'Administrador';
        return { members: rows, me: me.id, can_manage: canManage };
      }
      case 'invite': {
        const by = await requireManager(ctx, user);
        const email = String(body.email || '').trim().toLowerCase();
        const nome = String(body.nome || '').trim().slice(0, 120);
        const role = ROLES.includes(body.team_role) ? body.team_role : 'atendente';
        if (!EMAIL_RE.test(email)) throw new AuthError(422, 'validation_failed', 'Informe um e-mail válido.');
        const ex = (await pool.query(`select u.id, u.last_sign_in_at, p.id as profile_id, p.organization_id from auth.users u left join public.profiles p on p.auth_id = u.id where lower(u.email) = $1`, [email])).rows[0];
        let userId;
        if (ex) {
          // quem já tem conta não é puxado para esta empresa (ninguém "sequestra" o usuário de outra)
          if (ex.organization_id && ex.organization_id !== orgId) throw new AuthError(409, 'email_in_use', 'Este e-mail já pertence a outra conta da Kobly.');
          if (ex.organization_id === orgId && ex.last_sign_in_at) throw new AuthError(409, 'already_member', 'Esta pessoa já faz parte da equipe.');
          if (!ex.organization_id && ex.last_sign_in_at) throw new AuthError(409, 'email_in_use', 'Este e-mail já tem uma conta Kobly. Peça para a pessoa usar outro e-mail.');
          userId = ex.id;
          await pool.query(`update public.profiles set organization_id = $2, team_role = $3 where auth_id = $1 and (organization_id is null or organization_id = $2)`, [userId, orgId, role]);
        } else {
          const r = await pool.query(`insert into auth.users (email, encrypted_password, raw_user_meta_data, raw_app_meta_data, email_confirmed_at)
            values ($1, null, $2::jsonb, $3::jsonb, now()) returning id`, [email, JSON.stringify({ nome }), JSON.stringify({ tipo_user_geral: 'Cliente', organization_id: orgId })]);
          userId = r.rows[0].id;
          await pool.query(`update public.profiles set team_role = $2 where auth_id = $1`, [userId, role]);
        }
        return { ok: true, ...(await sendInvite(orgId, userId, email, nome, by.nome)) };
      }
      case 'resend': {
        const by = await requireManager(ctx, user);
        const m = await memberOf(orgId, body.profile_id);
        const u = (await pool.query(`select id, email, last_sign_in_at, raw_user_meta_data->>'nome' as nome from auth.users where id = $1`, [m.auth_id])).rows[0];
        if (!u || u.last_sign_in_at) throw new AuthError(409, 'already_active', 'Esta pessoa já entrou; não há convite pendente.');
        return { ok: true, ...(await sendInvite(orgId, u.id, u.email, u.nome, by.nome)) };
      }
      case 'set_role': {
        const by = await requireManager(ctx, user);
        const m = await memberOf(orgId, body.profile_id);
        if (!ROLES.includes(body.team_role)) throw new AuthError(422, 'validation_failed', 'Papel inválido.');
        if (m.dono) throw new AuthError(409, 'owner', 'O dono da conta é sempre administrador.');
        if (m.id === by.id) throw new AuthError(409, 'self', 'Você não pode mudar o seu próprio papel.');
        await pool.query(`update public.profiles set team_role = $2 where id = $1`, [m.id, body.team_role]);
        return { ok: true };
      }
      case 'remove': { // tira da empresa e derruba as sessões abertas (o acesso acaba na hora)
        const by = await requireManager(ctx, user);
        const m = await memberOf(orgId, body.profile_id);
        if (m.dono) throw new AuthError(409, 'owner', 'O dono da conta não pode ser removido.');
        if (m.id === by.id) throw new AuthError(409, 'self', 'Você não pode remover a si mesmo.');
        await pool.query(`update public.profiles set organization_id = null, team_role = 'admin' where id = $1`, [m.id]);
        if (m.auth_id) await pool.query(`delete from auth.sessions where user_id = $1`, [m.auth_id]);
        return { ok: true };
      }
      default: throw new AuthError(400, 'bad_action', 'Ação desconhecida.');
    }
  }
  return { handle };
}
