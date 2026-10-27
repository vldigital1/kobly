# Análise do app no Facebook (Meta) — textos prontos

Use este guia quando for pedir o **acesso avançado** em
**developers.facebook.com → app Kobly → Análise do app → Permissões e recursos**.

O Facebook avalia em inglês. Por isso cada bloco tem o texto **em inglês para colar** e a tradução embaixo.

---

## 0. Antes de enviar (checklist)

- [ ] **Configurações do app → Básico**
  - Ícone 1024×1024: o símbolo laranja da Kobly.
  - **URL da Política de Privacidade:** `https://app.koblay.io/privacidade`
  - **URL dos Termos de Serviço:** `https://app.koblay.io/termos`
  - **URL de instruções de exclusão de dados:** `https://app.koblay.io/exclusao-de-dados`
  - Categoria: **Negócios e páginas**. E-mail de contato: **suportekobly@gmail.com**.
- [ ] **Verificação da empresa** concluída (Central de segurança do Gerenciador de Negócios).
- [ ] Configuração **"kobly Anúncios"** com as permissões ads_read, ads_management e business_management.
- [ ] Uma **conta de teste na Kobly** para o revisor do Facebook entrar.
  - Crie com um e-mail seu, por exemplo revisor.facebook@...
  - Conecte nela uma conta de anúncios de teste com 1 ou 2 campanhas.
  - O e-mail e a senha dessa conta vão no campo "Instruções de teste".
- [ ] Os **vídeos** gravados (roteiro no item 4).

---

## 1. ads_read

**Cole isto (inglês):**

> Kobly is a sales-recovery and marketing analytics platform for online businesses in Brazil and Latin America. We use ads_read to show each business owner the performance of their own Facebook and Instagram ad campaigns (spend, impressions, clicks, CTR, CPC, CPM, purchases and conversations started) at the campaign, ad set and ad level, side by side with the sales that Kobly tracked through UTM parameters from the business's checkout platforms. This lets the advertiser see their real return on ad spend, profit and cost per sale inside Kobly. Data is only shown to the business that connected the ad account; it is not shared, sold or used for any other purpose.

*Tradução:* A Kobly é uma plataforma de recuperação de vendas e análise de marketing. Usamos ads_read para mostrar ao dono da empresa o desempenho das campanhas dele (gasto, impressões, cliques, CTR, CPC, CPM, compras e conversas iniciadas), por campanha, conjunto e anúncio, ao lado das vendas que a Kobly rastreou pela UTM. Assim ele vê o ROAS real, o lucro e o custo por venda. Os dados só aparecem para a empresa que conectou a conta. Não são compartilhados, vendidos nem usados para outra coisa.

---

## 2. ads_management

**Cole isto (inglês):**

> We use ads_management so the advertiser can take action on their own campaigns directly from the Kobly dashboard, without switching to Ads Manager: turn a campaign, ad set or ad on or off, and change the daily or lifetime budget of a campaign or ad set. Kobly never creates ads and never changes anything automatically — every change is triggered by the user clicking the on/off switch or saving a new budget in the Kobly interface. We also need ads_management to read ad accounts the user manages through a Business portfolio.

*Tradução:* Usamos ads_management para o anunciante agir nas próprias campanhas pela Kobly, sem abrir o Gerenciador de Anúncios: ligar ou pausar uma campanha, um conjunto ou um anúncio, e mudar o orçamento diário ou total. A Kobly nunca cria anúncios e nunca muda nada sozinha. Toda mudança acontece porque a pessoa clicou no botão liga/desliga ou salvou um orçamento novo.

---

## 3. business_management

**Cole isto (inglês):**

> We use business_management so that, when the user connects with Facebook Login for Business, Kobly can list the ad accounts that belong to the user's Business portfolios (not only personal ad accounts) and let the user choose which ones to connect. We only read the list of ad accounts and their names; we do not create, edit or delete any Business Manager assets, users or settings.

*Tradução:* Usamos business_management para, no login com o Facebook, listar as contas de anúncios que estão dentro do Gerenciador de Negócios da pessoa (não só as pessoais), para ela escolher quais conectar. Só lemos a lista e os nomes das contas. Não criamos, editamos nem apagamos nada no Gerenciador de Negócios.

---

## 4. Roteiro dos vídeos (1 vídeo serve para as 3 permissões)

Grave a tela do computador em tela cheia, sem som ou com narração simples, de 1 a 3 minutos. Mostre na ordem:

1. A página de login da Kobly. Entre com a conta de teste.
2. Menu **Anúncios → Facebook Ads**. Clique em **Conectar com Facebook**.
3. Na janelinha do Facebook, mostre a tela pedindo as permissões e clique em **Continuar**.
4. De volta à Kobly, mostre a **lista de contas de anúncios** (business_management), marque uma e clique em **Conectar conta**.
5. Abra a aba **Dashboard** e depois **Campanhas**, **Conjuntos** e **Anúncios**, mostrando as métricas (ads_read).
6. Na aba **Campanhas**:
   - clique no botão **liga/desliga** de uma campanha e mostre a mensagem "Campanha pausada" (ads_management);
   - clique no lápis do **orçamento**, mude o valor e salve (ads_management).
7. Abra o **Gerenciador de Anúncios do Facebook** e mostre que a campanha ficou pausada e o orçamento mudou.
8. Volte à Kobly, aba **Contas**, e mostre o botão **Desconectar**.

Dica: antes de gravar, coloque o idioma do Facebook em inglês. Os revisores entendem melhor.

---

## 5. Instruções de teste (campo "How to test")

**Cole isto (inglês), trocando o e-mail e a senha:**

> 1. Go to https://app.koblay.io and log in with: email: [E-MAIL DA CONTA DE TESTE] / password: [SENHA DA CONTA DE TESTE]
> 2. In the left menu click "Anúncios" (Ads), then the "Facebook Ads" tab.
> 3. Click "Conectar com Facebook" (Connect with Facebook) and approve the permissions in the Facebook popup.
> 4. Select an ad account and click "Conectar conta" (Connect account).
> 5. Open the "Campanhas" (Campaigns), "Conjuntos" (Ad sets) and "Anúncios" (Ads) tabs to see the metrics (ads_read).
> 6. Use the on/off switch next to a campaign to pause or activate it, and the pencil icon in the "Orçamento" (Budget) column to change its budget (ads_management).

---

## 6. Perguntas sobre uso de dados (Data Handling)

Respostas sugeridas:

| Pergunta | Resposta |
|---|---|
| Você compartilha dados da plataforma com terceiros? | **Não** (só provedores de hospedagem que processam em nosso nome) |
| Os dados são usados para anúncios ou vendidos? | **Não** |
| Onde ficam os dados? | Servidores na nuvem (Railway e Vercel), com tokens criptografados (AES-256-GCM) |
| Como o usuário apaga os dados? | Botão "Desconectar" na Kobly e a página `/exclusao-de-dados` |
| Responsável pelos dados | Kobly — suportekobly@gmail.com |

---

## 7. Depois de aprovado

1. Em **Configurações do app → Básico**, confira se o app está **Publicado (Live)**.
2. Peça para um cliente que **não** é testador conectar. Agora deve funcionar.
3. A cota de consultas do Facebook também aumenta, e o aviso "O Facebook limitou" deve sumir.
