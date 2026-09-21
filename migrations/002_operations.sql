CREATE TABLE operacao (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo varchar(6) NOT NULL CHECK (tipo IN ('COMPRA','VENDA')),
  usuario_id uuid NOT NULL REFERENCES usuario(id),
  data_hora timestamptz NOT NULL DEFAULT now(),
  status varchar(10) NOT NULL DEFAULT 'CONFIRMADA' CHECK (status IN ('CONFIRMADA','CANCELADA')),
  fornecedor_nome varchar(120), forma_pagamento varchar(20),
  total numeric(18,2) NOT NULL CHECK (total > 0),
  chave_idempotencia uuid NOT NULL UNIQUE, requisicao_hash varchar(64) NOT NULL,
  cancelado_em timestamptz, cancelado_por uuid REFERENCES usuario(id), motivo_cancelamento varchar(250),
  CHECK (forma_pagamento IS NULL OR forma_pagamento IN ('DINHEIRO','PIX','DEBITO','CREDITO','TRANSFERENCIA','OUTRO')),
  CHECK ((status='CANCELADA') = (cancelado_em IS NOT NULL)),
  CHECK (tipo='COMPRA' OR fornecedor_nome IS NULL)
);
CREATE INDEX operacao_data_idx ON operacao(data_hora DESC, id);
CREATE TABLE item_operacao (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), operacao_id uuid NOT NULL REFERENCES operacao(id),
  produto_id uuid REFERENCES produto(id), insumo_id uuid REFERENCES insumo(id),
  quantidade numeric(18,3) NOT NULL CHECK (quantidade > 0), valor_unitario numeric(8,2) NOT NULL CHECK (valor_unitario > 0),
  nome_snapshot varchar(120) NOT NULL, unidade_snapshot varchar(2) NOT NULL CHECK (unidade_snapshot IN ('un','kg','L')),
  CHECK ((produto_id IS NULL) <> (insumo_id IS NULL)),
  UNIQUE (operacao_id,produto_id), UNIQUE (operacao_id,insumo_id)
);
CREATE INDEX item_operacao_origem_idx ON item_operacao(operacao_id);
CREATE FUNCTION validar_item_operacao() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tipo_operacao text;
BEGIN
  SELECT tipo INTO tipo_operacao FROM operacao WHERE id=NEW.operacao_id;
  IF (tipo_operacao='COMPRA' AND NEW.insumo_id IS NULL) OR (tipo_operacao='VENDA' AND NEW.produto_id IS NULL) THEN
    RAISE EXCEPTION 'Item incompatível com a operação' USING ERRCODE='23514';
  END IF;
  IF NEW.unidade_snapshot='un' AND NEW.quantidade <> trunc(NEW.quantidade) THEN
    RAISE EXCEPTION 'Unidade exige quantidade inteira' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER item_operacao_validar BEFORE INSERT OR UPDATE ON item_operacao FOR EACH ROW EXECUTE FUNCTION validar_item_operacao();

CREATE TABLE movimentacao_estoque (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), insumo_id uuid NOT NULL REFERENCES insumo(id),
  item_operacao_id uuid REFERENCES item_operacao(id), usuario_id uuid NOT NULL REFERENCES usuario(id),
  natureza varchar(7) NOT NULL CHECK (natureza IN ('ENTRADA','SAIDA')),
  motivo varchar(10) NOT NULL CHECK (motivo IN ('COMPRA','VENDA','AJUSTE','PERDA','ESTORNO')),
  descricao varchar(250) NOT NULL, quantidade numeric(18,3) NOT NULL CHECK (quantidade > 0),
  data_hora timestamptz NOT NULL DEFAULT now(),
  estorno_de uuid UNIQUE REFERENCES movimentacao_estoque(id),
  chave_idempotencia uuid UNIQUE, requisicao_hash varchar(64),
  CHECK ((motivo='ESTORNO') = (estorno_de IS NOT NULL)),
  CHECK (motivo <> 'PERDA' OR natureza='SAIDA'),
  CHECK ((chave_idempotencia IS NULL) = (requisicao_hash IS NULL))
);
CREATE INDEX movimento_saldo_idx ON movimentacao_estoque(insumo_id);
CREATE INDEX movimento_item_idx ON movimentacao_estoque(item_operacao_id);
CREATE INDEX movimento_data_idx ON movimentacao_estoque(data_hora DESC,id);
CREATE UNIQUE INDEX movimento_origem_unico ON movimentacao_estoque(item_operacao_id,insumo_id) WHERE estorno_de IS NULL AND item_operacao_id IS NOT NULL;
CREATE FUNCTION validar_movimento_estoque() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE unidade text; saldo numeric; origem movimentacao_estoque%ROWTYPE;
BEGIN
  SELECT unidade_medida INTO unidade FROM insumo WHERE id=NEW.insumo_id FOR UPDATE;
  IF unidade='un' AND NEW.quantidade<>trunc(NEW.quantidade) THEN
    RAISE EXCEPTION 'Unidade exige quantidade inteira' USING ERRCODE='23514';
  END IF;
  IF NEW.estorno_de IS NOT NULL THEN
    SELECT * INTO origem FROM movimentacao_estoque WHERE id=NEW.estorno_de;
    IF origem.estorno_de IS NOT NULL OR origem.insumo_id<>NEW.insumo_id OR origem.quantidade<>NEW.quantidade OR origem.natureza=NEW.natureza OR origem.item_operacao_id IS DISTINCT FROM NEW.item_operacao_id THEN
      RAISE EXCEPTION 'Estorno incompatível com o movimento original' USING ERRCODE='23514';
    END IF;
  END IF;
  SELECT COALESCE(sum(CASE WHEN natureza='ENTRADA' THEN quantidade ELSE -quantidade END),0) INTO saldo FROM movimentacao_estoque WHERE insumo_id=NEW.insumo_id;
  IF NEW.natureza='SAIDA' AND saldo<NEW.quantidade THEN
    RAISE EXCEPTION 'Saldo insuficiente' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER movimento_validar BEFORE INSERT ON movimentacao_estoque FOR EACH ROW EXECUTE FUNCTION validar_movimento_estoque();
CREATE FUNCTION impedir_alteracao_historico() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Histórico imutável; registre um estorno' USING ERRCODE='23514'; END $$;
CREATE TRIGGER movimento_imutavel BEFORE UPDATE OR DELETE ON movimentacao_estoque FOR EACH ROW EXECUTE FUNCTION impedir_alteracao_historico();
CREATE TRIGGER item_imutavel BEFORE UPDATE OR DELETE ON item_operacao FOR EACH ROW EXECUTE FUNCTION impedir_alteracao_historico();

CREATE TABLE lancamento_financeiro (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), operacao_id uuid UNIQUE REFERENCES operacao(id),
  usuario_id uuid NOT NULL REFERENCES usuario(id), tipo varchar(7) NOT NULL CHECK (tipo IN ('RECEITA','DESPESA')),
  descricao varchar(250) NOT NULL, valor numeric(18,2) NOT NULL CHECK (valor > 0),
  vencimento date, pago_em timestamptz, criado_em timestamptz NOT NULL DEFAULT now(),
  status varchar(9) NOT NULL CHECK (status IN ('PAGO','PENDENTE','CANCELADO')), forma_pagamento varchar(20),
  cancelado_em timestamptz, cancelado_por uuid REFERENCES usuario(id), motivo_cancelamento varchar(250),
  chave_idempotencia uuid UNIQUE, requisicao_hash varchar(64),
  CHECK (forma_pagamento IS NULL OR forma_pagamento IN ('DINHEIRO','PIX','DEBITO','CREDITO','TRANSFERENCIA','OUTRO')),
  CHECK (status<>'PAGO' OR pago_em IS NOT NULL),
  CHECK (status<>'PENDENTE' OR (pago_em IS NULL AND vencimento IS NOT NULL)),
  CHECK ((status='CANCELADO') = (cancelado_em IS NOT NULL)),
  CHECK ((chave_idempotencia IS NULL) = (requisicao_hash IS NULL))
);
CREATE INDEX financeiro_pago_idx ON lancamento_financeiro(pago_em);
CREATE INDEX financeiro_vencimento_idx ON lancamento_financeiro(vencimento);
CREATE INDEX financeiro_cancelado_idx ON lancamento_financeiro(cancelado_em);
