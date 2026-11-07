import type { JsonData } from '@zukhruf/python';

import type { Path } from './path.ts';

// The value of a leaf: JSON data that is not a list or a dict.
export type LeafValue = Exclude<JsonData, JsonData[] | Map<string, JsonData>>;

// A value that is not an object or an array, at its path in one value.
export type Leaf = { readonly path: Path; readonly value: LeafValue };

// One expected leaf and the stated leaf at the same field, or one leaf with no
// other side. Each side keeps its own path, so a stated item that an
// alignment pairs with an expected item at another position keeps its stated
// position. Only a pair with both sides has an agreement: the comparator of
// its field says if the two values agree.
export type LeafPair =
  | {
      readonly expected: Leaf;
      readonly stated: Leaf;
      readonly agrees: boolean;
    }
  | {
      readonly expected: Leaf;
      readonly stated?: undefined;
      readonly agrees?: undefined;
    }
  | {
      readonly expected?: undefined;
      readonly stated: Leaf;
      readonly agrees?: undefined;
    };

// A leaf pair with both sides.
export type BothSides = Extract<LeafPair, { readonly agrees: boolean }>;
