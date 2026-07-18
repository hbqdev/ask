import { readFile, rename, writeFile } from 'fs/promises'

export async function readAskEnv(path: string): Promise<string> {
  return readFile(path, 'utf8')
}

export async function writeAskEnvAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.tmp.${process.pid}`
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, path)
}
