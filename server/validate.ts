import type { Request } from 'express';
import { isVideoId } from '../shared/youtube.ts';
import type { DB } from './db.ts';
import { badRequest, notFound } from './http.ts';
import { getSongRow, type SongRow } from './songs.ts';

/** The request body as a plain object (empty when missing or not an object). */
export function body(req: Request): Record<string, unknown> {
  const value: unknown = req.body;
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function intInRange(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function queryString(value: unknown, maxLength = 200): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

/** The :id route param, which must be a YouTube video id of a song we know. */
export function songFromParams(db: DB, req: Request): SongRow {
  const id = req.params.id;
  if (!isVideoId(id)) throw badRequest('Invalid song id');
  const row = getSongRow(db, id);
  if (!row) throw notFound('Song not found');
  return row;
}
