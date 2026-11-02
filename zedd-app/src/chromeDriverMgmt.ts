import which from 'async-which'
import { promisify } from 'util'
import { Extract } from 'unzipper'
import { withDir as withTmpDir } from 'tmp-promise'
import { exec } from 'child_process'
import { dirname, join } from 'path'
import { promises as fsp } from 'fs'
import { get as httpsGet } from 'https'
import sudo from 'sudo-prompt'

import { fileExists } from './util'

const isMac = process.platform === 'darwin'
const isWin = process.platform === 'win32'

export const getEnvPathChromePath = async () => {
  const chromePath = (await which('chrome'))?.trim()
  if (!chromePath) {
    throw new Error('Could not find Google Chrome! Is it installed and on the path?')
  }
  return chromePath
}

export const getChromeVersion = async (chromePath: string) => {
  if (isWin) {
    const { stdout } = await promisify(exec)(
      `powershell -NoProfile -Command "(Get-Item '${chromePath}').VersionInfo.ProductVersion"`,
    )
    return stdout.trim()
  } else {
    const { stdout } = await promisify(exec)(`'${chromePath}' --version`)
    return stdout.substring(stdout.trim().lastIndexOf(' ') + 1).trim()
  }
}

export const getLatestChromeDriverVersion = async (chromeVersion: string) => {
  // See https://stackoverflow.com/a/55266105/1980909

  const url =
    'https://googlechromelabs.github.io/chrome-for-testing/LATEST_RELEASE_' +
    chromeVersion.replace(/\.\d+$/, '')

  return await fetch(url)
    .then((r) => r.text())
    .then((t) => t.trim())
}

export const installChromeDriver = async (
  chromeDriverVersion: string,
  targetDir?: string,
  adminPrompt = true,
) => {
  if (!targetDir) targetDir = dirname(await getEnvPathChromePath())
  let folder
  let zipname: string
  if (isWin) {
    folder = 'win64'
    zipname = 'chromedriver-win64'
  } else if (isMac) {
    folder = 'arm64' === process.arch ? 'mac-arm64' : 'mac-x64'
    zipname = 'chromedriver-' + folder
  } else {
    folder = 'linux64'
    zipname = 'chromedriver-linux64'
  }

  const url = `https://storage.googleapis.com/chrome-for-testing-public/${chromeDriverVersion}/${folder}/${zipname}.zip`

  await withTmpDir(
    async (unzipDir) => {
      console.log(`Unzipping ${url} to ${unzipDir.path}`)
      await new Promise((resolve, reject) => {
        const extract = Extract({ path: unzipDir.path })
        extract.on('close', resolve)
        extract.on('error', reject)
        httpsGet(url, (res) => {
          console.log(res)
          res.pipe(extract)
        })
      })

      let chromedriver = 'chromedriver'
      if (isWin) {
        chromedriver += '.exe'
      }
      console.log(`Copying ${chromedriver} to ${targetDir}`)
      const sourcePath = join(unzipDir.path, zipname, chromedriver)
      const targetPath = join(targetDir!, chromedriver)
      fsp.chmod(sourcePath, 0o755)

      if (adminPrompt) {
        await new Promise<void>((resolve, reject) => {
          sudo.exec(
            `move /Y ${JSON.stringify(sourcePath)} ${JSON.stringify(targetPath)}`,
            { name: 'Copy Chromedriver' },
            (error) => (error ? reject(error) : resolve()),
          )
        })
      } else {
        await fsp.copyFile(sourcePath, targetPath)
      }
    },
    { prefix: 'chromedriver', unsafeCleanup: true },
  )
}
export const getChromeDriverVersion = async (chromeDriverPath = 'chromedriver') => {
  let chromedriverVersionCommand
  if (isWin) {
    chromedriverVersionCommand = `${chromeDriverPath} --version`
  } else {
    chromedriverVersionCommand = `'${chromeDriverPath}' --version`
  }
  const { stdout } = await promisify(exec)(chromedriverVersionCommand)
  return stdout
    .trim()
    .replace(/^ChromeDriver\s*/, '')
    .replace(/\s.*/, '')
}

export const getNonEnvPathChromePath = async () => {
  const winChrome = join('Google', 'Chrome', 'Application', 'chrome.exe')
  const candidates = isWin
    ? [
        process.env['PROGRAMFILES'] ?? 'C:\\Program Files',
        process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)',
        process.env['LOCALAPPDATA'],
      ]
        .filter((dir): dir is string => !!dir)
        .map((dir) => join(dir, winChrome))
    : ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  for (const path of candidates) {
    if (await fileExists(path)) {
      return path
    }
  }
  return undefined
}

const compareVersions = (a: string, b: string) => {
  const pa = a.split('.').map((x) => parseInt(x) || 0)
  const pb = b.split('.').map((x) => parseInt(x) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * Checks a configured chrome path after an update of zedd. Returns the installed Chrome instead,
 * if the configured one no longer exists, is a Chrome downloaded by puppeteer, or is older than
 * the installed one. A configured path to an up-to-date Chrome is kept.
 */
export const migrateChromePath = async (chromePath: string): Promise<string> => {
  if (!chromePath) {
    return chromePath
  }
  const installedChrome = await getNonEnvPathChromePath()
  if (!(await fileExists(chromePath)) || /[\\/]\.cache[\\/]puppeteer[\\/]/.test(chromePath)) {
    return installedChrome ?? ''
  }
  if (!installedChrome || installedChrome === chromePath) {
    return chromePath
  }
  try {
    const [configuredVersion, installedVersion] = await Promise.all([
      getChromeVersion(chromePath),
      getChromeVersion(installedChrome),
    ])
    return compareVersions(configuredVersion, installedVersion) < 0 ? installedChrome : chromePath
  } catch (e) {
    console.error('Could not compare chrome versions', e)
    return installedChrome
  }
}
