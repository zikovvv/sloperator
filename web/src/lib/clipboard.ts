/** Copies, when this page has a clipboard at all (a plain http page may not); true when it went. */
export function copyText(text: string): Promise<boolean> {
  return navigator.clipboard?.writeText(text).then(() => true, () => false) ?? Promise.resolve(false)
}
