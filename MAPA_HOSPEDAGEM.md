# Publicação — Bendita Gula API

Destino planejado: aplicação no Render e PostgreSQL no Supabase. Este documento mapeia o trabalho pendente; publicar o código no GitHub não publica a aplicação no Render.

## Arquitetura proposta

Frontend compilado e backend no mesmo serviço/endereço HTTPS. O Express atende `/api` e os arquivos estáticos da interface. Os repositórios continuam separados: `BenditaGulaAPI` e `BenditaGulaSIG`.

O processo de build ainda precisa reunir uma versão identificada de cada repositório. Uma opção é uma pipeline que obtém os dois repositórios privados, compila o frontend e o inclui na imagem do backend. O acesso entre repositórios deve usar segredo de CI com leitura restrita, nunca token no Dockerfile ou URL Git versionada. Esta pipeline e os arquivos Docker de produção ainda não existem.

## Alterações necessárias por arquivo

| Arquivo | Situação atual | Preparação para produção |
| --- | --- | --- |
| `src/server.ts` | Escuta em `127.0.0.1`. | Tornar o endereço configurável; no Render usar `0.0.0.0` e a variável `PORT` fornecida pela plataforma. Manter localhost como opção de desenvolvimento. |
| `src/config.ts` | Carrega `.env`; valida `NODE_ENV`, `PORT`, `APP_ORIGIN`, `DATABASE_URL` e `SESSION_SECRET`. | Configurar essas variáveis no painel do Render; adicionar validação dos parâmetros de host, proxy e TLS que forem introduzidos. `APP_ORIGIN` deve ser exatamente a origem HTTPS pública, sem caminho nem barra final. |
| `src/app.ts` | Cookie `Secure` em produção, mas sem configuração de `trust proxy`. | Configurar confiança somente no proxy/topologia do Render, antes de sessão e limitadores. Verificar reconhecimento de HTTPS e IP do cliente; não habilitar confiança irrestrita. |
| `src/app.ts` | Atende apenas a API; encerra com resposta 404. | Servir a pasta compilada do frontend depois das rotas `/api` e antes do 404, sem converter erros da API em HTML. Ajustar CSP apenas se necessário aos recursos realmente usados. |
| `src/db.ts` e `src/database-options.ts` | TLS implementado com `DATABASE_SSL_CA_PATH`, certificado CA e verificação obrigatória quando o caminho está configurado. Pool máximo de 10. | No Render, disponibilizar o certificado como arquivo de configuração e definir seu caminho. Dimensionar pool para os limites do projeto. |
| `compose.yaml` | Banco Docker local, porta `127.0.0.1:5433`, volume persistente. | Manter para desenvolvimento. Produção conecta ao Supabase; não publicar esse banco local na internet. |
| `scripts/setup-env.mjs` | Gera `.env` com localhost e segredos aleatórios locais. | Manter como ferramenta local. Produção recebe segredos próprios no painel, sem reutilizar nem enviar `.env`. |
| `package.json` | `dev` usa watcher; `build` gera `dist`; `start` executa servidor compilado. | Publicação usa instalação reproduzível (`npm ci`), build e `npm start`; não executar `npm run dev`. Fixar versão suportada do Node no ambiente. |
| `src/migrate.ts` | Migrações via `tsx`; depende das variáveis de ambiente e de ferramenta de desenvolvimento. | Definir etapa controlada de migração com dependências disponíveis (ou executar versão compilada), antes de liberar a nova versão. Preservar trava e idempotência existentes. |
| `src/create-user.ts` | Primeiro usuário criado em terminal interativo. | Executar uma única vez em ambiente confiável, apontando ao banco de produção; não criar conta/senha padrão nem publicar endpoint de bootstrap. |
| `tests/*.test.ts` | Usam `DATABASE_URL` e criam/removem schemas temporários. | Executar somente em banco de teste isolado. Não apontar testes à base de produção. |
| `tests/visual-fixture.ts` | Ferramenta de dados de teste. | Não executar em produção nem incorporar sua execução ao deploy. |

## Supabase

- Criar projeto e selecionar região adequada, preferencialmente próxima ao serviço Render.
- Para um servidor Node persistente, usar conexão direta quando a rede permitir; em rede IPv4, considerar o pooler em modo sessão. Obter endereço e parâmetros no painel, sem montar a URL por suposição.
- Guardar `DATABASE_URL` exclusivamente no backend. Usar usuário com privilégios mínimos para execução normal e acesso adequado para migrações; não disponibilizar credenciais PostgreSQL no frontend.
- Como o aplicativo usa sua própria API, desativar a Data API do Supabase. Não expor tabelas de usuários, sessões ou negócio por uma segunda API.
- Aplicar migrações em banco vazio ou transferir os dados locais com procedimento de backup/restauração revisado. Não pressupor que publicar os fontes transfere os dados.
- Programar exportações e guardar cópias fora do Supabase; testar restauração em banco separado.

## Variáveis de produção

| Variável | Conteúdo |
| --- | --- |
| `NODE_ENV` | `production` |
| `APP_ORIGIN` | Origem HTTPS pública da aplicação |
| `PORT` | Porta fornecida pelo Render |
| `DATABASE_URL` | Segredo de conexão PostgreSQL Supabase |
| `DATABASE_SSL_CA_PATH` | Caminho do certificado CA; no Render, caminho do arquivo disponibilizado no serviço |
| `SESSION_SECRET` | Segredo aleatório exclusivo, com pelo menos 64 caracteres |

Host de escuta e confiança de proxy ainda precisam de implementação/configuração. O carregamento do certificado TLS já está implementado. Parâmetros SSL na URL não podem substituir a validação explícita do certificado.

## Conexão Supabase preparada

A configuração remota fica em `.env.supabase`, ignorado pelo Git, enquanto `.env` continua apontando para o banco Docker local. O certificado fica em `certs/`, também ignorado. Os comandos abaixo usam explicitamente o arquivo remoto; execute-os na pasta do backend:

```powershell
npm run supabase:check
npm run supabase:migrate
npm run supabase:usuario
```

`supabase:check` apenas verifica conexão. `supabase:migrate` aplica as migrações ainda não executadas. `supabase:usuario` pede os dados do primeiro usuário pelo terminal; só funciona enquanto não houver usuário. A configuração remota administrativa não serve para publicar o servidor em produção: no Render, definir `NODE_ENV=production` e a origem HTTPS final.

Nesta preparação, a conexão TLS foi verificada e as migrações `001_catalog.sql`, `002_operations.sql` e `003_usability.sql` foram aplicadas ao schema public inicialmente vazio. A Data API foi confirmada como desativada pelo responsável. Não houve transferência de dados locais nem criação de usuário remoto.

Após redefinir a senha no painel Supabase, atualizar somente a conexão no arquivo privado `.env.supabase` e, quando existir, no ambiente do Render. Não enviar credenciais ao Git. Se a senha contiver caracteres especiais, codificá-los corretamente no componente de senha da URL.

## Critérios antes da liberação

- `/api/health` conectado ao banco; migrações concluídas.
- Login, cookie seguro, CSRF, logout e limites funcionando atrás do proxy HTTPS.
- Frontend chamando `/api` pela mesma origem; nenhum segredo na pasta pública.
- Conferir compra, venda, cancelamento e despesas líquidas no ambiente de homologação.
- Backup e procedimento de restauração disponíveis.

## Limites do caminho gratuito

O Render gratuito suspende o serviço após 15 minutos sem tráfego; o primeiro acesso seguinte pode demorar. O Supabase gratuito tem limite de banco de 500 MB e política de pausa por baixa atividade durante sete dias. Uso gratuito contínuo deve considerar esses limites e não representa garantia de disponibilidade.

Referências: [Render Web Services](https://render.com/docs/web-services), [Render gratuito](https://render.com/docs/free), [conexões Supabase](https://supabase.com/docs/guides/database/connecting-to-postgres), [segurança da Data API](https://supabase.com/docs/guides/api/securing-your-api), [backups](https://supabase.com/docs/guides/platform/backups).

## Arquivos excluídos do Git

`.env` e variantes reais, configurações locais de editor/agente, `.npmrc`, chaves/certificados privados, backups, dependências e builds. `.env.example` contém apenas exemplos sem credenciais reais. Configurações de compilação (`package.json`, lockfile, TypeScript) e `compose.yaml` parametrizado permanecem versionados para reproduzir o projeto.
