export function formatPrice(amount: number | null, currency: string | null) {
  if (amount === null || !currency) return 'Price not set';
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}
