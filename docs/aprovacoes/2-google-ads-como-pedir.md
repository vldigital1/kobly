# Google Ads — como pedir o "Acesso básico" do token de desenvolvedor

Onde: na sua **conta de administrador (MCC)** do Google Ads, em **Ferramentas → Configuração → Central de API**, botão **Solicitar acesso básico**.

O formulário é em inglês. Abaixo estão as respostas prontas para colar.

| Campo do formulário | Resposta para colar |
|---|---|
| Company name | Kobly |
| Company website | https://kobly-six.vercel.app (troque por https://koblay.io quando o domínio estiver no ar) |
| Contact e-mail | contato@koblay.io |
| Business model / How will you use the API? | Kobly is a SaaS for online businesses. Each customer connects their own Google Ads accounts via OAuth to see campaign, ad group and ad performance next to the sales Kobly tracked through UTM parameters, and can pause/enable items or change a campaign budget from the Kobly dashboard. |
| Who will use the tool? | Advertisers (our customers) managing their own accounts, and agencies managing client accounts under their MCC. External users. |
| Which API services? | Reporting (GoogleAdsService.Search) and Campaign Management (status and budget changes only) |
| Will you create campaigns? | No |
| Design document | Anexe o arquivo **2-google-ads-design-document.pdf** (está nesta mesma pasta) |
| Expected daily operations | Less than 2,000 |

## Depois de enviar

1. O Google responde por e-mail, geralmente em alguns dias. Às vezes ele pede mais detalhes. Se pedir, me mande o e-mail que eu escrevo a resposta.
2. Enquanto não aprova, o token funciona só com **contas de teste**.
3. Aprovado: siga o passo D do guia (publicar a tela de consentimento e pedir a verificação do app no Google Cloud).

## Verificação do app no Google Cloud (passo D)

O Google vai pedir:

- **Página inicial:** https://kobly-six.vercel.app. Ela já tem os links de Privacidade, Termos e Exclusão de dados no rodapé.
- **Política de privacidade:** https://kobly-six.vercel.app/privacidade. Ela já tem o texto de "Uso Limitado" que o Google exige.
- **Vídeo:**
  - mostrando o botão "Conectar com Google";
  - a tela de permissão do Google, com a **barra de endereço aparecendo**, para mostrar o ID do cliente;
  - as campanhas aparecendo na Kobly;
  - o pausar e o mudar orçamento.
- **Domínio verificado no Google Search Console.** O Google não aceita `vercel.app` como domínio seu. Para essa etapa, o ideal é já usar **koblay.io**.
