/** Command line: index, search, serve, eval. */
import { QdrantClient } from '@qdrant/js-client-rest';
import { Command, InvalidArgumentError, Option } from 'commander';
import { ChunkPlan } from './chunking.js';
import { loadConfig } from './config.js';
import { InputError } from './errors.js';
import { loadRecords } from './loader.js';
import { fixed, show } from './util.js';
import { StaleIndexError, Searcher } from './search.js';
import { collectionName, loadSettings, type Settings } from './settings.js';
import { Corpus } from './structure.js';
import { TiktokenCounter, WordCounter } from './tokens.js';

const VERSION = '0.1.0';

type CommonOptions = { config: string; data: string; tokenizer: 'tiktoken' | 'words' };

export function loadCorpus({ config: configPath, data, tokenizer }: CommonOptions): [Corpus, ChunkPlan] {
  const config = loadConfig(configPath);
  const [records, report] = loadRecords(data, config);
  console.log(report.summary());
  const counter = tokenizer === 'words' ? new WordCounter() : new TiktokenCounter();
  const corpus = new Corpus(config, records, counter);
  return [corpus, new ChunkPlan(corpus)];
}

function requireKey(settings: Settings): string {
  if (!settings.openaiApiKey) throw new InputError('OPENAI_API_KEY is not set; put it in .env');
  return settings.openaiApiKey;
}

const qdrant = (settings: Settings, timeoutSeconds: number) =>
  new QdrantClient({ url: settings.qdrantUrl, apiKey: settings.qdrantApiKey ?? undefined, timeout: timeoutSeconds * 1000 });

export async function makeSearcher(corpus: Corpus, plan: ChunkPlan, settings: Settings): Promise<Searcher> {
  const { OpenAIEmbedder } = await import('./embedding.js');
  const apiKey = requireKey(settings);
  const client = qdrant(settings, 60);
  const collection = collectionName(settings, corpus.config.name);
  if (!(await client.collectionExists(collection)).exists) {
    throw new InputError(`collection ${show(collection)} not found at ${settings.qdrantUrl}; run \`hsearch index\` first`);
  }
  const embedder = new OpenAIEmbedder(settings.embeddingModel, settings.embeddingDimensions, { apiKey });
  return new Searcher(corpus, plan, embedder, client, collection);
}

async function cmdIndex(options: CommonOptions & { batchSize: number; recreate: boolean }): Promise<void> {
  const { OpenAIEmbedder } = await import('./embedding.js');
  const { indexCorpus } = await import('./indexer.js');
  const settings = loadSettings();
  const apiKey = requireKey(settings);
  const [corpus, plan] = loadCorpus(options);
  const embedder = new OpenAIEmbedder(settings.embeddingModel, settings.embeddingDimensions, { apiKey });
  const collection = collectionName(settings, corpus.config.name);
  const count = await indexCorpus(corpus, plan, embedder, qdrant(settings, 120), collection, {
    batchSize: options.batchSize,
    recreate: options.recreate,
    progress: (written, total) => process.stderr.write(`\r  ${written}/${total} chunks`),
  });
  process.stderr.write('\n');
  console.log(`Indexed ${count} chunks into ${collection}`);
}

async function cmdSearch(query: string, options: CommonOptions & { k: number; levels?: string[]; expand: boolean }): Promise<void> {
  const [corpus, plan] = loadCorpus(options);
  const searcher = await makeSearcher(corpus, plan, loadSettings());
  const results = await searcher.search(query, options.k, { levels: options.levels ?? null, expand: options.expand });
  results.forEach((result, i) => {
    const matched = result.matched === result.reference ? '' : `  (matched ${result.matched})`;
    console.log(`\n${i + 1}. ${result.reference}  score ${fixed(result.score, 3)}, ${result.level}, ${result.tokens} tokens${matched}`);
    console.log(result.text);
  });
}

async function cmdServe(options: CommonOptions & { host: string; port: number }): Promise<void> {
  const { createApp } = await import('./api.js');
  const [corpus, plan] = loadCorpus(options);
  const server = createApp(await makeSearcher(corpus, plan, loadSettings()));
  await new Promise<void>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) =>
      reject(error.code === 'EADDRINUSE' ? new InputError(`port ${options.port} is already in use; pass --port`) : error),
    );
    server.once('listening', resolve);
    server.listen(options.port, options.host);
  });
  console.log(`hsearch listening on http://${options.host}:${options.port}`);
}

async function cmdEval(options: CommonOptions & { queries: string; out: string; k: number; repeats: number; check: boolean }): Promise<void> {
  const { loadQueries, macroBest, recommend, runAblation, writeReport } = await import('./evaluation.js');
  const [corpus, plan] = loadCorpus(options);
  const queries = loadQueries(options.queries, corpus);
  if (options.check) {
    for (const query of queries) {
      console.log(`${query.id} [${query.type}] ${query.query}\n    accepts: ${query.goldRefs.join('; ')}`);
    }
    console.log(`\n${queries.length} queries; every gold reference resolves against ${options.data}.`);
    return;
  }
  const searcher = await makeSearcher(corpus, plan, loadSettings());
  const ablation = await runAblation(searcher, queries, {
    k: options.k,
    repeats: options.repeats,
    progress: (done, total) => process.stderr.write(`\r  variant ${done}/${total}`),
  });
  process.stderr.write('\n');
  writeReport(ablation, options.out);
  console.log(`report written to ${options.out}`);
  for (const qtype of ablation.types) {
    const [variant, row, near] = recommend(ablation.table(qtype));
    console.log(`  ${qtype}: ${variant.describe()}  (MRR ${fixed(row.mrr, 2)}, ${near.length} near-ties)`);
  }
  const [best, average] = macroBest(ablation);
  console.log(`  one setting for everything: ${best.describe()}  (macro MRR ${fixed(average, 2)})`);
}

function integer(value: string): number {
  if (!/^[+-]?\d+$/.test(value.trim())) throw new InvalidArgumentError(`invalid int value: ${show(value)}`);
  return Number(value);
}

function program(): Command {
  const common = (command: Command) =>
    command
      .option('--config <path>', 'corpus config (TOML or JSON)', 'corpora/kjv.toml')
      .option('--data <path>', 'records in document order', 'data/kjv.json')
      .addOption(
        new Option('--tokenizer <name>', "'words' needs no tokenizer; use it only for offline checks")
          .choices(['tiktoken', 'words'])
          .default('tiktoken'),
      );

  const cli = new Command('hsearch')
    .description('Multi-granularity dense search for hierarchical documents')
    .version(VERSION);

  common(cli.command('index').description('embed all chunks into a new collection'))
    .option('--batch-size <n>', 'texts per embedding call (1–256)', integer, 64)
    .option('--recreate', 'delete the existing collection and rebuild it', false)
    .action(cmdIndex);

  common(cli.command('search').description('run one query from the terminal').argument('<query>'))
    .option('-k <n>', 'results to return', integer, 5)
    .option('--levels <level...>', 'restrict the search to these levels')
    .option('--no-expand', 'return the matched chunk without its parent context')
    .action(cmdSearch);

  common(cli.command('serve').description('start the HTTP API'))
    .option('--host <host>', 'interface to bind', '127.0.0.1')
    .option('--port <port>', 'port to listen on', integer, 8000)
    .action(cmdServe);

  common(cli.command('eval').description('run the ablation and write a markdown report'))
    .option('--queries <path>', 'evaluation queries (JSON lines)', 'eval/queries.jsonl')
    .option('--out <path>', 'markdown report; a .json file is written next to it', 'eval/report.md')
    .option('-k <n>', 'results per query', integer, 10)
    .option('--repeats <n>', 'timed runs per query and variant', integer, 3)
    .option('--check', 'only check that gold references resolve (offline)', false)
    .action(cmdEval);

  return cli;
}

export async function main(argv = process.argv): Promise<number> {
  try {
    await program().parseAsync(argv);
    return 0;
  } catch (error) {
    if (error instanceof InputError || error instanceof StaleIndexError) {
      console.error(`error: ${error.message}`);
      return 2;
    }
    throw error;
  }
}

const code = await main();
if (code) process.exitCode = code;
