export type Card = { id: string; value: number; points: number; displayName: string };

export function genStandard52(): Card[] {
  const suits = ["♠","♥","♦","♣"];
  const cards: Card[] = [];
  for (const s of suits) {
    for (let v = 1; v <= 13; v++) {
      const id = `${s}${v}`;
      cards.push({ id, value: v, points: Math.min(v, 10), displayName: `${v}${s}` });
    }
  }
  return shuffle(cards);
}

function shuffle<T>(a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
