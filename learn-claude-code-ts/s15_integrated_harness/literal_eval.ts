import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
let unicode_names: Record<string, string> | undefined;
function unicode_character(name: string): string {
  unicode_names ??= JSON.parse(gunzipSync(readFileSync(new URL('./unicode-names.json.gz', import.meta.url))).toString('utf8'));
  const character = unicode_names![name.toUpperCase()];
  if (character === undefined) throw new Error('Unknown Unicode character name');
  return character;
}
// Safe literal parser for ast.literal_eval's data expressions. Never executes input.
class PythonLiteral {
  constructor(public kind: 'tuple' | 'set' | 'bytes' | 'number' | 'complex' | 'ellipsis', public value: any) {}
}
export function is_python_dict(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof PythonLiteral));
}
export function literal_eval(source: string): unknown {
  let position = 0;
  function whitespace(): void {
    while (position < source.length) {
      if (/\s/.test(source[position])) position += 1;
      else if (source[position] === '#') { while (position < source.length && source[position] !== '\n') position += 1; }
      else break;
    }
  }
  function string(): string | PythonLiteral {
    const prefix = source.slice(position).match(/^(?:br|rb|r|u|b)?(?=['"])/i)?.[0] ?? '';
    position += prefix.length;
    const raw = /r/i.test(prefix), bytes = /b/i.test(prefix);
    const quote = source[position++];
    const triple = source.slice(position, position + 2) === quote.repeat(2);
    if (triple) position += 2;
    const delimiter = triple ? quote.repeat(3) : quote;
    let result = '';
    while (position < source.length) {
      if (source.startsWith(delimiter, position)) { position += delimiter.length; return bytes ? new PythonLiteral('bytes', result) : result; }
      const character = source[position++];
      if (bytes && character.charCodeAt(0) > 127) throw new Error('bytes can only contain ASCII literal characters');
      if (character !== '\\') {
        if (!triple && /[\r\n]/.test(character)) throw new Error('Unterminated string');
        result += character; continue;
      }
      if (position >= source.length) throw new Error('Unterminated escape');
      let escape = source[position++];
      if (raw) { result += '\\' + escape; continue; }
      if (escape === '\r' && source[position] === '\n') { position += 1; escape = '\n'; }
      const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', a: '\x07', '\\': '\\', "'": "'", '"': '"', '\n': '' };
      if (Object.hasOwn(escapes, escape)) result += escapes[escape];
      else if (escape === 'x' || (!bytes && ['u', 'U'].includes(escape))) {
        const length = escape === 'x' ? 2 : escape === 'u' ? 4 : 8;
        const digits = source.slice(position, position + length);
        if (!new RegExp(`^[0-9a-fA-F]{${length}}$`).test(digits)) throw new Error('Invalid escape');
        result += String.fromCodePoint(parseInt(digits, 16)); position += length;
      } else if (!bytes && escape === 'N') {
        const match = source.slice(position).match(/^\{([^}]+)\}/);
        if (!match) throw new Error('Invalid Unicode name escape');
        result += unicode_character(match[1]); position += match[0].length;
      } else if (/[0-7]/.test(escape)) {
        let digits = escape;
        while (digits.length < 3 && /[0-7]/.test(source[position] ?? '')) digits += source[position++];
        result += String.fromCharCode(parseInt(digits, 8) % (bytes ? 256 : 0x110000));
      } else result += '\\' + escape;
    }
    throw new Error('Unterminated string');
  }
  function number(): unknown {
    const sign = /^[+-]/.test(source[position]) ? source[position++] : '';
    whitespace();
    const digits = source.slice(position).match(/^(?:0[xX](?:_?[0-9a-fA-F])+|0[oO](?:_?[0-7])+|0[bB](?:_?[01])+|(?:(?:\d(?:_?\d)*)(?:\.(?:\d(?:_?\d)*)?)?|\.(?:\d(?:_?\d)*))(?:[eE][+-]?\d(?:_?\d)*)?)[jJ]?/);
    if (!digits) throw new Error('Expected a numeric literal');
    position += digits[0].length;
    const token = digits[0].replaceAll('_', '');
    const imaginary = /j$/i.test(token), float = /[.eEjJ]/.test(token) && !/^0[xob]/i.test(token);
    const numeric = imaginary ? Number(token.slice(0, -1)) : Number(token);
    if (!float && /^0\d*[1-9]/.test(token)) throw new Error('Leading zeros in decimal integer');
    const value = numeric * (sign === '-' ? -1 : 1);
    if (imaginary) return new PythonLiteral('complex', [0, value]);
    if (!float && !Number.isSafeInteger(value)) return BigInt(token) * (sign === '-' ? -1n : 1n);
    return float ? new PythonLiteral('number', value) : value;
  }
  function atom(): unknown {
    whitespace();
    const character = source[position];
    if (/^(?:br|rb|r|u|b)?['"]/i.test(source.slice(position))) {
      let result = string(); whitespace();
      while (/^(?:br|rb|r|u|b)?['"]/i.test(source.slice(position))) {
        const next = string();
        if (typeof result === 'string' && typeof next === 'string') result += next;
        else if (result instanceof PythonLiteral && next instanceof PythonLiteral && result.kind === 'bytes' && next.kind === 'bytes') result.value += next.value;
        else throw new Error('cannot mix bytes and nonbytes literals');
        whitespace();
      }
      return result;
    }
    if (character === '[' || character === '(' || character === '{') {
      position += 1; whitespace();
      const end = character === '[' ? ']' : character === '(' ? ')' : '}';
      const items: unknown[] = [];
      const object: Record<string, unknown> = Object.create(null);
      let dictionary = character === '{' && source[position] === '}', comma = false;
      while (source[position] !== end) {
        if (position >= source.length) throw new Error('Unclosed literal');
        const item = value(); whitespace();
        if (character === '{' && source[position] === ':') {
          dictionary = true; position += 1;
          if (Array.isArray(item) || is_python_dict(item) || item instanceof PythonLiteral && item.kind === 'set') throw new Error('unhashable dictionary key');
          object[python_str(item)] = value();
        } else { if (dictionary) throw new Error('Expected colon'); items.push(item); }
        whitespace();
        if (source[position] === end) break;
        if (source[position++] !== ',') throw new Error('Expected comma');
        comma = true; whitespace();
      }
      position += 1;
      if (character === '[') return items;
      if (character === '(') return items.length === 1 && !comma ? items[0] : new PythonLiteral('tuple', items);
      if (dictionary) { if (items.length) throw new Error('Mixed set and dictionary'); return object; }
      return new PythonLiteral('set', [...new Set(items)]);
    }
    const keyword = source.slice(position).match(/^(True|False|None|\.\.\.|set\s*\(\s*\))/);
    if (keyword) {
      position += keyword[0].length;
      return keyword[0] === 'None' ? null : keyword[0] === 'True' ? true : keyword[0] === 'False' ? false : keyword[0] === '...' ? new PythonLiteral('ellipsis', null) : new PythonLiteral('set', []);
    }
    return number();
  }
  function value(): unknown {
    const left = atom(); whitespace();
    if (['+', '-'].includes(source[position])) {
      const operation = source[position++]; whitespace();
      if (/^[+-]/.test(source[position])) throw new Error('Invalid complex expression');
      const right = number();
      const real = left instanceof PythonLiteral && left.kind === 'number' ? left.value : left;
      if (typeof real !== 'number' || !(right instanceof PythonLiteral) || right.kind !== 'complex') throw new Error('Only complex literals support arithmetic');
      return new PythonLiteral('complex', [real, right.value[1] * (operation === '-' ? -1 : 1)]);
    }
    return left;
  }
  let result = value(); whitespace();
  if (source[position] === ',') {
    const items = [result];
    while (source[position] === ',') { position += 1; whitespace(); if (position === source.length) break; items.push(value()); whitespace(); }
    result = new PythonLiteral('tuple', items);
  }
  if (position !== source.length) throw new Error('Unexpected text after literal');
  return result;
}
export function python_str(value: unknown): string {
  if (value === null) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (value instanceof PythonLiteral) {
    const item = value.value;
    if (value.kind === 'ellipsis') return 'Ellipsis';
    if (value.kind === 'bytes') return 'b' + repr(item, true);
    if (value.kind === 'number') return Number.isFinite(item) ? Number.isInteger(item) ? `${Object.is(item, -0) ? '-0' : item}.0` : String(item) : String(item).replace('Infinity', 'inf');
    if (value.kind === 'complex') { const [real, imag] = item; return real === 0 ? `${imag}j` : `(${real}${imag >= 0 ? '+' : ''}${imag}j)`; }
    const items = item.map(python_repr).join(', ');
    return value.kind === 'tuple' ? `(${items}${item.length === 1 ? ',' : ''})` : item.length ? `{${items}}` : 'set()';
  }
  if (Array.isArray(value)) return `[${value.map(python_repr).join(', ')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).map(([key, item]) => `${repr(key)}: ${python_repr(item)}`).join(', ')}}`;
  return String(value);
}
function python_repr(value: unknown): string { return typeof value === 'string' ? repr(value) : python_str(value); }
function repr(value: string, bytes = false): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  let result = quote;
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (character === '\\' || character === quote) result += '\\' + character;
    else if (character === '\n') result += '\\n';
    else if (character === '\r') result += '\\r';
    else if (character === '\t') result += '\\t';
    else if (code < 32 || code === 127 || bytes && code > 126) result += `\\x${code.toString(16).padStart(2, '0')}`;
    else result += character;
  }
  return result + quote;
}
