# Google Ads — como liberar o acesso de produção à API

Desde 09/09/2026 o Google **não usa mais o token de desenvolvedor**. O nível de acesso agora é do **projeto "kobly" no Google Cloud**, o mesmo projeto onde está o cliente OAuth "Kobly Web". A Central de API da MCC só serve para o e-mail de contato.

Níveis de acesso:

- **Teste:** só lê contas de teste do Google Ads.
- **Explorer:** contas reais, até 2.880 operações por dia. A análise costuma ser automática.
- **Básico:** contas reais, com mais operações. Exige a **verificação da marca** do projeto.

## Onde pedir

**console.cloud.google.com** → projeto **kobly** → **APIs e serviços** → **Google Ads API** → cartão **Níveis de acesso** → **Gerenciar**.

1. Peça primeiro o **Explorer**. Ele já basta para os primeiros clientes.
2. Depois faça a **verificação da marca** em **Google Auth Platform → Central de verificação**.
3. Em seguida, peça o **Básico**.

O formulário é em inglês. Abaixo estão as respostas prontas para colar.

| Campo do formulário | Resposta para colar |
|---|---|
| Company name | Agência VL Digital LTDA (Kobly) |
| Company website | https://app.koblay.io |
| Contact e-mail | suportekobly@gmail.com |
| Business model / How will you use the API? | Kobly is a SaaS for online businesses. Each customer connects their own Google Ads accounts via OAuth to see campaign, ad group and ad performance next to the sales Kobly tracked through UTM parameters, and can pause/enable items or change a campaign budget from the Kobly dashboard. |
| Who will use the tool? | Advertisers (our customers) managing their own accounts, and agencies managing client accounts under their MCC. External users. |
| Which API services? | Reporting (GoogleAdsService.Search) and Campaign Management (status and budget changes only) |
| Will you create campaigns? | No |
| Design document | Anexe o arquivo **2-google-ads-design-document.pdf** (está nesta mesma pasta) |
| Expected daily operations | Less than 2,000 |

## Cuidado conhecido

O Google avisa que projetos em **"Teste grátis" do Cloud**, ou com faturamento suspenso, podem ser recusados. Por isso não ative o "Teste grátis".

## Verificação da marca e do app no Google Cloud

O Google vai pedir:

- **Página inicial:** https://app.koblay.io. Ela já tem os links de Privacidade, Termos e Exclusão de dados no rodapé.
- **Política de privacidade:** https://app.koblay.io/privacidade. Ela já tem o texto de "Uso Limitado" que o Google exige.
- **Vídeo:**
  - mostrando o botão "Conectar com Google";
  - a tela de permissão do Google, com a **barra de endereço aparecendo**, para mostrar o ID do cliente;
  - as campanhas aparecendo na Kobly;
  - o pausar e o mudar orçamento.
- **Domínio verificado no Google Search Console:** koblay.io (já está verificado).
