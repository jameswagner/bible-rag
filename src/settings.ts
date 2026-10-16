/** Environment-level settings (.env): keys, endpoints, embedding model. */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { InputError } from './errors.js';

export const KNOWN_DIMENSIONS: Record<string, number> = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
};

export type Settings = {
  openaiApiKey: string | null;
  qdrantUrl: string;
  qdrantApiKey: string | null;
  embeddingModel: string;
  embeddingDimensions: number;
  collectionPrefix: string;
};

export const collectionName = (settings: Settings, corpusName: string): string =>
  `${settings.collectionPrefix}${corpusName}`;

/** The nearest .env at or above the working directory. */
function findDotenv(): string | null {
  let directory = process.cwd();
  while (true) {
    const candidate = join(directory, '.env');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

export function loadSettings(): Settings {
  const path = findDotenv();
  if (path) loadDotenv({ path, quiet: true });
  const env = process.env;
  const model = env.HSEARCH_EMBEDDING_MODEL ?? 'text-embedding-3-small';
  const dimensions = Number(env.HSEARCH_EMBEDDING_DIMENSIONS ?? KNOWN_DIMENSIONS[model] ?? 1536);
  if (!Number.isInteger(dimensions)) {
    throw new InputError(`HSEARCH_EMBEDDING_DIMENSIONS must be an integer, got ${env.HSEARCH_EMBEDDING_DIMENSIONS}`);
  }
  return {
    openaiApiKey: env.OPENAI_API_KEY || null,
    qdrantUrl: env.QDRANT_URL ?? 'http://localhost:6333',
    qdrantApiKey: env.QDRANT_API_KEY || null,
    embeddingModel: model,
    embeddingDimensions: dimensions,
    collectionPrefix: env.HSEARCH_COLLECTION_PREFIX ?? 'hsearch_',
  };
}
