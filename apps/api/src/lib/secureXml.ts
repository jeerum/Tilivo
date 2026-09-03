import { XMLParser } from 'fast-xml-parser';
import { AppError, ErrorCodes } from './errors';

export const MAX_XML_BYTES = 1 * 1024 * 1024;

function rejectForbiddenDeclarations(content: string): void {
  // DTD / external entities are never needed for incoming invoices. Rejecting
  // them up front blocks XXE, file reads and entity-expansion ("billion
  // laughs") attacks regardless of parser behaviour.
  const doctype = /<!DOCTYPE/i;
  const entity = /<!ENTITY/i;
  const external = /<!DOCTYPE[^>]*(SYSTEM|PUBLIC)/i;
  if (doctype.test(content) || entity.test(content) || external.test(content)) {
    throw new AppError(ErrorCodes.invalidXml, 'XML declarations (DOCTYPE/ENTITY) are not allowed', 400);
  }
}

function assertWellFormedXml(content: string): void {
  const stack: string[] = [];
  const tagPattern = /<([!?/]?)([A-Za-z_][A-Za-z0-9_.:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)(\/?)>/g;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(content)) !== null) {
    const marker = match[1]!;
    const name = match[2]!;
    const selfClosing = match[4] === '/';
    if (marker === '!' || marker === '?') continue;
    if (marker === '/') {
      const expected = stack.pop();
      if (expected !== name) {
        throw new AppError(ErrorCodes.invalidXml, 'XML is not well-formed (tag mismatch)', 400);
      }
    } else if (!selfClosing) {
      stack.push(name);
    }
  }
  if (stack.length > 0) {
    throw new AppError(ErrorCodes.invalidXml, 'XML is not well-formed (unclosed tag)', 400);
  }
}

/**
 * Parses untrusted incoming invoice XML with entity handling disabled and a
 * hard byte limit. Returns plain objects (attributes prefixed with @_).
 */
export function parseSecureXml(content: string | Buffer): Record<string, unknown> {
  const text = Buffer.isBuffer(content) ? content.toString('utf8') : content;
  if (Buffer.byteLength(text, 'utf8') > MAX_XML_BYTES) {
    throw new AppError(ErrorCodes.invalidXml, 'XML exceeds the 1 MB size limit', 413);
  }
  rejectForbiddenDeclarations(text);
  assertWellFormedXml(text);
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
    processEntities: false,
    htmlEntities: false,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
    allowBooleanAttributes: false,
  });
  try {
    const result = parser.parse(text);
    if (result === undefined || result === null || typeof result !== 'object') {
      throw new AppError(ErrorCodes.invalidXml, 'XML did not produce an object', 400);
    }
    return result as Record<string, unknown>;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      ErrorCodes.invalidXml,
      `XML parsing failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      400,
    );
  }
}

/** Reads a nested value by dot path, returns undefined when missing. */
export function pickPath(root: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = root;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function pickText(root: Record<string, unknown>, path: string): string {
  const value = pickPath(root, path);
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  if (typeof value === 'object') {
    const text = (value as Record<string, unknown>)['#text'];
    if (typeof text === 'string') return text.trim();
  }
  return JSON.stringify(value);
}

export function pickArray(root: Record<string, unknown>, path: string): Array<Record<string, unknown>> {
  const value = pickPath(root, path);
  if (Array.isArray(value)) return value as Array<Record<string, unknown>>;
  if (value && typeof value === 'object') return [value as Record<string, unknown>];
  return [];
}
