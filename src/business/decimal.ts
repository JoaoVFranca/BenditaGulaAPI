// Inteiros escalados: centavos para dinheiro, milésimos para quantidades.
export function scaled(value: string, places: number): bigint {
  const [whole, fraction = ""] = value.split(".");
  return (
    BigInt(whole) * 10n ** BigInt(places) + BigInt(fraction.padEnd(places, "0"))
  );
}
export function decimal(value: bigint, places: number): string {
  const sign = value < 0n ? "-" : "";
  const digits = (value < 0n ? -value : value)
    .toString()
    .padStart(places + 1, "0");
  return `${sign}${digits.slice(0, -places)}.${digits.slice(-places)}`;
}
export function lineCents(quantity: string, price: string): bigint {
  // Arredondamento comercial por item; o total soma os itens já arredondados.
  return (scaled(quantity, 3) * scaled(price, 2) + 500n) / 1000n;
}
