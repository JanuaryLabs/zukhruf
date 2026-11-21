export default class BaseStemmer {
    /** @protected */
    protected current: string;
    c: number;
    limit: number;
    limit_backward: number;
    bra: number;
    ket: number;
    af: number;
    /**
     * @param {string} value
     */
    setCurrent(value: string): void;
    /**
     * @return {string}
     */
    getCurrent(): string;
    /**
     * @param {BaseStemmer} other
     */
    copy_from(other: BaseStemmer): void;
    /**
     * @param {Array<number>} s
     * @param {number} min
     * @param {number} max
     * @return {boolean}
     */
    in_grouping(s: Array<number>, min: number, max: number): boolean;
    /**
     * @param {Array<number>} s
     * @param {number} min
     * @param {number} max
     * @return {boolean}
     */
    go_in_grouping(s: Array<number>, min: number, max: number): boolean;
    /**
     * @param {Array<number>} s
     * @param {number} min
     * @param {number} max
     * @return {boolean}
     */
    in_grouping_b(s: Array<number>, min: number, max: number): boolean;
    /**
     * @param {Array<number>} s
     * @param {number} min
     * @param {number} max
     * @return {boolean}
     */
    go_in_grouping_b(s: Array<number>, min: number, max: number): boolean;
    /**
     * @param {Array<number>} s
     * @param {number} min
     * @param {number} max
     * @return {boolean}
     */
    out_grouping(s: Array<number>, min: number, max: number): boolean;
    /**
     * @param {Array<number>} s
     * @param {number} min
     * @param {number} max
     * @return {boolean}
     */
    go_out_grouping(s: Array<number>, min: number, max: number): boolean;
    /**
     * @param {Array<number>} s
     * @param {number} min
     * @param {number} max
     * @return {boolean}
     */
    out_grouping_b(s: Array<number>, min: number, max: number): boolean;
    /**
     * @param {Array<number>} s
     * @param {number} min
     * @param {number} max
     * @return {boolean}
     */
    go_out_grouping_b(s: Array<number>, min: number, max: number): boolean;
    /**
     * @param {string} s
     * @return {boolean}
     */
    eq_s(s: string): boolean;
    /**
     * @param {string} s
     * @return {boolean}
     */
    eq_s_b(s: string): boolean;
    /**
     * @param {Array<Array<string|number>>} v
     * @param {?function(): boolean} call_among_func
     * @return {number}
     */
    find_among(v: Array<Array<string | number>>, call_among_func: (() => boolean) | null): number;
    /**
     * @param {Array<Array<string|number>>} v
     * @param {?function(): boolean} call_among_func
     */
    find_among_b(v: Array<Array<string | number>>, call_among_func: (() => boolean) | null): string | number;
    /**
     * @param {string} s
     */
    slice_from(s: string): void;
    /**
     */
    slice_del(): void;
    /**
     * @param {number} c_bra
     * @param {number} c_ket
     * @param {string} s
     */
    insert(c_bra: number, c_ket: number, s: string): void;
    /**
     * @return {string}
     */
    slice_to(): string;
    #private;
}
