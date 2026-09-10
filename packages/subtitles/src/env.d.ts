/**
 * The WHATWG Encoding API is present in browsers and in Node, but the DOM and
 * Node type libraries are both deliberately out of scope for this package, so
 * the one global it uses is declared here instead.
 */
declare class TextEncoder {
  encode(input?: string): Uint8Array;
}
