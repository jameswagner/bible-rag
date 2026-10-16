/** HTTP API: POST /search, GET /health. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { z } from 'zod';
import { InputError } from './errors.js';
import { levelNames } from './config.js';
import { StaleIndexError, type Searcher } from './search.js';

const MAX_BODY_BYTES = 1 << 20;

const SearchRequestSchema = z.object({
  query: z.string().min(1).max(4000),
  k: z.number().int().min(1).max(50).default(5),
  levels: z.array(z.string()).nullable().default(null).describe('Restrict the search to these levels'),
  expand: z.boolean().default(true).describe('Return the surrounding parent chunk as context'),
});

/** An error the handler turns into a status code. The body is {"detail": ...}. */
class HttpError extends Error {
  constructor(readonly status: number, readonly detail: unknown) {
    super(typeof detail === 'string' ? detail : `HTTP ${status}`);
  }
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  response.end(text);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'request body too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
  } catch {
    throw new HttpError(422, 'request body is not valid JSON');
  }
}

export function createApp(searcher: Searcher): Server {
  const routes: { [route: string]: (request: IncomingMessage) => Promise<unknown> } = {
    'GET /health': async () => {
      const config = searcher.corpus.config;
      return { status: 'ok', corpus: config.name, levels: levelNames(config) };
    },
    'POST /search': async (request) => {
      const body = SearchRequestSchema.parse(await readJson(request));
      const results = await searcher.search(body.query, body.k, { levels: body.levels, expand: body.expand });
      return {
        results: results.map(({ reference, text, score, level, tokens, matched }) => ({
          reference, text, score, level, tokens, matched,
        })),
      };
    },
  };

  return createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    const handler = routes[`${request.method} ${path}`];
    try {
      if (!handler) {
        const known = Object.keys(routes).some((route) => route.endsWith(` ${path}`));
        throw known ? new HttpError(405, 'Method Not Allowed') : new HttpError(404, 'Not Found');
      }
      send(response, 200, await handler(request));
    } catch (error) {
      if (error instanceof HttpError) send(response, error.status, { detail: error.detail });
      else if (error instanceof z.ZodError) send(response, 422, { detail: error.issues });
      else if (error instanceof StaleIndexError) send(response, 409, { detail: error.message });
      else if (error instanceof InputError) send(response, 422, { detail: error.message });
      else {
        console.error(error);
        send(response, 500, { detail: 'Internal Server Error' });
      }
    }
  });
}
