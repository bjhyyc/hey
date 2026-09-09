// What the customer is charged is always the server's number: the checkout
// response carries the plan's amount in fen, and that is what Kaipay collects.
// The list price is a separate, declared figure used only to show the
// discount beside it. They are kept apart on purpose - a display constant must
// never be mistaken for the amount being charged.

const LIST_PRICE_FEN = Number(process.env.NEXT_PUBLIC_PETPACK_LIST_PRICE_FEN ?? "");
// Shown before an order exists, where there is no server number to quote yet.
// The moment one exists - the QR screen - the server's amount takes over.
const DECLARED_PRICE_FEN = Number(process.env.NEXT_PUBLIC_PETPACK_PRICE_FEN ?? "");

export function formatYuan(amountFen: number): string {
  const yuan = amountFen / 100;
  return Number.isInteger(yuan) ? `${yuan}` : yuan.toFixed(2);
}

export type PriceDisplay = {
  /** The amount actually charged, from the server. */
  payable: string;
  /** The declared list price, only when it is genuinely higher than payable. */
  listPrice: string | null;
  /** e.g. "7.8" for 78折, only alongside a list price. */
  discountLabel: string | null;
};

/**
 * Builds what the payment screens show. A missing, malformed, or
 * not-actually-higher list price simply yields no strikethrough - the customer
 * then sees the payable amount alone rather than an invented discount.
 */
export function priceDisplay(amountFen: number | null | undefined): PriceDisplay | null {
  const payableFen = Number(amountFen);
  if (!Number.isFinite(payableFen) || payableFen <= 0) return null;
  const payable = formatYuan(payableFen);
  if (!Number.isFinite(LIST_PRICE_FEN) || LIST_PRICE_FEN <= payableFen) {
    return { payable, listPrice: null, discountLabel: null };
  }
  // 折 is the fraction of the list price still paid, written the way shops
  // write it: a round tenth is one digit (8折), anything else is two (78折).
  const percentOfList = Math.round((payableFen / LIST_PRICE_FEN) * 100);
  return {
    payable,
    listPrice: formatYuan(LIST_PRICE_FEN),
    discountLabel: percentOfList % 10 === 0 ? `${percentOfList / 10}` : `${percentOfList}`
  };
}

/** The price to quote before an order exists. Null when none is configured. */
export function declaredPriceDisplay(): PriceDisplay | null {
  return priceDisplay(DECLARED_PRICE_FEN);
}
