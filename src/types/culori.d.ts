// culori ships plain JavaScript without types; we declare the few functions we use.
declare module 'culori' {
  export type Color = {
    mode: string;
    alpha?: number;
    [channel: string]: number | string | undefined;
  };
  export function parse(color: string): Color | undefined;
  export function formatHex(color: Color | string): string;
  export function differenceCiede2000(): (a: Color, b: Color) => number;
}
