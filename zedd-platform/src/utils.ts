import { ElementHandle } from 'puppeteer'
import { InvalidPlattformUrlException } from './exception'

export function checkPlatformUrl(urlToCheck: string): void {
  try {
    const url = new URL(urlToCheck)

    if (!url.hostname || !url.pathname) {
      throw new Error()
    }
  } catch {
    throw new InvalidPlattformUrlException(urlToCheck)
  }
}

export async function clearInput(input: ElementHandle<any> | null) {
  await input?.click({ count: 3 })
  await input?.press('Backspace')
}
