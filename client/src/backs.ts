import { DEFAULT_BACK, isCardBack } from "@cambio/shared";

/**
 * Where a card back's artwork lives. The files sit in `public/backs`, so Vite
 * copies them into the build untouched and the server hands them out as plain
 * static assets - no bundling, and no import per back.
 *
 * An unknown id falls back to the default rather than producing a broken
 * image, which is what keeps an older client safe against a back added later.
 */
export function backImageUrl(id: string | undefined): string {
  const chosen = id !== undefined && isCardBack(id) ? id : DEFAULT_BACK;
  return `/backs/${chosen}.svg`;
}
