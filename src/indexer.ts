/** Build a dense Qdrant collection from all planned chunks. */
import { createHash } from 'node:crypto';
import type { QdrantClient } from '@qdrant/js-client-rest';
import type { ChunkPlan } from './chunking.js';
import type { Embedder } from './embedding.js';
import { InputError } from './errors.js';
import { show } from './util.js';
import type { Corpus } from './structure.js';

export const DENSE = 'dense';

export const modelSignature = (embedder: Embedder): string => `${embedder.model}/${embedder.dimensions}`;

function digest(...parts: string[]): string {
  const sha = createHash('sha256');
  for (const part of parts) {
    sha.update(part, 'utf8');
    sha.update(Buffer.from([0]));
  }
  return sha.digest('hex');
}

/** What is sent to the embedding model: the text, under its reference line if configured. */
export function embedText(corpus: Corpus, start: number, end: number, reference?: string, text?: string): string {
  text ??= corpus.text(start, end);
  if (!corpus.config.embedHeadings) return text;
  reference ??= corpus.reference(start, end);
  return `${reference}\n${text}`;
}

export const embedHash = (signature: string, text: string): string => digest('embed-v1', signature, text);

type Point = { id: number; payload: { [key: string]: unknown } };

/** Embed every chunk. Replacing an existing collection requires recreate. */
export async function indexCorpus(
  corpus: Corpus,
  plan: ChunkPlan,
  embedder: Embedder,
  client: QdrantClient,
  collection: string,
  { batchSize = 64, recreate = false, progress }: {
    batchSize?: number;
    recreate?: boolean;
    progress?: (written: number, total: number) => void;
  } = {},
): Promise<number> {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 256) {
    throw new InputError('batch_size must be between 1 and 256');
  }
  if ((await client.collectionExists(collection)).exists) {
    if (!recreate) throw new InputError(`collection ${show(collection)} already exists; use --recreate to rebuild it`);
    await client.deleteCollection(collection);
  }
  await client.createCollection(collection, {
    vectors: { [DENSE]: { size: embedder.dimensions, distance: 'Cosine' } },
  });
  await client.createPayloadIndex(collection, { field_name: 'level', field_schema: 'keyword', wait: true });
  const signature = modelSignature(embedder);
  let batch: Point[] = [];
  let texts: string[] = [];
  let tokens = 0;
  let written = 0;

  const flush = async () => {
    const vectors = await embedder.embed(texts);
    if (vectors.length !== batch.length) throw new Error('embedding count does not match chunk count');
    await client.upsert(collection, {
      wait: true,
      points: batch.map(({ id, payload }, i) => ({ id, vector: { [DENSE]: vectors[i] }, payload })),
    });
    written += batch.length;
    progress?.(written, plan.chunks.length);
  };

  for (const [pointId, chunk] of plan.chunks.entries()) {
    const reference = corpus.reference(chunk.start, chunk.end);
    const text = corpus.text(chunk.start, chunk.end);
    const embedded = embedText(corpus, chunk.start, chunk.end, reference, text);
    const size = corpus.counter.count(embedded);
    if (batch.length && (batch.length >= batchSize || tokens + size > 120_000)) {
      await flush();
      [batch, texts, tokens] = [[], [], 0];
    }
    batch.push({
      id: pointId,
      payload: {
        level: chunk.level, depth: chunk.depth, start: chunk.start, end: chunk.end,
        reference, text, tokens: chunk.tokens,
        embed_hash: embedHash(signature, embedded),
      },
    });
    texts.push(embedded);
    tokens += size;
  }
  if (batch.length) await flush();
  return written;
}
