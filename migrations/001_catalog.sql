CREATE TABLE usuario (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome varchar(120) NOT NULL CHECK (length(trim(nome)) >= 2),
  email varchar(254) NOT NULL UNIQUE CHECK (email = lower(email)),
  senha_hash text NOT NULL, ativo boolean NOT NULL DEFAULT true
);
CREATE TABLE insumo (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), nome varchar(120) NOT NULL CHECK (length(trim(nome)) >= 2),
  unidade_medida varchar(2) NOT NULL CHECK (unidade_medida IN ('un','kg','L')),
  estoque_minimo numeric(9,3) NOT NULL CHECK (estoque_minimo >= 0),
  validade_referencia date, ativo boolean NOT NULL DEFAULT true,
  CHECK (unidade_medida <> 'un' OR estoque_minimo = trunc(estoque_minimo))
);
CREATE TABLE produto (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), nome varchar(120) NOT NULL CHECK (length(trim(nome)) >= 2),
  preco numeric(8,2) NOT NULL CHECK (preco > 0), ativo boolean NOT NULL DEFAULT true
);
CREATE TABLE composicao_produto (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), produto_id uuid NOT NULL REFERENCES produto(id),
  insumo_id uuid NOT NULL REFERENCES insumo(id), quantidade numeric(9,3) NOT NULL CHECK (quantidade > 0),
  UNIQUE (produto_id, insumo_id)
);
CREATE INDEX composicao_insumo_idx ON composicao_produto(insumo_id);
-- Tabelas técnicas de infraestrutura; não ampliam as oito entidades de negócio do MVP.
CREATE TABLE sessao (sid varchar PRIMARY KEY, sess json NOT NULL, expire timestamp(6) NOT NULL);
CREATE INDEX sessao_expire_idx ON sessao(expire);
