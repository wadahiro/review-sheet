// The floating cell toolbar's state — a LEAF, so both renderers can report a
// hovered cell into it: the sheet's own table and the one drawn from a
// hand-maintained document. Two stores would be two toolbars fading over each
// other, which is the thing this store exists to prevent.

import type { ReviewItem } from "../prompt.js";

export type CellToolCtx = {
  rect: DOMRect;
  target: ReviewItem["target"];
  field: string;
  effectiveValue: string;
  // See ReviewModal: the clicked cell's row stores one value for every
  // environment, so the finding's scope has to be asked rather than assumed.
  sharedRow?: boolean;
  hasReview: boolean;
  canCopy: boolean;
  reviewEnabled: boolean;
  // Editing is offered only on the two fields the recipient owns (value,
  // remarks) — see EDITABLE_FIELDS.
  editEnabled: boolean;
  hasEdit: boolean;
  // Row-level: offered on the key cell only. `rowDeleted` flips the action
  // between striking the row through and putting it back.
  canDelete: boolean;
  rowDeleted: boolean;
  // The cell's horizontal scroll container, so wheel/swipe over the (fixed,
  // overlaying) toolbar can be forwarded to the table beneath it.
  scroller: HTMLElement | null;
};

let cellToolSetter: ((c: CellToolCtx | null) => void) | null = null;

// The host registers itself here; there is one, for the whole table.
export function setCellToolSetter(fn: ((c: CellToolCtx | null) => void) | null): void {
  cellToolSetter = fn;
}
let cellToolTimer: ReturnType<typeof setTimeout> | undefined;
// While scrolling, cells slide under a stationary cursor and each fires
// mouseenter — which would re-show the toolbar on every frame (flicker). Suppress
// re-showing until scrolling has settled for this long.
let cellToolSuppressedUntil = 0;

export function suppressCellToolWhileScrolling(): void {
  cellToolSuppressedUntil = Date.now() + 250;
  hideCellToolNow();
}

export function showCellTool(c: CellToolCtx): void {
  if (Date.now() < cellToolSuppressedUntil) return;
  if (cellToolTimer) clearTimeout(cellToolTimer);
  cellToolSetter?.(c);
}
export function keepCellTool(): void {
  if (cellToolTimer) clearTimeout(cellToolTimer);
}
export function hideCellToolSoon(): void {
  if (cellToolTimer) clearTimeout(cellToolTimer);
  cellToolTimer = setTimeout(() => cellToolSetter?.(null), 110);
}
export function hideCellToolNow(): void {
  if (cellToolTimer) clearTimeout(cellToolTimer);
  cellToolSetter?.(null);
}

