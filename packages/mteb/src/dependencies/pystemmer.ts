import ArabicStemmer from '../../vendor/snowball/arabic-stemmer.js';
import ArmenianStemmer from '../../vendor/snowball/armenian-stemmer.js';
import BasqueStemmer from '../../vendor/snowball/basque-stemmer.js';
import CatalanStemmer from '../../vendor/snowball/catalan-stemmer.js';
import CzechStemmer from '../../vendor/snowball/czech-stemmer.js';
import DanishStemmer from '../../vendor/snowball/danish-stemmer.js';
import DutchStemmer from '../../vendor/snowball/dutch-stemmer.js';
import DutchPorterStemmer from '../../vendor/snowball/dutch_porter-stemmer.js';
import EnglishStemmer from '../../vendor/snowball/english-stemmer.js';
import EsperantoStemmer from '../../vendor/snowball/esperanto-stemmer.js';
import EstonianStemmer from '../../vendor/snowball/estonian-stemmer.js';
import FinnishStemmer from '../../vendor/snowball/finnish-stemmer.js';
import FrenchStemmer from '../../vendor/snowball/french-stemmer.js';
import GermanStemmer from '../../vendor/snowball/german-stemmer.js';
import GreekStemmer from '../../vendor/snowball/greek-stemmer.js';
import HindiStemmer from '../../vendor/snowball/hindi-stemmer.js';
import HungarianStemmer from '../../vendor/snowball/hungarian-stemmer.js';
import IndonesianStemmer from '../../vendor/snowball/indonesian-stemmer.js';
import IrishStemmer from '../../vendor/snowball/irish-stemmer.js';
import ItalianStemmer from '../../vendor/snowball/italian-stemmer.js';
import LithuanianStemmer from '../../vendor/snowball/lithuanian-stemmer.js';
import NepaliStemmer from '../../vendor/snowball/nepali-stemmer.js';
import NorwegianStemmer from '../../vendor/snowball/norwegian-stemmer.js';
import PersianStemmer from '../../vendor/snowball/persian-stemmer.js';
import PolishStemmer from '../../vendor/snowball/polish-stemmer.js';
import PorterStemmer from '../../vendor/snowball/porter-stemmer.js';
import PortugueseStemmer from '../../vendor/snowball/portuguese-stemmer.js';
import RomanianStemmer from '../../vendor/snowball/romanian-stemmer.js';
import RussianStemmer from '../../vendor/snowball/russian-stemmer.js';
import SerbianStemmer from '../../vendor/snowball/serbian-stemmer.js';
import SesothoStemmer from '../../vendor/snowball/sesotho-stemmer.js';
import SpanishStemmer from '../../vendor/snowball/spanish-stemmer.js';
import SwedishStemmer from '../../vendor/snowball/swedish-stemmer.js';
import TamilStemmer from '../../vendor/snowball/tamil-stemmer.js';
import TurkishStemmer from '../../vendor/snowball/turkish-stemmer.js';
import YiddishStemmer from '../../vendor/snowball/yiddish-stemmer.js';

// PyStemmer 3.1.0 (Stemmer.Stemmer), over the JavaScript stemmers of Snowball
// 3.1.0, the version of the libstemmer_c that PyStemmer 3.1.0 binds.
// PyStemmer's cache changes no stem and is not ported. algorithms() is not
// ported: MTEB does not call it.

type SnowballStemmer = new () => { stemWord(word: string): string };

// libstemmer/modules.txt of libstemmer_c 3.1.0: each algorithm with its
// names, in the order of the file.
const MODULES: readonly (readonly [SnowballStemmer, readonly string[]])[] = [
  [ArabicStemmer, ['arabic', 'ar', 'ara']],
  [ArmenianStemmer, ['armenian', 'hy', 'hye', 'arm']],
  [BasqueStemmer, ['basque', 'eu', 'eus', 'baq']],
  [CatalanStemmer, ['catalan', 'ca', 'cat']],
  [CzechStemmer, ['czech', 'cs', 'ces', 'cze']],
  [DanishStemmer, ['danish', 'da', 'dan']],
  [DutchStemmer, ['dutch', 'nl', 'dut', 'nld', 'kraaij_pohlmann']],
  [EnglishStemmer, ['english', 'en', 'eng']],
  [EsperantoStemmer, ['esperanto', 'eo', 'epo']],
  [EstonianStemmer, ['estonian', 'et', 'est']],
  [FinnishStemmer, ['finnish', 'fi', 'fin']],
  [FrenchStemmer, ['french', 'fr', 'fre', 'fra']],
  [GermanStemmer, ['german', 'de', 'ger', 'deu']],
  [GreekStemmer, ['greek', 'el', 'gre', 'ell']],
  [HindiStemmer, ['hindi', 'hi', 'hin']],
  [HungarianStemmer, ['hungarian', 'hu', 'hun']],
  [IndonesianStemmer, ['indonesian', 'id', 'ind']],
  [IrishStemmer, ['irish', 'ga', 'gle']],
  [ItalianStemmer, ['italian', 'it', 'ita']],
  [LithuanianStemmer, ['lithuanian', 'lt', 'lit']],
  [NepaliStemmer, ['nepali', 'ne', 'nep']],
  [NorwegianStemmer, ['norwegian', 'no', 'nor']],
  [PolishStemmer, ['polish', 'pl', 'pol']],
  [PersianStemmer, ['persian', 'fa', 'fas', 'pers']],
  [PortugueseStemmer, ['portuguese', 'pt', 'por']],
  [RomanianStemmer, ['romanian', 'ro', 'rum', 'ron']],
  [RussianStemmer, ['russian', 'ru', 'rus']],
  [SerbianStemmer, ['serbian', 'sr', 'srp']],
  [SpanishStemmer, ['spanish', 'es', 'esl', 'spa']],
  [SwedishStemmer, ['swedish', 'sv', 'swe']],
  [TamilStemmer, ['tamil', 'ta', 'tam']],
  [TurkishStemmer, ['turkish', 'tr', 'tur']],
  [YiddishStemmer, ['yiddish', 'yi', 'yid']],
  [SesothoStemmer, ['sesotho', 'st', 'sot']],
  [PorterStemmer, ['porter']],
  [DutchPorterStemmer, ['dutch_porter']],
];

const STEMMERS = new Map(
  MODULES.flatMap(([stemmer, names]) =>
    names.map((name) => [name, stemmer] as const),
  ),
);

// Python's message for a name that the ascii codec cannot encode: the run
// of characters above U+007F that starts at the first one, by code point.
function asciiEncodeError(name: string): string | null {
  const codePoints = Array.from(name, (char) => char.codePointAt(0) ?? 0);
  const start = codePoints.findIndex((codePoint) => codePoint > 0x7f);
  if (start === -1) return null;
  const firstAscii = codePoints.findIndex(
    (codePoint, index) => index > start && codePoint <= 0x7f,
  );
  const end = firstAscii === -1 ? codePoints.length : firstAscii;
  if (end - start > 1)
    return `'ascii' codec can't encode characters in position ${start}-${end - 1}: ordinal not in range(128)`;
  const codePoint = codePoints[start] ?? 0;
  const hex = codePoint.toString(16);
  const escape =
    codePoint <= 0xff
      ? `\\x${hex.padStart(2, '0')}`
      : codePoint <= 0xffff
        ? `\\u${hex.padStart(4, '0')}`
        : `\\U${hex.padStart(8, '0')}`;
  return `'ascii' codec can't encode character '${escape}' in position ${start}: ordinal not in range(128)`;
}

const OUTSIDE_BMP = /[\u{10000}-\u{10FFFF}]/u;

const PRIVATE_USE = Array.from({ length: 0xf8ff - 0xe000 + 1 }, (_, index) =>
  String.fromCharCode(0xe000 + index),
);

export class Stemmer {
  readonly #stemmer: { stemWord(word: string): string };

  // A name of libstemmer's modules.txt: an algorithm or one of its aliases.
  // Python encodes the name as ASCII first, and raises UnicodeEncodeError
  // for another character.
  constructor(algorithm: string) {
    const encodeError = asciiEncodeError(algorithm);
    if (encodeError !== null) throw new RangeError(encodeError);
    const SnowballStemmer = STEMMERS.get(algorithm);
    if (SnowballStemmer === undefined)
      throw new Error(`Stemming algorithm '${algorithm}' not found`);
    this.#stemmer = new SnowballStemmer();
  }

  // Upstream defect: the C stemmers of libstemmer_c 3.1.0, which PyStemmer
  // 3.1.0 binds, count code points, but the JavaScript stemmers of Snowball
  // 3.1.0 (jsstemmer-3.1.0) count UTF-16 code units. A character outside the
  // Basic Multilingual Plane counts as two characters in JavaScript, so the
  // stem can differ (danish 'e𞤢erer' is 'e𞤢er' in C and 'e𞤢' in
  // JavaScript). No issue of snowballstem/snowball reports it (2026-10-31).
  // To emulate the C stemmers, each such character becomes a private use
  // character (U+E000 to U+F8FF) that the word does not hold, and the stem
  // gets the characters back. No literal or grouping of the 36 stemmers
  // holds a private use character, so it acts as the character does in C.
  stemWord(word: string): string {
    if (!OUTSIDE_BMP.test(word)) return this.#stemmer.stemWord(word);
    const free = PRIVATE_USE.filter((char) => !word.includes(char));
    const toPrivateUse = new Map<string, string>();
    const mapped = Array.from(word, (char) => {
      if (char.length === 1) return char;
      const known = toPrivateUse.get(char);
      if (known !== undefined) return known;
      const placeholder = free[toPrivateUse.size];
      if (placeholder === undefined)
        throw new RangeError(
          `A word to stem holds more distinct characters outside the Basic Multilingual Plane than the ${free.length} private use characters (U+E000 to U+F8FF) that it does not hold.`,
        );
      toPrivateUse.set(char, placeholder);
      return placeholder;
    }).join('');
    const stem = this.#stemmer.stemWord(mapped);
    const fromPrivateUse = new Map(
      Array.from(toPrivateUse, ([char, placeholder]) => [placeholder, char]),
    );
    return Array.from(stem, (char) => fromPrivateUse.get(char) ?? char).join(
      '',
    );
  }

  stemWords(words: Iterable<string>): string[] {
    return Array.from(words, (word) => this.stemWord(word));
  }
}
