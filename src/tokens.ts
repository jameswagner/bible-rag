/** Token counting. The counter is injected so offline checks never need the tokenizer. */
import { getEncoding, type Tiktoken, type TiktokenEncoding } from 'js-tiktoken';
import { split } from './util.js';

export type TokenCounter = {
  name: string;
  count(text: string): number;
  countMany(texts: string[]): number[];
};

/** Counts with the tokenizer used by OpenAI's embedding models (cl100k_base). */
export class TiktokenCounter implements TokenCounter {
  readonly name: string;
  private readonly encoding: Tiktoken;

  constructor(encoding: TiktokenEncoding = 'cl100k_base') {
    this.encoding = getEncoding(encoding); // the ranks ship with js-tiktoken; nothing is downloaded
    this.name = `tiktoken/${encoding}`;
  }

  count(text: string): number {
    // No special tokens allowed or disallowed: "<|endoftext|>" counts as ordinary text, like encode_ordinary.
    return this.encoding.encode(text, [], []).length;
  }

  countMany(texts: string[]): number[] {
    return texts.map((text) => this.count(text));
  }
}

/** Whitespace-separated words: offline and exactly additive. */
export class WordCounter implements TokenCounter {
  readonly name = 'words';

  count(text: string): number {
    return split(text).length;
  }

  countMany(texts: string[]): number[] {
    return texts.map((text) => this.count(text));
  }
}
