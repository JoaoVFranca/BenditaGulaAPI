-- Fatias são contadas em quantidades inteiras; o histórico existente é preservado.
ALTER TABLE insumo ALTER COLUMN unidade_medida TYPE varchar(5);
ALTER TABLE insumo DROP CONSTRAINT insumo_unidade_medida_check;
ALTER TABLE insumo ADD CONSTRAINT insumo_unidade_medida_check CHECK (unidade_medida IN ('un','kg','L','fatia'));
ALTER TABLE insumo DROP CONSTRAINT insumo_check;
ALTER TABLE insumo ADD CONSTRAINT insumo_check CHECK (unidade_medida NOT IN ('un','fatia') OR estoque_minimo = trunc(estoque_minimo));
ALTER TABLE item_operacao ALTER COLUMN unidade_snapshot TYPE varchar(5);
ALTER TABLE item_operacao DROP CONSTRAINT item_operacao_unidade_snapshot_check;
ALTER TABLE item_operacao ADD CONSTRAINT item_operacao_unidade_snapshot_check CHECK (unidade_snapshot IN ('un','kg','L','fatia'));

CREATE OR REPLACE FUNCTION validar_item_operacao() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tipo_operacao text;
BEGIN
  SELECT tipo INTO tipo_operacao FROM operacao WHERE id=NEW.operacao_id;
  IF (tipo_operacao='COMPRA' AND NEW.insumo_id IS NULL) OR (tipo_operacao='VENDA' AND NEW.produto_id IS NULL) THEN
    RAISE EXCEPTION 'Item incompatível com a operação' USING ERRCODE='23514';
  END IF;
  IF NEW.unidade_snapshot IN ('un','fatia') AND NEW.quantidade <> trunc(NEW.quantidade) THEN
    RAISE EXCEPTION 'Unidades e fatias exigem quantidade inteira' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION validar_movimento_estoque() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE unidade text; saldo numeric; origem movimentacao_estoque%ROWTYPE;
BEGIN
  SELECT unidade_medida INTO unidade FROM insumo WHERE id=NEW.insumo_id FOR UPDATE;
  IF unidade IN ('un','fatia') AND NEW.quantidade<>trunc(NEW.quantidade) THEN
    RAISE EXCEPTION 'Unidades e fatias exigem quantidade inteira' USING ERRCODE='23514';
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
