/** OpenAI embeddings used for both chunks and queries. */
import OpenAI from 'openai';
import { KNOWN_DIMENSIONS } from './settings.js';

export type Embedder = {
  model: string;
  dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class OpenAIEmbedder implements Embedder {
  readonly dimensions: number;
  private readonly client: OpenAI;
  private readonly rateLimitWaits: number;

  constructor(
    readonly model = 'text-embedding-3-small',
    dimensions: number | null = null,
    { apiKey, client, rateLimitWaits = 6 }: { apiKey?: string; client?: OpenAI; rateLimitWaits?: number } = {},
  ) {
    // OPENAI_BASE_URL is honoured by the SDK, so a proxy works without extra settings.
    this.client = client ?? new OpenAI({ apiKey, maxRetries: 5, timeout: 120_000 });
    this.dimensions = dimensions || (KNOWN_DIMENSIONS[model] ?? 1536);
    this.rateLimitWaits = rateLimitWaits;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    const body: OpenAI.EmbeddingCreateParams = { model: this.model, input: texts };
    if (this.dimensions !== (KNOWN_DIMENSIONS[this.model] ?? this.dimensions)) body.dimensions = this.dimensions;
    let response: OpenAI.CreateEmbeddingResponse;
    for (let attempt = 0; ; attempt++) {
      try {
        response = await this.client.embeddings.create(body);
        break;
      } catch (error) {
        // The SDK already retried; wait longer for a per-minute limit.
        if (!(error instanceof OpenAI.APIError) || error.status !== 429 || attempt >= this.rateLimitWaits) throw error;
        await sleep(Math.min(60, 5 * 2 ** attempt) * 1000);
      }
    }
    const data = [...response.data].sort((a, b) => a.index - b.index);
    if (data.length !== texts.length) {
      throw new Error(`embedding API returned ${data.length} vectors for ${texts.length} texts`);
    }
    return data.map((item) => item.embedding.map(Number));
  }
}
