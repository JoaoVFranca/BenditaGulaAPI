# Bendita Gula SIG — backend

MVP de gestão da lanchonete: autenticação, usuários, insumos, produtos, composição, compras, vendas, estoque, despesas e relatórios de caixa. API REST em Node.js, TypeScript e Express; PostgreSQL via Docker Compose.

## Executar pela primeira vez (PowerShell)

Abra o Docker Desktop e aguarde o motor iniciar. Use uma versão LTS do Node.js compatível (22.12 ou superior; preferencialmente Node 24). Na pasta `TCC-Backend`:

```powershell
npm install
npm run setup:env
npm run db:up
npm run db:migrate
npm run usuario:criar
npm run dev
```

Neste computador, as dependências, o `.env`, o contêiner e as migrações já foram preparados. Crie seu usuário se ainda não tiver feito isso. O servidor escuta em `127.0.0.1:3000`. Execute também o frontend e abra **http://localhost:5173**. Use esse endereço exato: a API aceita a origem definida em `APP_ORIGIN`. Ao receber atualizações, aplique `npm run db:migrate` antes de iniciar a API; o comando preserva os dados e ignora migrações já aplicadas.

### O que o comando de usuário faz?

`npm run usuario:criar` abre perguntas no próprio terminal:

1. Nome.
2. E-mail.
3. Senha de pelo menos 12 caracteres (entrada mascarada).
4. Confirmação da senha.

O comando valida os dados, transforma a senha em um hash scrypt com salt aleatório e insere o primeiro usuário no banco. Não há senha padrão e a senha não vai para arquivo, código ou histórico de comandos. O comando só funciona enquanto não existe usuário; bloqueio transacional impede duas inicializações simultâneas. Depois, entre na aplicação e use **Usuários → Novo usuário**. Todos os usuários autenticados têm o mesmo nível de acesso.

## Docker, passo a passo

- **Imagem**: pacote pronto do PostgreSQL (`postgres:17-alpine`).
- **Contêiner**: processo isolado executando esse pacote.
- **Compose**: lê `compose.yaml` e configura serviço, porta e volume.
- **Volume**: guarda os arquivos do banco fora do ciclo de vida do contêiner. Parar ou recriar o contêiner preserva os dados; o volume não substitui backup.
- **Porta**: `5433` no seu computador aponta para `5432` no contêiner. A porta fica acessível somente localmente.

```powershell
# Iniciar e aguardar o banco estar pronto
npm run db:up

# Ver estado e logs
docker compose ps
docker compose logs --tail 50 db

# Abrir o terminal SQL (sair com \q)
docker compose exec db psql -U tcc -d tcc

# Parar preservando os dados
npm run db:stop
```

Não use `docker compose down -v` se quiser preservar os dados: `-v` remove o volume. A senha do PostgreSQL é definida na primeira criação do volume; editar o `.env` depois não altera a senha de um banco existente.

## Configuração e segurança

`npm run setup:env` gera senhas/segredos aleatórios e não sobrescreve `.env` existente. `.env` é ignorado pelo Git; `.env.example` documenta os campos sem credenciais reais.

- Sessão persistida no PostgreSQL; cookie `HttpOnly`, `SameSite=Lax`, expiração de 8 horas e `Secure` em produção. Login regenera a sessão; logout a destrói.
- Operações de escrita exigem origem permitida, JSON e token CSRF vinculado à sessão, inclusive no login.
- Rotas de negócio exigem sessão e verificam se o usuário continua ativo.
- Schemas estritos validam corpo, UUID, consultas, datas, tipos, limites, campos extras e regras de composição.
- Consultas SQL parametrizadas; composição salva em transação, com bloqueio dos registros envolvidos.
- Limites de requisições e tentativas de login, payload limitado a 32 KB e headers de proteção.
- Erros não retornam detalhes de SQL, stack trace ou hash de senha. Senhas e conteúdo das requisições não são registrados em logs.

Esta configuração executa localmente, com uma instância da API. Para hospedagem, configure HTTPS e proxy de mesma origem para `/api`, `APP_ORIGIN` e segredos de produção; ajuste `trust proxy` somente ao proxy conhecido. O limitador atual fica em memória; múltiplas instâncias exigem armazenamento compartilhado. Não publique o servidor de desenvolvimento Vite. Recuperação de senha, MFA e gestão de sessões por dispositivo não fazem parte desta primeira entrega.

## Contrato básico da API

| Método e rota            | Uso                                                   |
| ------------------------ | ----------------------------------------------------- |
| `GET /api/health`        | Verifica conexão com o banco                          |
| `GET /api/auth/csrf`     | Inicia sessão de segurança e retorna `token`          |
| `POST /api/auth/login`   | Recebe `email`, `senha`; retorna usuário e novo token |
| `GET /api/auth/me`       | Usuário da sessão                                     |
| `POST /api/auth/logout`  | Encerra sessão                                        |
| `GET/POST /api/usuarios` | Lista/cadastra usuários                               |
| `GET/POST /api/insumos`  | Lista/cadastra insumos                                |
| `PUT /api/insumos/:id`   | Edita insumo; unidade permanece fixa                  |
| `GET/POST /api/produtos` | Lista/cadastra produtos com composição                |
| `PUT /api/produtos/:id`  | Edita produto e substitui composição atomicamente     |

Listagens aceitam `busca` e `pagina` e retornam `{ items, more }`, com até 50 registros. Insumos/produtos também aceitam `situacao=TODOS|ATIVOS|INATIVOS` (padrão da API: `TODOS`; interface: `ATIVOS`). Escritas usam o header `X-CSRF-Token`, cookie de sessão e `Origin` configurada. Valores decimais viajam como **strings com ponto**: preço `"12.50"`, quantidade `"0.125"`. O frontend apresenta a formatação brasileira.

Unidades: `un`, `kg`, `L`. Quantidades por unidade são inteiras; peso/volume aceitam três casas decimais. Preços aceitam duas. A unidade é imutável depois do cadastro. Desativar um insumo preserva composições existentes; a interface sinaliza essa situação e a API impede salvar produtos ativos com insumos inativos. Produtos sem composição são permitidos, com aviso de que não terão baixa de estoque.

## Organização e validação

- `src/app.ts`: rotas, segurança e regras de catálogo.
- `src/validation.ts`: schemas das entradas.
- `src/password.ts`: hash e verificação de senha.
- `src/db.ts`: conexão e transações.
- `src/business/`: validações, cálculos decimais exatos, serviços transacionais, rotas e relatórios dos módulos operacionais.
- `migrations/`: SQL versionado, aplicado uma vez por arquivo.
- `tests/api.test.ts`: integração com PostgreSQL real, usando schema temporário isolado e removido ao final.
- `tests/business.test.ts`: integração de compras, vendas, concorrência, idempotência, estornos, ajustes, financeiro e relatórios. Também usa schema temporário isolado.

```powershell
npm run check
npm test
npm run build
npm start
```

Execute os testes com Docker/banco disponíveis. As migrações usam uma tabela técnica `schema_migrations`; as sessões usam `sessao`. Essas tabelas de infraestrutura não alteram as oito entidades de negócio do TCC. Todas as oito entidades estão implementadas, com campos adicionais de rastreabilidade, snapshots e idempotência nas quatro entidades operacionais.

## Operações, estoque e financeiro

- Compra recebida: entrada imediata de estoque e despesa paga ou pendente com vencimento único. Não há etapa persistida de rascunho: a prévia é somente uma validação; a gravação acontece na confirmação.
- Venda: quantidade inteira de produtos, preço do cadastro conferido contra `preco_esperado` e preço praticado opcional (`valor_unitario`), maior ou menor, sempre positivo. A receita usa o preço praticado; sem ele, usa o cadastro. Ambos os preços são preservados no histórico, sem atualizar o cadastro.
- A transação grava operação, itens, movimentos e lançamento juntos. Bloqueios ordenados dos produtos e insumos protegem composição e saldo concorrentes.
- As criações recebem `chave_idempotencia` (UUID). A mesma chave e o mesmo corpo/usuário retornam o registro existente; reutilização com dados diferentes retorna 409. A prévia não reserva estoque: a confirmação verifica tudo novamente.
- Dinheiro é calculado em centavos e quantidades em milésimos com `bigint`. Na compra, cada item exige exatamente um de `valor_unitario` ou `valor_total`. Pelo unitário, o subtotal é arredondado comercialmente para centavos; pelo total informado, os centavos são preservados e o unitário é calculado com oito casas. O total da operação sempre é calculado no servidor pela soma dos subtotais armazenados.
- Cancelar uma operação estorna os movimentos originais, independentemente de alterações posteriores na composição ou no preço. A compra só pode ser cancelada se o estoque suportar a saída. O cancelamento é integral, transacional e idempotente.
- Perdas e ajustes manuais exigem motivo. Ajuste de entrada permite registrar estoque inicial; não gera movimentação financeira. Para corrigir um ajuste, registre outro movimento de natureza oposta e explique o motivo.
- Alertas de mínimo consideram saldo **abaixo** do mínimo. Validade vencida ou dentro de sete dias gera aviso informativo, sem bloqueio automático de venda. Resumos de alertas consideram somente insumos ativos.
- Despesas avulsas podem ser criadas como pagas ou pendentes; somente as pendentes e sem vínculo com operação podem ser editadas. Pagamentos integrais usam data/hora do servidor e não alteram estoque.
- Receitas avulsas são recebidas imediatamente, sem estoque, usando descrição, valor positivo, forma de pagamento e chave de idempotência. Cancelamentos de lançamentos vinculados devem passar pela operação; receitas/despesas avulsas pagas são canceladas com estorno na data atual e preservam o evento original.
- O relatório usa eventos de pagamento e de estorno, no fuso `America/Sao_Paulo`. Um estorno posterior não apaga a receita/despesa de um dia anterior. Saldo final = saldo anterior + resultado do período. Pendências exibem a situação **atual** e vencimentos no período, separadas do caixa efetivo.
- Compras/vendas confirmadas não são editadas: cancele e registre novamente quando possível. Sem parcelas, pagamento parcial, lotes, múltiplos caixas ou fechamento persistido.

### Melhorias de catálogo e relatórios

- `GET /api/insumos/:id` permite abrir o cadastro pelo estoque. `DELETE /api/insumos/:id` e `DELETE /api/produtos/:id` exigem os mesmos controles de sessão, origem e CSRF das outras escritas. Cadastros com histórico/vínculos são bloqueados (409) e podem ser desativados; composição de produto sem histórico é removida junto com ele.
- Criar/editar insumo aceita `criar_produto: true` e `preco_venda` positivo somente em `un`. A transação cria um produto com o mesmo nome, preço inicial e composição fixa de 1 un. `origem_insumo_id` único impede duplicar na edição; mudanças posteriores no insumo não sobrescrevem nome/preço/ativação do produto. A resposta do insumo informa `produto_vinculado_id`.
- Compras/vendas aceitam `observacoes` opcional, até 1.000 caracteres. A migração `003_usability.sql` preserva itens antigos e acrescenta observações, preço de catálogo, subtotal exato, origem do valor e vínculo de venda direta.
- O indicador `despesas_liquidas` é despesas pagas menos estornos de despesas no período. Pode ser negativo quando há estorno de pagamento anterior. `despesas` continua sendo o valor bruto no contrato para conferência, com `estornos_despesas` separado. Resultados/saldos continuam baseados nos eventos efetivos.

### Endpoints adicionais

| Método e rota                       | Uso                                                           |
| ----------------------------------- | ------------------------------------------------------------- |
| `POST /api/operacoes/prever`        | Valida compra/venda e calcula total, sem gravar               |
| `GET/POST /api/operacoes`           | Consulta ou confirma compra/venda                             |
| `GET /api/operacoes/:id`            | Itens e dados históricos da operação                          |
| `POST /api/operacoes/:id/cancelar`  | Estorno integral com `motivo`                                 |
| `GET /api/estoque`                  | Saldos, busca e filtros `alerta=MINIMO` ou `VALIDADE`         |
| `GET /api/estoque/resumo`           | Contadores de alertas de insumos ativos                       |
| `GET/POST /api/estoque/movimentos`  | Histórico ou registro de ajuste/perda                         |
| `GET /api/financeiro`               | Receitas/despesas, filtro de situação e período               |
| `POST /api/financeiro/despesas`     | Despesa avulsa                                                |
| `POST /api/financeiro/receitas`     | Receita avulsa recebida imediatamente                         |
| `PUT /api/financeiro/despesas/:id`  | Edição de despesa avulsa pendente                             |
| `POST /api/financeiro/:id/pagar`    | Pagamento integral com `forma_pagamento`                      |
| `POST /api/financeiro/:id/cancelar` | Cancelamento de receita/despesa avulsa com `motivo`           |
| `GET /api/relatorios/caixa`         | Resumo e totais diários; exige `inicio` e `fim`, até 366 dias |
| `GET /api/relatorios/caixa/eventos` | Pagamentos e estornos paginados                               |

Operações aceitam filtros `tipo`, `status`, `inicio`, `fim`, `pagina`. Histórico de estoque aceita `insumo_id`, `inicio`, `fim`, `pagina`. Financeiro aceita `status`, `inicio`, `fim`, `pagina`; o período considera pagamento ou, quando não pago, vencimento. Datas inicial/final são inclusivas no fuso comercial. As listagens continuam limitadas a 50 registros por página.

```json
{
  "tipo": "COMPRA",
  "chave_idempotencia": "UUID gerado pelo cliente",
  "fornecedor_nome": "Fornecedor opcional",
  "situacao_pagamento": "PENDENTE",
  "vencimento": "2026-10-01",
  "forma_pagamento": null,
  "itens": [
    {
      "insumo_id": "UUID do insumo",
      "quantidade": "2.500",
      "valor_unitario": "12.00"
    }
  ]
}
```

Vendas recebem `tipo=VENDA`, chave, forma de pagamento e itens `{ produto_id, quantidade, preco_esperado, valor_unitario? }`. O servidor compara `preco_esperado` com o cadastro e calcula o valor usando `valor_unitario`, quando informado, ou o preço do banco. Formas aceitas: `DINHEIRO`, `PIX`, `DEBITO`, `CREDITO`, `TRANSFERENCIA`, `OUTRO`. Os textos "UUID ..." no exemplo são placeholders, que devem ser substituídos por UUIDs reais.

Referências: [sessões no Express](https://expressjs.com/en/resources/middleware/session/), [volumes do Compose](https://docs.docker.com/reference/compose-file/volumes/).
