export const PX_PER_SECOND = 60; // M1 固定；M2 變成可縮放 state
export const timeToPx = (t: number): number => t * PX_PER_SECOND;
export const pxToTime = (px: number): number => px / PX_PER_SECOND;
