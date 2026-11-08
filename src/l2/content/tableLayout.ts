import type { DeepReadonly } from '../readonly.js';
import type { TableBlock, TableCell } from './blocks.js';

/** Domain table limits follow HTML's colspan/rowspan bounds. The whole logical
 * grid also fits in 1000 columns, including cells displaced by earlier rowspans. */
export const MAX_TABLE_COLUMNS = 1000;
export const MAX_TABLE_ROW_SPAN = 65534;

interface CellPlacement {
    cell: DeepReadonly<TableCell>;
    rowIndex: number;
    column: number;
    colSpan: number;
    rowSpan: number;
}

/** Layout only: callers below the Domain boundary receive validated spans. */
export function* tableCellPlacements(table: DeepReadonly<TableBlock>): Generator<CellPlacement> {
    const occupied: number[] = [];
    let rowIndex = 0;
    for (const row of [...(table.headerRows ?? []), ...table.rows]) {
        let column = 0;
        for (const cell of row.cells) {
            const colSpan = cell.colSpan ?? 1, rowSpan = cell.rowSpan ?? 1;
            const overlaps = (): boolean => {
                for (let i = 0; i < colSpan; i++) if (occupied[column + i] > rowIndex) return true;
                return false;
            };
            while (overlaps()) column++;
            // Yield before occupying the range so boundary validation can stop
            // at the first over-wide placement without allocating that range.
            yield { cell, rowIndex, column, colSpan, rowSpan };
            for (let i = 0; i < colSpan; i++) occupied[column + i] = rowIndex + rowSpan;
            column += colSpan;
        }
        rowIndex++;
    }
}
