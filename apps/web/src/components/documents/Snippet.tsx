// SPDX-License-Identifier: AGPL-3.0-only
import { snippetParts } from '@/lib/documents';

/** Plain-text snippet with highlighted ranges: React text nodes and <mark> only, never HTML. */
export function Snippet({
  text,
  ranges,
}: {
  text: string;
  ranges: readonly (readonly [number, number])[];
}) {
  return (
    <>
      {snippetParts(text, ranges).map((p, i) =>
        p.mark ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>,
      )}
    </>
  );
}
