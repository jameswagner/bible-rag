/** Bad input: config, data, gold references or request arguments. The CLI prints it; the API returns 422. */
export class InputError extends Error {
  override name = 'InputError';
}
