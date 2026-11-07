// Money is integer paise inside the database and rupees (number, 2 decimals) in the API.
export const toRupees = (paise) => Math.round(paise) / 100;
export const toPaise = (rupees) => Math.round(Number(rupees) * 100);

export function formatInr(paise) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(paise / 100);
}
