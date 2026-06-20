/** Türkçe biçimlendirme yardımcıları (1.248, 78,4 kW vb.). */

const trInt = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 0 });
const trOne = new Intl.NumberFormat("tr-TR", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

export function formatInt(value: number): string {
  return trInt.format(value);
}

export function formatKw(value: number): string {
  return `${trOne.format(value)} kW`;
}
