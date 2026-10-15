import { expect, it } from 'vitest'
import { assertRegularZipEntry } from './zip-entry.ts'

it.each([0, 0o100644, 0o040755])('accepts ordinary ZIP entry mode %s', (mode) => {
  expect(() => assertRegularZipEntry({ fileName: 'payload/item', externalFileAttributes: (mode << 16) >>> 0 })).not.toThrow()
})

it.each([0o120777, 0o010644, 0o020600])('rejects link or special ZIP entry mode %s', (mode) => {
  expect(() => assertRegularZipEntry({ fileName: 'escape', externalFileAttributes: (mode << 16) >>> 0 }))
    .toThrow('links and special entries are not supported')
})
