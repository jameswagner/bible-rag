# hsearch: Bible search at multiple sizes

Chunk a document at every level of its hierarchy (verse, chapter, book), embed the chunks with
OpenAI, store them in your own Qdrant instance, and expose `POST /search` with references, text,
and scores.

## Run it

From this directory (needs Node 20+):

```bash
cp .env.example .env            # set OPENAI_API_KEY (or rely on a .env further up the tree)
npm install
docker compose up -d            # local Qdrant
npm run hsearch -- index        # embeds every chunk into a new collection
npm run hsearch -- serve        # http://127.0.0.1:8000
```

Commands default to `corpora/kjv.toml` and `data/kjv.json`, the King James Bible (public domain)
with one record per verse. It ships with the repo, and the evaluation queries are written against
it. Book names are as they appear in the file: most are short (`Genesis`, `John`), and some keep
their full title (`The General Epistle of James`).

Use the same data, config, tokenizer, and embedding model when indexing and serving. An existing
collection is not updated incrementally. To delete it and rebuild:

```bash
npm run hsearch -- index --recreate
```

The `.env` is found by searching upward from the working directory. Supported variables:
`OPENAI_API_KEY`, `OPENAI_BASE_URL` (read by the OpenAI SDK; useful for a proxy), `QDRANT_URL`,
`QDRANT_API_KEY`, `HSEARCH_EMBEDDING_MODEL`, `HSEARCH_EMBEDDING_DIMENSIONS`, and
`HSEARCH_COLLECTION_PREFIX` (default `hsearch_`, so the KJV collection is `hsearch_kjv`).

## Search

```bash
curl localhost:8000/search -H 'content-type: application/json' \
  -d '{"query":"love is patient","k":5,"expand":false}'

npm run hsearch -- search "love is patient" -k 5 --no-expand
npm run hsearch -- search "Jesus wept" --levels verse chapter
```

| Field | Default | Meaning |
| --- | --- | --- |
| `query` | required | Query text, 1–4000 characters |
| `k` | 5 | Requested results, 1–50 |
| `levels` | all | Optional list such as `["verse", "chapter"]` |
| `expand` | true | Return the surrounding parent context when it fits |

Each result contains `reference`, `text`, `score` (cosine similarity), `level`, `tokens`, and
`matched` (the reference that matched before expansion). Overlapping results are skipped, so fewer
than k results may be returned. `GET /health` reports the corpus name and levels.

Errors return `{"detail": ...}`: 422 for an invalid body or an unknown level, and 409
when the collection does not match the loaded data, config, or model. Re-index in that case.

## How it works

| Module | Role |
| --- | --- |
| `src/config.ts` | Validates the corpus TOML/JSON: levels, token limits, labels |
| `src/loader.ts` | Loads records, normalises text, reports every change it made |
| `src/structure.ts` | `Corpus`: leaves, atoms (oversized leaves split), unit runs, references |
| `src/splitting.ts` | Sentence → clause → word splitting; balanced packing |
| `src/chunking.ts` | `ChunkPlan`: unit / split / window chunks at every level |
| `src/indexer.ts` | Embeds chunks into one Qdrant collection, with a hash per point |
| `src/search.ts` | Dense search, parent expansion, overlap removal, stale-index check |
| `src/evaluation.ts` | The ablation: every level alone and together, with and without expansion |
| `src/api.ts` | `node:http` server with a Zod request schema |
| `src/cli.ts` | `index`, `search`, `serve`, `eval` |
| `src/references/` | Reference styles: `default`, `bible`, and `outline.toml` |
| `src/util.ts` | Shared text and number helpers: whitespace, message formatting, rounding, "did you mean" |

## Evaluate

```bash
npm run hsearch -- eval --check   # offline: verify gold references against the loaded corpus
npm run hsearch -- eval           # writes eval/report.md and eval/report.json
```

The 30 bundled queries are scored strictly: a hit requires token-range F1 ≥ 0.5 against
an acceptable gold passage, and the report covers hit@1/3/5, MRR, tokens returned, and latency,
overall and by query type.

All commands accept `--config`, `--data`, and `--tokenizer`. The default tokenizer is
`js-tiktoken` with `cl100k_base`. Its vocabulary ships with the package, so nothing is downloaded.
`--tokenizer words` measures sizes in words instead.
