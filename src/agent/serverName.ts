/**
 * SERVER_NAME is written in the nominative ("unser Mediaserver", "Felix-Kino"). In sentences like "für …" or
 * "auf …" a leading article or possessive has to be declined, proper names stay as they are.
 */
const FORMS: [RegExp, { akk: string; dat: string }][] = [
  [/^unser\s/i, { akk: 'unseren ', dat: 'unserem ' }],
  [/^unsere\s/i, { akk: 'unsere ', dat: 'unserer ' }],
  [/^der\s/i, { akk: 'den ', dat: 'dem ' }],
  [/^die\s/i, { akk: 'die ', dat: 'der ' }],
  [/^das\s/i, { akk: 'das ', dat: 'dem ' }],
];

export function serverName(name: string, kasus: 'akk' | 'dat'): string {
  for (const [re, forms] of FORMS) {
    const m = name.match(re);
    if (m) {
      const word = forms[kasus];
      // Keep a capitalised article capitalised ("Unser Kino" → "Unseren Kino").
      return (m[0][0] === m[0][0].toUpperCase() ? word[0].toUpperCase() + word.slice(1) : word) + name.slice(m[0].length);
    }
  }
  return name;
}
