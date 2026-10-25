// Configuração só por variáveis de ambiente (nenhum segredo no repositório).
export function loadConfig(env = process.env) {
  const need = (k) => { if (!env[k]) throw new Error(`Variável ausente: ${k}`); return env[k]; };
  return {
    port: Number(env.PORT || 4120),
    host: env.HOST || '127.0.0.1',
    databaseUrl: need('DATABASE_URL'),
    jwtSecret: need('JWT_SECRET'),
    requireConfirm: env.REQUIRE_EMAIL_CONFIRM === 'true',
    allowedOrigins: (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
    trustProxy: env.TRUST_PROXY === 'true',
    // Site público da Kobly (links dos e-mails). Sem SITE_URL, usa a primeira origem permitida.
    siteUrl: (env.SITE_URL || (env.ALLOWED_ORIGINS || '').split(',')[0] || '').trim().replace(/\/$/, ''),
    // Logos e demais arquivos de marca (disco local; precisa persistir entre reinícios)
    storageDir: env.STORAGE_DIR || '/var/lib/kobly-storage',
    // Assina os links de descadastro; sem UNSUBSCRIBE_SECRET deriva da chave de segurança do serviço
    unsubscribeSecret: env.UNSUBSCRIBE_SECRET || (env.KOBLY_SECRET_KEY ? `unsub:${env.KOBLY_SECRET_KEY}` : ''),
    resendApiKey: env.RESEND_API_KEY || '',
    mailFrom: env.MAIL_FROM || 'Kobly <onboarding@resend.dev>',
    // Subdomínio de envio verificado no Resend (ex.: envio.koblay.io): remetente <sender_local>@<este domínio>
    resendSendingDomain: env.RESEND_SENDING_DOMAIN || '',
    postgrestUrl: env.POSTGREST_URL || '',
    // WhatsApp (Meta): chave que cifra tokens dos clientes, URL pública p/ webhook, segredo do app Kobly (opcional)
    secretKey: env.KOBLY_SECRET_KEY || '',
    publicBaseUrl: (env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),
    metaAppSecret: env.META_APP_SECRET || '',
    metaGraphBase: env.META_GRAPH_BASE || 'https://graph.facebook.com/v21.0',
    // Marketing API (Facebook Ads): versão atual da documentação
    metaAdsGraphBase: env.META_ADS_GRAPH_BASE || 'https://graph.facebook.com/v26.0',
    // IA dos blocos de fluxo (API compatível com OpenAI). Sem AI_API_KEY os blocos de IA saem por "error".
    aiApiKey: env.AI_API_KEY || '',
    aiBaseUrl: env.AI_BASE_URL || 'https://api.deepseek.com',
    aiModel: env.AI_MODEL || 'deepseek-chat',
    // Chave da plataforma só vale para empresas SEM chave própria se isto for "true" (padrão: cada cliente paga a sua IA)
    aiPlatformFallback: env.AI_PLATFORM_FALLBACK === 'true',
    // WhatsApp por QR Code (Uazapi): servidor e token de administrador da Kobly; sem eles a opção fica desligada
    uazapiBase: env.UAZAPI_BASE_URL || '',
    uazapiAdminToken: env.UAZAPI_ADMIN_TOKEN || '',
    // limite de números do servidor do ambiente (Servidor PRO = 300); outros servidores são cadastrados na tela do Administrador
    uazapiCapacity: Number(env.UAZAPI_CAPACITY || 300),
    // Gateway XPag (cada empresa cadastra a própria credencial; aqui só a URL da API)
    xpagBase: env.XPAG_BASE_URL || 'https://api.xpag.global',
  };
}
