ALTER TABLE produto ADD COLUMN origem_insumo_id uuid UNIQUE REFERENCES insumo(id);
ALTER TABLE operacao ADD COLUMN observacoes varchar(1000);
ALTER TABLE item_operacao ADD COLUMN subtotal numeric(18,2);
ALTER TABLE item_operacao ADD COLUMN preco_catalogo numeric(8,2);
ALTER TABLE item_operacao ADD COLUMN valor_informado varchar(8) NOT NULL DEFAULT 'UNITARIO' CHECK (valor_informado IN ('UNITARIO','TOTAL'));
-- Backfill restrito à migração: mantém o valor histórico calculado pela versão anterior.
ALTER TABLE item_operacao DISABLE TRIGGER item_imutavel;
UPDATE item_operacao SET subtotal=round(quantidade*valor_unitario,2),preco_catalogo=CASE WHEN produto_id IS NOT NULL THEN valor_unitario ELSE NULL END;
ALTER TABLE item_operacao ENABLE TRIGGER item_imutavel;
ALTER TABLE item_operacao ALTER COLUMN subtotal SET NOT NULL;
ALTER TABLE item_operacao ADD CHECK (subtotal>0);
ALTER TABLE item_operacao ALTER COLUMN valor_unitario TYPE numeric(18,8);
