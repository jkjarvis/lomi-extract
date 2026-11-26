import { PrismaClient } from '@prisma/client';

export { Prisma, PrismaClient } from '@prisma/client';
export type {
  Document,
  DocumentVersion,
  ExtractionRun,
  ExtractedValue,
  Review,
  RunStatus,
  ReviewState,
  ReviewAction,
  DocType as DbDocType,
} from '@prisma/client';
export * from './runs.js';

export const DEFAULT_DATABASE_URL = 'postgresql://lomi:lomi@localhost:5432/lomi';

export function createPrisma(url: string = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL): PrismaClient {
  return new PrismaClient({ datasources: { db: { url } } });
}
