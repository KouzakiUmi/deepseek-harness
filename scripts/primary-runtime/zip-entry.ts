/** Reject link-shaped ZIP entries before the extractor can create filesystem links. */

/**
 * Allow only ordinary files and directories in interpreter and wheel ZIP payloads.
 * @param entry - ZIP entry metadata supplied by the extractor.
 * @returns Nothing when the entry has no Unix type or names a regular file or directory.
 * @throws When archive metadata declares a symlink or another special filesystem entry.
 */
export function assertRegularZipEntry(entry: { externalFileAttributes: number; fileName: string }): void {
  const type = (entry.externalFileAttributes >>> 16) & 0o170000
  if (type !== 0 && type !== 0o100000 && type !== 0o040000) {
    throw new Error(`runtime archive: links and special entries are not supported: ${entry.fileName}`)
  }
}
