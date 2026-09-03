import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

function findChrome(): string {
  const configuredPath = process.env.CHROME_PATH
  const candidates = [
    configuredPath,
    ...(process.platform === 'win32'
      ? [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
          'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        ]
      : process.platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
        : [
            '/usr/bin/google-chrome-stable',
            '/usr/bin/google-chrome',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
          ]),
  ]
  const chromePath = candidates.find(candidate => candidate !== undefined && existsSync(candidate))
  if (chromePath === undefined) {
    throw new Error('Chrome is required for browser contract tests; set CHROME_PATH.')
  }
  return chromePath
}

async function renderInHeadlessChrome(documentContent: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-browser-contract-'))
  const htmlPath = join(directory, 'index.html')
  const profilePath = join(directory, 'chrome-profile')
  try {
    await writeFile(htmlPath, documentContent, 'utf8')
    const { stdout } = await execFileAsync(findChrome(), [
      '--headless=new',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      `--user-data-dir=${profilePath}`,
      '--dump-dom',
      pathToFileURL(htmlPath).href,
    ], { maxBuffer: 10 * 1024 * 1024, timeout: 20_000 })
    return stdout
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
}

export async function readJsonFromHeadlessChrome(documentContent: string): Promise<unknown> {
  const rendered = await renderInHeadlessChrome(documentContent)
  const encodedResult = /<title>([^<]+)<\/title>/.exec(rendered)?.[1]
  if (encodedResult === undefined) throw new Error('Chrome did not return browser contract results.')
  return JSON.parse(Buffer.from(encodedResult, 'base64').toString('utf8'))
}
