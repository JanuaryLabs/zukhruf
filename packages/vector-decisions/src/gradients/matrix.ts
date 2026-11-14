// A matrix of float64 numbers in row-major order, the layout of a PyTorch
// tensor of two dimensions. A batch is a matrix with one row for each example.
export class Matrix {
  readonly rows: number;
  readonly columns: number;
  readonly values: Float64Array;

  constructor(
    rows: number,
    columns: number,
    values: Float64Array = new Float64Array(rows * columns),
  ) {
    if (values.length !== rows * columns)
      throw new RangeError(
        `A ${rows} × ${columns} matrix holds ${rows * columns} numbers, not ${values.length}.`,
      );
    this.rows = rows;
    this.columns = columns;
    this.values = values;
  }

  static fromRows(rows: readonly ArrayLike<number>[]): Matrix {
    const columns = rows[0]?.length ?? 0;
    const values = new Float64Array(rows.length * columns);
    for (const [index, row] of rows.entries()) {
      if (row.length !== columns)
        throw new RangeError(
          `Row ${index} has ${row.length} numbers, but row 0 has ${columns}.`,
        );
      values.set(row, index * columns);
    }
    return new Matrix(rows.length, columns, values);
  }

  // A view of one row: a change to it changes the matrix.
  row(index: number): Float64Array {
    return this.values.subarray(
      index * this.columns,
      (index + 1) * this.columns,
    );
  }

  times(other: Matrix): Matrix {
    this.#fit(other, this.columns === other.rows, 'times');
    const product = new Matrix(this.rows, other.columns);
    for (let i = 0; i < this.rows; i++) {
      const out = product.row(i);
      for (let k = 0; k < this.columns; k++) {
        const factor = this.values[i * this.columns + k] ?? 0;
        const row = other.row(k);
        for (let j = 0; j < other.columns; j++)
          out[j] = (out[j] ?? 0) + factor * (row[j] ?? 0);
      }
    }
    return product;
  }

  timesTransposed(other: Matrix): Matrix {
    this.#fit(other, this.columns === other.columns, 'timesTransposed');
    const product = new Matrix(this.rows, other.rows);
    for (let i = 0; i < this.rows; i++) {
      const left = this.row(i);
      for (let j = 0; j < other.rows; j++) {
        const right = other.row(j);
        let sum = 0;
        for (let k = 0; k < this.columns; k++)
          sum += (left[k] ?? 0) * (right[k] ?? 0);
        product.values[i * other.rows + j] = sum;
      }
    }
    return product;
  }

  transposedTimes(other: Matrix): Matrix {
    this.#fit(other, this.rows === other.rows, 'transposedTimes');
    const product = new Matrix(this.columns, other.columns);
    for (let k = 0; k < this.rows; k++) {
      const left = this.row(k);
      const right = other.row(k);
      for (let i = 0; i < this.columns; i++) {
        const factor = left[i] ?? 0;
        const out = product.row(i);
        for (let j = 0; j < other.columns; j++)
          out[j] = (out[j] ?? 0) + factor * (right[j] ?? 0);
      }
    }
    return product;
  }

  #fit(other: Matrix, fits: boolean, product: string): void {
    if (!fits)
      throw new RangeError(
        `${this.rows} × ${this.columns} and ${other.rows} × ${other.columns} do not fit in ${product}.`,
      );
  }
}
